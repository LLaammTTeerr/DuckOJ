# F-45 — The scoreboard's cold fold, which is the province-scale hazard

## Why this slot

F-44 measured six routes against real query plans and found five of them
healthy or merely worth watching. It found **one** real hazard, and it is on
the single most load-bearing route this system has. Read
`docs/superpowers/briefs/f44-report.md` first — statement 34 and D163/D164
are the whole context.

> **Statement 34 is the one real hazard**: the cold fold reads every subtask
> case row of the contest (146 ms, temp spill, bind list linear in
> submissions). Seq scan is optimal there — **the query is the finding.**

That last sentence is why this is a slot and not an index. There is nothing
to add to the schema; the shape of the work is wrong.

**Why it matters more than its milliseconds suggest.** The scoreboard is what
2000 pupils refresh on contest morning. D25's Redis cache absorbs the steady
state, but a cache has cold misses — at the start of a round, after a
recompute, after a rejudge, after an api restart, and on every distinct freeze
view. Each miss pays the full fold, the fold spills to temp, and its cost
grows linearly with submissions in the contest. The moment it stops fitting
inside the cache's refill window, the misses stack.

## Scope

Make the cold fold cheap enough that a miss is unremarkable.

F-44's own suggestion is the obvious direction — **subtask points summarised
per submission rather than re-derived from every case row** — but it is a
suggestion, not a design. Weigh at least these, and say why you rejected the
ones you rejected:

- Summarise at write time: the judge already knows a submission's per-subtask
  points when it finishes. Storing what is currently recomputed turns the
  fold into a read. What does that cost in schema, in rejudge, in recompute,
  and in D29's attempt fencing?
- Summarise at fold time but once: a materialised per-submission roll-up the
  fold reads instead of case rows.
- Narrow the read: if the fold only needs points per (submission, subtask),
  establish whether it can stop reading case rows at all.

Whichever you choose, these are constraints, not suggestions:

- **The number on the board must not change.** This is a refactor of how a
  score is computed, on a system where a wrong scoreboard has already bricked
  a contest once (D36). Prove equality against the existing implementation on
  real data, across every format — ICPC, IOI, IOI-2016, legacy-IOI, default.
  A property test over generated contests is a better proof here than
  examples, because the formats differ in exactly the places a summary is
  tempting to get wrong.
- **The freeze must still mask.** D22/D23 put per-viewer masking on every
  route. F-44 established that the freeze lives in the JS fold and the D25
  cache key, not in the SQL — so a fold you rewrite is a fold that carries
  masking, and getting it wrong leaks a frozen standing. Test the masked and
  unmasked folds agree everywhere they should and differ everywhere they must.
- **Rejudge and recompute must stay correct.** There is prior art here: silent
  counter drift in the rejudge path was a real defect fixed with `FOR UPDATE`.
  Whatever you store must be maintained by every path that changes a verdict.

## Measure it

The plan is the deliverable, same as F-44. Capture the statement drizzle
actually emits, `EXPLAIN (ANALYZE, BUFFERS)` it before and after, and report
the shape change. F-44 built a **200,880-submission scratch copy** to get
province-scale figures — read its report for how, and use the same approach.
Live database stays `SELECT`/`EXPLAIN` only; scratch databases are created
and dropped by you.

If the redesign turns out not to help, that is a valid and valuable result —
report the measurement and say so, rather than shipping a rewrite that only
looks better.

## Out of scope

`contestWindowOpenWhere` (F-44's other open item, D49's anti-join). It is
real, it is named in D163/D164, and it is a different problem. Do not start it.

## How you work

**The live stack is production**, deployed at `d72441e`, six containers
healthy, migration 0044 applied.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`. Only the controller deploys.
- **Never** write to `apps/web/dist`. **Do not run the web build.**
- Live database is **read-only**: `SELECT`/`EXPLAIN`. Scratch databases are
  yours to create and drop; clean them up.
- **Never** read, print or commit anything from `.secrets/`.
- **Next migration is 0045** — check the journal first (D133 exists because
  0025 was skipped forever).

**Thermal caps — tightened after a 93 °C reading today:**
- Every command under `nice -n 19`. **No load test, no k6.**
- Vitest `--no-file-parallelism`, only the specs you touch.
- A container-backed spec runs **alone**, never beside another suite. Building
  a 200k-row scratch database is itself hot work — do it once, reuse it, and
  do not run a suite while it builds.

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.

**Tests**: every test demonstrated **red** first, failure output in the report.
The equality proof is the centrepiece — make it hard to fool.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D165** is yours; **D166** and **D167** after it. Do not go
past D167, do not renumber.

## Report

Write `docs/superpowers/briefs/f45-report.md` with before/after plans and the
equality evidence. Return only: status, commits, the real `N passed` line, the
measured shape change, and what you could not finish.
