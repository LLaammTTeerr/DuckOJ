# F-45 — The scoreboard's cold fold: statement 34 does not run any more

**Status**: done. The fold's case read is **gone**, not optimised. Migration
0045, decisions **D165** and **D166**. Nothing pushed; nothing written to the
live database.

The headline is one line of the F-44 table:

| F-44 statement 34 | before | after |
| --- | --- | --- |
| every subtask case of every submission | 16 050 buffers, 4.7 MB temp, 169 ms, 240 000 rows to Node | **the statement does not run** |

---

## What the slot found, in order

F-44 said the fix was "subtask points summarised per submission rather than
re-derived from every case row", and offered three ways to do it. **Both of the
first two were built and measured.** The read-time one is a regression; the
write-time one removes the statement entirely. That negative result is half of
this slot's value and it is D166.

### 1. The formats never wanted case rows (`d165` foundation)

Nothing in `@duckoj/contest-formats` ever read an individual case.
`aggregateCases` reduced them per batch behind `contestSubmissionPoints`;
`ioi16`'s `get_best_subtask_point` reduced them per batch too. Both reductions
factor through one per-group record — `min(points)`, `max(total)`, and the loose
group's running sums. `packages/contest-formats/src/subtasks.ts` is that record
and the two reductions over it; `lower()` and `ioi16` read it and nothing else.

This is what makes everything below possible, and it is proved before anything
is built on it.

### 2. Read-time summarisation — built, measured, **refused** (D166)

One `GROUP BY (submission_id, attempt, group_index)`, one row per group instead
of one per case, no bind list, no second scan for `max(attempt)`. Correct — its
numbers were verified against `summariseCases` on 50 000+ generated groups — and
**slower than what it replaced**.

The reason is structural. Bit-identity requires `sum(points ORDER BY id)`, since
`points` is `double precision` and the fold accumulates the loose group with `+`
in `submission_cases.id` order — and an unordered `sum` is not merely a different
order but a non-deterministic one, because a parallel aggregate combines partials
in worker-completion order. An `ORDER BY` inside an aggregate sets
`numOrderedAggs > 0`, which disables **hash aggregation and parallel aggregation
both**. Every variant collapses to a `GroupAggregate` over a full sort.

Eight variants, all on the province round below:

| # | Variant | Plan | Buffers | Temp | Time |
| --- | --- | --- | --- | --- | --- |
| V0 | **before** | `Gather Merge` / 2 workers | 17 650 | 4.5 MB | **163 ms** |
| V1 | ordered sums + `ORDER BY min(id)` | → **`Index Scan`** | **334 641** | — | 253 ms |
| V2 | ordered sums, no outer order | → `Index Scan` | 334 641 | — | 228 ms |
| V3 | plain sums (not bit-identical) | `HashAggregate` → `Seq Scan` | 4 547 | 1.6 MB | 184 ms |
| V4 | ordered sums, `enable_indexscan = off` | `GroupAggregate` → `Sort` | 4 550 | 14.7 MB | 228 ms |
| V5 | ordered sums over a projected subquery | → `Index Scan` | 334 641 | — | 227 ms |
| V6 | ordered sums under a `MATERIALIZED` CTE | seq scan, then sort | 4 553 | 14.7 MB | **308 ms** |
| V7 | as V6, pre-sorted in the CTE | index scan **and** sort | 334 641 | 14.7 MB | 352 ms |
| V8 | plain sums, hash aggregate — the ceiling | `HashAggregate` → `Seq Scan` | 4 547 | 1.6 MB | 186 ms |

The planner's own choice (V1/V2/V5) is a **19× regression in buffers**: given an
ordered aggregate it prefers an index scan for its presorted keys — 326 000
random heap fetches where the old plan was sequential. Fenced onto the seq scan
(V4/V6) the buffers do drop 4×, and it is still 228–308 ms single-threaded
against 163 ms across three workers, with a bigger spill — and it needs a
planner hint in production code.

