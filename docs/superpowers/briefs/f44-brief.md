# F-44 — The queries a province will actually run, measured

## Why this slot

`docs/PROVINCE-READINESS.md` gap 3 has stood since 29 August:

> `/users/me/progress` runs seven aggregates per cold miss, cached per user,
> **unmeasured at province size**, and the heatmap's day is not sargable
> (D83).

"Unmeasured" is the operative word. The load figures in `load/RESULTS.md` are
dated 30 August; since then the system has gained five languages, per-language
limit joins on the problem read, optimistic-concurrency reads on two saves,
new monitor invalidation, and migration 0043. Nobody has looked at a query
plan since.

A province is ~2000 pupils on one 16-core host. The failure mode is not an
error — it is the site becoming slow on contest morning, when nobody has time
to debug it.

## The method, and why it is not a load test

**Do not run a 2000-VU k6 profile.** This host reached 93 °C today building
two container images, and a full load run is what stopped this campaign once
before. It is also the wrong tool for the question: a load test tells you the
site got slow, and a query plan tells you why.

Measure with `EXPLAIN (ANALYZE, BUFFERS)` against the **live database**,
read-only, through `podman exec duckoj_postgres_1 psql -U duckoj -d duckoj`.
It carries 431 users, 154 contests, 59 problems and 856 submissions — small,
so a sequential scan will look fast and mean nothing. Judge by **plan shape,
not milliseconds**: a `Seq Scan` on a table that grows with pupils or
submissions is the finding, whether or not it is quick today. Where the shape
is ambiguous, populate a scratch table or use `EXPLAIN` with a hypothetical
row estimate — do not write to the live tables.

## Scope

### 1. `/users/me/progress` (D83)

Seven aggregates per cold miss. For each one: its plan, whether it scans,
what index would serve it, and whether the aggregate is needed at all at
that granularity. The heatmap's day predicate is explicitly not sargable —
that is a stated, known defect; fix it, and prove the plan changed.

Consider the cache too: per-user caching means 2000 cold misses at 07:00 when
everyone opens the site at once, which is the worst possible arrival pattern
for an expensive uncached query. Whether that needs anything is your call —
argue it.

### 2. The paths every pupil hits on contest morning

The problem list, the problem read (now carrying per-language limits), the
submissions list, the scoreboard, and the signed-in home (D138/D151). These
are the routes 2000 people load repeatedly within a few minutes. Same
treatment: plan, shape, verdict.

The scoreboard already has a Redis cache (D25) — check what happens on the
miss, and whether a freeze (D22/D23) changes the plan.

### 3. Fix what the plans indict

Add the indexes the evidence justifies, in a migration (**next number is
0044** — check the journal; D133 exists because 0025 was skipped forever).
An index is not free: say what each one costs on write, and do not add one
the plans do not demand.

Rewrite the queries whose shape is wrong. A query that cannot use an index
because of how a predicate is written is a better fix than an index that
works around it.

## What honest output looks like

A table: route → query → plan shape before → change made → plan shape after.
**A route you measured and found healthy is a result** — record it, because
"we looked at the scoreboard's plan and it uses the index" is exactly what a
province operator needs to read.

Do not claim a speed-up you did not measure. On 856 submissions, a plan change
that matters at 200,000 rows may show no time difference at all — say that
plainly rather than quoting a meaningless percentage.

## How you work

**The live stack is production**, deployed at `6089829`, CI green, six
containers healthy.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`. Only the controller deploys.
- **Never** write to `apps/web/dist`. **Do not run the web build.**
- The live database is **read-only to you**: `SELECT` and `EXPLAIN` only. No
  `CREATE INDEX` against it by hand — the index ships as a migration and the
  controller deploys it. If you need to prove a plan on a large table, build
  it in a scratch database you create and drop, never in `duckoj`.
- **Never** read, print or commit anything from `.secrets/`.

**Thermal caps — tightened today after a 93 °C reading:**
- Every command under `nice -n 19`.
- **No load test, no k6, no container-backed spec suite run wholesale.**
- Vitest `--no-file-parallelism`, only the specs you touch.
- If you must run a container-backed spec, run it alone and say so.

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.

**Tests**: a query fix needs a test that would catch its regression — an
assertion on the plan, or on the SQL the ORM emits. Demonstrate it red.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D163** is yours; **D164** and **D165** after it. Do not go
past D165, do not renumber.

## Report

Write `docs/superpowers/briefs/f44-report.md` with the plan table. Return only:
status, commits, the real `N passed` line, the routes you measured and their
verdicts, and what you could not finish.