`a32a9a4` in this branch shipped that design before it was measured at scale.
It is left in history and superseded by `2c76cc0`; D166 says so.

### 3. Write-time summarisation — shipped (D165)

The judge already knows a submission's per-group points the moment it finishes.
`EventWriter.writeTerminal` — the only place grading ends, for all four terminal
events — now writes `submissions.subtask_summary` in **the same fenced UPDATE
that writes the verdict**, from the attempt's own case rows read in the same
transaction, using `summariseCases`.

The brief asked what that costs in schema, in rejudge, in recompute and in D29's
fencing. Answered in place:

- **Schema**: one `jsonb` column, migration 0045, plus a backfill. No table, no
  index, no wire change.
- **D29's fencing**: nothing. It is inherited, because the write rides an UPDATE
  that is already fenced — a superseded attempt matches no row and so can set
  neither a verdict nor a summary.
- **Rejudge**: one line. `requeueAll` already nulls verdict, points, timings and
  `judged_at` in one statement three lines above its `DELETE` of the case rows;
  the summary is nulled there too.
- **Recompute / disqualification**: nothing. Disqualifying writes
  `contest_participations` and changes no verdict.
- **The drift hazard**: this is state that is **replaced** from its own source in
  one statement, not **incremented**. The prior-art defect (silent counter drift
  in the rejudge path, fixed with `FOR UPDATE`) is a different hazard class.

**And the summary is never the only answer.** It is trusted only while a
submission is `done` or `errored`; anything in flight falls back to the old
per-case read, bound to the ids actually grading rather than to every submission
the contest ever took. Every fold of a live contest runs that path, so it cannot
rot — and it is what makes this an optimisation rather than a second source of
truth.

### 4. Narrow the read — subsumed

F-44's third option ("can the fold stop reading case rows at all?") is what D165
achieves, by a different route: the answer is yes, but only because something
else read them earlier.

---

## The plans

Captured from drizzle's own logger while the real `ContestAccessService` folded
a real board — `progress-plan.spec.ts`'s harness — and `EXPLAIN (ANALYZE,
BUFFERS)`ed verbatim with their bind values. The **before** statement is a
literal in `apps/api/test/contest-scoreboard-fold-plan.spec.ts`; it is the only
place it still exists, and it is `EXPLAIN`ed on the same rows in the same
connection as the after, every run.

### Before — statement 34

```
Gather Merge (actual time=131.063..160.564 rows=240000 loops=1)
  Workers Planned: 2   Workers Launched: 2
  Buffers: shared hit=16050, temp read=1589 written=1593
  ->  Sort (rows=80000 loops=3)
        Sort Key: submission_cases.id
        Sort Method: external merge  Disk: 4680kB
        ->  Hash Join (rows=80000 loops=3)
              Hash Cond: (submission_id = ... AND attempt = max(attempt))
              ->  Parallel Seq Scan on submission_cases (rows=100000 loops=3)
                    Filter: submission_id = ANY ('{1,2,3, ... 16000 ids}')
              ->  Hash -> HashAggregate (rows=16000 loops=3)
                    ->  Seq Scan on submission_cases (rows=300000 loops=3)
                          Filter: submission_id = ANY ('{... the same 16000 ...}')
Execution Time: 168.840 ms
```

### After — statement 34 is absent, and statement 33 carries the summary

```
Hash Join (actual time=3.891..15.508 rows=16000 loops=1)
  Buffers: shared hit=1838
  ->  ... Seq Scan on submissions (rows=16000)          Buffers: 1701
      ... Seq Scan on contest_submissions (rows=16000)  Buffers: 118
      ... Seq Scan on contest_participations (rows=2000, contest_id = 1)
      ... contest_problems (8), problems (9)
Execution Time: 16.309 ms
```

The spec asserts the fold emits **no statement mentioning `submission_cases`**
for a contest whose submissions have finished grading. It is not a cheaper read;
there is no read.

### What the summary costs the read it rides

The same captured statement with the column stripped out, planned on the same
rows:

| statement 33 | Buffers | Temp | Time |
| --- | --- | --- | --- |
| with `subtask_summary` | 1 838 | none | 16.3 ms |
| without it | 1 838 | none | 15.2 ms |

**1.1 ms and no extra buffers.** That figure took one correction to earn. The
first version of this change left `ORDER BY contest_submissions.id` in SQL, and
the wider rows pushed its sort out of `work_mem`: 15 ms and an in-memory
quicksort became **40 ms and a 9 960 kB external merge**. The order is
load-bearing — it is `groupByProblem`'s first-seen order, which `ioi16` sums in
— so it moved into JavaScript, where 16 000 rows on a `bigserial` key cost
nothing. The spec now asserts neither form sorts in the database.

### Net, per cold fold, at province scale

| | before | after |
| --- | --- | --- |
| database time for the case data | 169 ms (3 workers, ≈490 ms CPU) | 1.1 ms |
| buffers | 16 050 | 0 |
| temp spilled | 4.7 MB | none |
| rows crossing into Node | 240 000 | 0 |
| statement text | linear in the contest's submissions | constant |

F-44 costed the old fold at **≈0.3 s of CPU per wall-clock second, a third of
one core of sixteen, continuously, for one province round.** On these figures
that is gone.

---

## The equality proof

Four independent layers, because the brief is right that a faster scoreboard
which is wrong is strictly worse than a slow one that is right (D36).

**1. A property test over the two reductions, against literal oracles.**
`packages/contest-formats/test/subtask-summary.spec.ts` keeps `aggregateCases`
and `bestSubtaskPoints` *as they stood at `d72441e`* and compares 400 generated
case lists with `Object.is`.

**This proof had to be rewritten, and that is the most useful thing in the
slot.** Its first version compared only the rounded output. `pyRound(_, 1)`
erases any discrepancy below 0.05, so it **passed** a deliberately wrong
implementation that folded the batches in ahead of the loose cases — a
reassociated sum, and therefore a different scoreboard. Mutation battery:

| mutation | first version | current |
| --- | --- | --- |
| A — batches folded in before the loose group | **passed** | 2 failed |
| B — a batch takes `max(points)` instead of `min` | 2 failed | 2 failed |
| C — `Math.max(seen ?? 0, x)` for an absent batch | passed | passed |
| D — groups in ascending order, not first-seen | 2 failed | 2 failed |
| E — a batch is out of `sum(total)`, not `max(total)` | 1 failed | 1 failed |

Two changes fixed A: the comparison moved to the accumulation **before**
rounding (`accumulateSubtasks` is split from `aggregateSubtasks` for exactly
this), and the generator now emits fractional points across **eleven orders of
magnitude**, because a generator confined to one magnitude cannot see an
addition performed out of order at all.

C survives and is reported rather than papered over: with non-negative points
`Math.max(seen ?? 0, x)` and `seen === undefined ? x : Math.max(seen, x)` agree
on every input, so it is an equivalent mutant, not a hole. The property it was
meant to guard — an absent batch stays absent — is asserted where it is real, on
the summariser, which emits no row for a group with no cases.

**2. The stored summary against the summariser, on real rows.**
`apps/judged/test/event-writer.spec.ts` drives the real `EventWriter` through
real case-result events and compares `submissions.subtask_summary` to
`summariseCases` field by field with `Object.is`, on points chosen so the loose
sum is order-sensitive (`1e-4 + 1e-4 + 2**40 !== 2**40 + 1e-4 + 1e-4`, asserted
in the test). Plus: a compile error summarises to `[]` and never null; a second
attempt beside a first summarises to the second.

**2b. The jsonb seam itself, from both sides.** A summary that survives every
arithmetic check and loses a bit crossing into Postgres is still a wrong
scoreboard, so the boundary is asserted rather than assumed. On the write side,
`event-writer.spec.ts` compares against **Postgres' own rendering** of the
stored value (`subtask_summary::text`, parsed back), not against what the
writing client handed back. On the read side, the fold spec pulls every
backfilled summary over a **fresh connection** and through
`readSubtaskSummary` — the fold's own validator — because a validator that
refused some stored shape would send the whole deployment down the residue path
forever, which is a performance regression no equality assertion would notice.
Red demonstrated: making the validator refuse everything reds it
(`submission 1: the fold refused its own summary`).

**3. Migration 0045's backfill against the summariser, at province scale.**
`apps/api/test/contest-scoreboard-fold-plan.spec.ts` reads the backfill **out of
the migration file** — a transcription would drift, and a drifted copy would
certify SQL nobody runs — runs it on ~16 000 generated submissions, and compares
**50 000+ groups** with `Object.is`. This is also what certifies the one place
`sum(... ORDER BY id)` is still used: it is exactly right run once.

**4. All 23 golden replays, through Postgres, across every format.**
`contest-golden-replay.spec.ts` computes each golden's board through the real
service and against `computeContestScoreboard` on the raw fixture input —
`default`, `icpc`, `ioi` (legacy) and `ioi16`, byte-identical. The golden
fixture now seeds summaries the way the judge writes them, so the replays
exercise the **stored** path; `contest-regrade-attempt.spec.ts` clears them,
which is what a regrade actually looks like, and so keeps covering the residue
read's own `max(attempt)` filter.

### The freeze still masks

`apps/api/test/contest-freeze.spec.ts` — 10 passed, unchanged. The freeze was never in
the SQL: F-44 established that the public and privileged folds emit
**byte-identical statements** and that D22's masking lives in the JavaScript
fold with D25's freeze phase only in the cache key. This slot changed what the
fold reads, not the fold, so masked and unmasked continue to agree everywhere
they should and differ everywhere they must, over HTTP and through the service.

### The residue cannot serve a stale board

The fold spec poisons one submission's stored summary with **999 points** and
puts it back to `grading`. 999 points would have moved a row; the board does not
move, the residue statement is emitted, and its bind list contains exactly one
id — not sixteen thousand.

---

## Verification

Every test demonstrated **red** first.

| Suite | Result |
| --- | --- |
| `packages/contest-formats` (goldens, divergences, freeze, lower, subtask-summary) | **125 passed** |
| `apps/judged/test/event-writer.spec.ts` | **16 passed** |
| `apps/api/test/contest-scoreboard-fold-plan.spec.ts` (container, run alone) | **1 passed** |

`1 passed` on the centrepiece is one `it` carrying five assertion groups —
backfill equality over 50 000+ groups, the jsonb round trip through a fresh
connection and the fold's own validator, the "no `submission_cases` statement at
all" claim, the cost of the summary column measured against the same statement
without it, and the poisoned-summary residue check. They share one `it` because
they share one fixture: building a 300 000-row province round is itself hot
work, and the brief's thermal cap says to do it once and reuse it. Splitting
them would seed it five times to raise a number.

| `apps/api/test/contest-golden-replay.spec.ts` | **24 passed** |
| `apps/api/test/contest-freeze.spec.ts` | **10 passed** |
| `apps/api/test/contest-regrade-attempt.spec.ts` | **2 passed** |
| `apps/api/test/rejudge.spec.ts` | **8 passed** |
| `apps/api/test/contest-disqualify.spec.ts` | **9 passed** |
| `apps/api/test/contest-results.spec.ts` | **47 passed** |
| `apps/api/test/contest-scoreboard-cache.spec.ts` | **4 passed** |
| `packages/db/test/migration-journal.spec.ts` (D133's drift guard, 0045 in the journal) | **7 passed** |

**253 passed.** `typecheck` and `lint` clean for `@duckoj/contest-formats`,
`@duckoj/db`, `@duckoj/api` and `@duckoj/judged`.

Reds demonstrated, in order:

- `subtasks.js` absent → the property spec fails to load.
- The property spec's own first version passed mutation A; it was rewritten
  until A reds. The whole battery is in the table above.
- `subtaskSummary` removed from `writeTerminal`'s UPDATE → all three new judged
  tests red (`expected null not to be null`, `expected null to deeply equal []`,
  `expected null to deeply equal [ { batch: +0, minPoints: 20, … } ]`).
- The read-time `GROUP BY` fold red the plan spec's after-shape assertions —
  which is how D166's refusal was found rather than assumed.
- `contest-regrade-attempt.spec.ts` red (`expected ['alice', 200] to deeply
  equal ['alice', 100]`) the moment the golden fixture began seeding summaries:
  the fixture was inserting a second attempt's case rows without going through
  any writer, a state production cannot reach. That red is a real finding about
  where the latest-attempt rule now lives, and the fixture was corrected to
  model the regrade it claims to model.

---

## The databases

- **`duckoj`, live, read-only.** Nothing was written. Migration 0045 is
  committed and **not applied**; only the controller deploys. No container was
  started, stopped or rebuilt; `apps/web/dist` was not touched; nothing under
  `.secrets/` was read, printed or committed.
- **`f45_scratch`, created and dropped.** Same cluster, a bare schema holding
  `submission_cases`, `contest_submissions` and `contest_participations` only —
  enough to plan statement 34 against — grown to 330 000 case rows / 17 600
  contest submissions / 2 200 participations, with 2 000 of them in one round
  and a regraded quarter carrying a second attempt. `VACUUM (ANALYZE)` before
  every measurement. This is where D166's V0–V8 table comes from. Dropped.
- **The spec's own container.** The province round the before/after plans come
  from is seeded by the spec itself — 2 000 pupils × 8 problems, ~16 000 contest
  submissions, ~300 000 case rows, case points fractional and spread across
  magnitudes so that an out-of-order sum is visible. Committed rather than
  rolled back, because `VACUUM (ANALYZE)` cannot run in a transaction and an
  un-vacuumed synthetic table measures the seeding.

Timings are from a thermally-capped 16-core host and are **not** capacity
figures. Every command ran under `nice -n 19`; every container-backed spec ran
alone with `--no-file-parallelism`; no load test was run.

---

## What is not done

- **`contestWindowOpenWhere`** — F-44's other open item, D49's anti-join, named
  in D163/D164 and in `PROVINCE-READINESS.md` gap 3. Explicitly out of scope and
  not started.
- **Migration 0045 is not applied to production.** Its backfill is a full pass
  over `submission_cases` with the ordered aggregate D166 refuses per fold —
  milliseconds on the live 881 submissions, about a minute on a province's
  second season, and it should be run outside a contest window as 0044's
  `CREATE INDEX` should.
- **`load/RESULTS.md` is not refreshed.** No load test was run; the brief forbade
  it. Its scoreboard p95 figures were taken pre-D25 and are unaffected by this
  slot, but they now also predate the fold this slot removed, so they remain
  stale in the direction of pessimism for the cold path and optimism for
  everything F-44 already listed.
- **Nothing is pushed.** Five commits on `main` in this clone.

## Commits

| | |
| --- | --- |
| `ebbddc1` | `refactor(contest-formats): a submission's cases reduce to one row per group` |
| `a32a9a4` | `perf(api): the cold scoreboard fold groups in Postgres, not in Node` — the read-time design, later measured and superseded; kept, per D166 |
| `6b27599` | `feat(db): a submission remembers what its cases came to (migration 0045)` |
| `77962fd` | `feat(judged): the verdict and the subtask summary are one write` |
| `2c76cc0` | `perf(api): statement 34 is gone, not faster (D165, D166)` |
