# F-54 — The predicate that grows with the season

**Status**: closed, with a correction to what was being closed. `ends_at` is a
column, the D49 window exclusion reads it, and its cost now tracks the contest
activity happening **now** instead of the contest activity there has ever been.
Migration **0048**, decision **D194**. Nothing pushed; nothing written to the
live database.

---

## The invariant, in one sentence

> A submission is excluded from D49's statistics exactly while the one
> participation it is attached to — at most one, because
> `contest_submissions.submission_id` is UNIQUE — still has its **own** window
> open at `now`, i.e. `now < participationEnd(participation, contest)`
> evaluated per participation as D22 requires, uniformly for every viewer
> including admins and the contest's creator, open-ended at the start and
> closed at the end.

Everything below is an argument about how Postgres is *told* that, and nothing
below changes it. That order is the point: D36 bricked a contest by answering a
slightly different question faster, and the two specs in "Verification" exist to
make "the rule is unchanged" a fact rather than a claim.

## How each statement was obtained

Not reconstructed by hand, F-44's rule.

**Before.** A harness ran **inside `duckoj_api_1`** (the deployed image at
`a9c83fc`, which predates this slot and can therefore only ever measure the
*before* state). It imported the compiled `ProblemAccessService`,
`ProgressService` and `ProblemSetAccessService` out of `/app/apps/api/dist`,
built them over a `createDb(…, { logger })` pointed at the scratch database,
gave them a cache whose store always misses — so every call is the **cold**
path — and drove the real route methods: `listVisible(actor, { limit: 20 })`,
`getStats`, `getVisible`, `ProgressService.myProgress` and
`ProblemSetAccessService.progress`. 42 statements captured with their bind
values; the twelve carrying D49's `EXISTS` are the ones below. Each was handed
**verbatim, parameters included** to `PREPARE` + `EXPLAIN (ANALYZE, BUFFERS)
EXECUTE` — prepared and executed rather than string-substituted, because
Postgres plans a parameterised statement and a literal one differently.

The harness read `DATABASE_URL` out of the container's own environment and
rewrote only the database name; nothing under `.secrets/` was read, printed or
committed, no container was started, stopped, restarted or rebuilt, and the
script has been deleted from the container.

**After.** The container cannot produce the after-statements — its image is
older than this slot's rewrite — so they come from
`apps/api/test/contest-window-plan.spec.ts`, which drives the same real
services through the same logged `createDb` inside its own testcontainer, and
they are `EXPLAIN`ed twice: once in that spec, against its own province, and
once on the 496 240-row scratch copy with **migration 0048's own SQL applied
verbatim** (the file split on `--> statement-breakpoint`, nothing retyped).

**Before and after on the same rows, in the same connection.** The plan spec
holds `contestWindowOpenWhere` **as it stood at `bf2023a`** as a literal, splices
it into the captured statement in place of the new predicate, and plans both.
That is F-45's model for statement 34, and it is the only form of before/after
that survives a machine being busy.

## The two databases

- **`duckoj`, live, read-only.** 476 users, 989 submissions, 84 problems, 201
  contests, 333 participations, 325 contest submissions, 9 312 case rows. Read
  for its size and its schema; every statement issued against it was a `SELECT`.
  Migration 0048 is committed and **not applied** — only the controller
  deploys.
- **`f54_scratch`, created and dropped.** Same cluster, schema `pg_dump -s`ed
  from `duckoj`, then grown in four stages to a province a school year deep:
  **2 500 users, 500 problems, 616 790 submissions, 31 contests, 62 030
  participations, 496 240 contest submissions**, of which one round of 2 000
  pupils × 8 problems is **in flight** and thirty are finished, plus thirty
  virtual attempts still inside their own window and therefore legitimately
  outliving their contest's `end_time`. `VACUUM (ANALYZE)` before every
  measurement.

Timings are from a thermally-capped 16-core host shared with another project
and are **not** a capacity figure. **The plan shape is the finding.**

---

## What "acceptable" means here, stated before the numbers

Every one of these statements sits behind a cache, so the figure that matters
is **cost per cache miss × misses per second**, not cost per request.

- The catalogue counters (`GET /problems`) are keyed **per problem**, 30 s
  (D49's amendment), and computed for a page's misses together. Two thousand
  pupils opening page one at 07:00 are one aggregate plus up to
  `API_WORKERS − 1` duplicates, not two thousand.
- The statistics (`GET /problems/{code}/stats`) are keyed per problem, 30 s.
- The progress bars are keyed **per user**, 60 s (D83) — the worst arrival
  pattern there is, because 2 000 pupils are 2 000 distinct keys and nothing
  coalesces.

The criterion this slot rules against, written down before the ladder was run:
**a statement on a public catalogue route stops being acceptable when its
database time for one cold page passes ≈50 ms**, because at that point it is
the most expensive statement on the most public route in the app, it is growing
with something the deployment cannot control, and the 30 s cache in front of it
has stopped being a safety margin and started being the only thing holding it
up. F-44 costed the whole progress page at ≈15.8 ms; 50 ms for twenty rows of a
catalogue is three times that for a page a pupil opens first.

## The ladder: where the old shape fails

One scratch database, grown in place, `VACUUM (ANALYZE)` at every stage, one
round of 2 000 pupils in flight throughout. Buffers are the plan's own total
(`shared hit`); "inner" is what the anti-join's inner side reads.

| lifetime contest submissions | 32 240 | 64 240 | 160 240 | 496 240 |
| --- | --- | --- | --- | --- |
| participations | 4 030 | 8 030 | 20 030 | 62 030 |
| finished rounds | 1 | 3 | 9 | 30 |
| **`GET /problems` counters** (page of 20) | 1 184 buf / **26.5 ms** | 1 725 / **38.7** | 2 531 / **51.9** | 6 499 / **66.3** |
| plan | Hash Right Anti Join, 3 seq scans | same | same | same |
| **`/problems/{code}/stats` totals** | 750 / 6.6 | 1 019 / 11.8 | 2 049 / 20.2 | **19 201** / 5.6 |
| plan | Hash Right Anti Join | same | same | **Nested Loop Anti Join** |
| **progress `difficultyBars`** | 360 / 7.1 | 641 / 11.3 | 2 470 / 2.8 | 3 734 / 7.0 |
| **progress `tagBars`** | 701 / 0.34 | 703 / 0.34 | 701 / 0.38 | 703 / 0.41 |
| **progress `streak`** | 43 / 0.43 | 39 / 0.45 | 43 / 0.38 | 43 / 0.47 |
| **`bestOneSide`** (homework grid) | 502 / 6.5 | 2 283 / 1.7 | 2 663 / 1.8 | 2 671 / 2.0 |

**The line is at about 160 000 lifetime contest submissions** — ten rounds of
2 000 pupils × 8 problems, which a province reaches in one term of weekly
rounds. That is where `GET /problems`'s counters pass 50 ms of database time
for one cold page, and the plan on either side of it is the *same* plan: a
`Hash Right Anti Join` whose inner side is a sequential scan of every contest
submission the deployment has ever taken, joined to every participation and
every contest. Nothing about that inner side is a function of the twenty
problems on the page. At 496 240 it is a `Parallel Seq Scan` over 206 767 rows
per worker and 3 649 buffers of the statement's 6 499.

### The correction to F-44, which is half of this slot's value

F-44 and D163 name **the Hash Anti Join** as the defect. It is, up to about a
hundred thousand contest submissions. Past that the planner **escapes it on
most of the five statements — and the escape is worse.**

| `/problems/{code}/stats`, one problem | plan | buffers | ms |
| --- | --- | --- | --- |
| 160 240 contest submissions | Hash Right Anti Join | 2 049 | 20.2 |
| 496 240 contest submissions | **Nested Loop Anti Join** | **19 201** | 5.6 |

The nested loop is three index descents — `contest_submissions_submission_idx`,
`contest_participations_pkey`, `contests_pkey` — **per row of the outer scan**,
so it costs ≈8.5 buffers for every submission the problem has ever had. It
reads 9× the pages of the hash it replaced and shows up *faster* only because a
293 MB scratch database is entirely in `shared_buffers`; on a province's real
working set those are 19 000 random reads. The planner did the right thing with
the numbers it had — it has no estimate for the `CASE`, so it prices the hash by
`DEFAULT_INEQ_SEL` and eventually finds the loop cheaper — and both branches
are O(something that is not this page).

**So the defect is not "a hash anti join". It is that the predicate gives the
planner no way to know that the set of open participations is tiny**, and
therefore no plan available to it is bounded by current activity. That is what
0048 changes, and it is why an index alone could not have.

---

## What was tried, and what the evidence refused

Four forms, all proved to select the **same 616 790 rows** on the scratch copy
before any of them was timed (`EXCEPT` both ways against the shipped predicate:
0 rows of difference, with 16 240 submissions genuinely excluded).

| | form | catalogue counters at 496 240 | verdict |
| --- | --- | --- | --- |
| V0 | shipped: `join contests`, `now < CASE` | 6 499 buf / 66.3 ms | the defect |
| V1 | **no schema change** — drive from `participation_id in (select … CASE …)` | 6 045 / 55.7 | **refused**: no change |
| V2 | `ends_at` column, same join shape | 5 022 / 50.1 | refused: the planner still scans `contest_submissions` |
| V3 | `ends_at` column, `IN (subquery)`, widened index | **7 362 / 27.6** | shipped |

**V1 is the important refusal.** It is the free fix — a rewrite with no
migration, no column and no trigger — and it does nothing, because the cost was
never the join order. Postgres has no selectivity for the `CASE`, prices the
open set at `DEFAULT_INEQ_SEL` (a third of 62 030 participations), and keeps the
sequential scan. Nothing that leaves the end instant as an expression over two
tables can be told otherwise.

**V2 shows what the widened index buys.** With `ends_at` but with
`contest_submissions_participation_idx` still `(participation_id)` alone, the
planner hashes the 2 030 open participations and **still parallel-seq-scans all
496 240 contest submissions** onto them: it prices two thousand index descents
that must visit the heap above one sequential read of a narrow table, and it is
right to. `(participation_id, submission_id)` makes that walk an `Index Only
Scan` with `Heap Fetches: 0`, and only then does the planner drive from the open
set.

**V3's buffers go UP while a round is in flight, and that is the honest shape
of it.** 2 030 open participations × 3 pages of btree descent is 6 146 buffers,
against 3 649 for a sequential read of every contest submission there is. The
trade is deliberate: the first number is bounded by the round happening now and
the second is not, and off-round the first collapses to one page while the
second does not move at all.

## Before and after, per statement

496 240 contest submissions. **Before** is the pre-0048 predicate; **after** is
what the rewritten services emit, captured from drizzle's logger in
`contest-window-plan.spec.ts` and re-`EXPLAIN`ed here. Both columns are from the
same database in the same session, with migration 0048's own SQL applied
verbatim. "Round in flight" is 2 000 pupils × 8 problems mid-contest; "nothing
open" is the same rows asked about an instant after every window has closed —
which is what a deployment looks like for most of a school year.

| statement (route) | before | after, round in flight | after, nothing open |
| --- | --- | --- | --- |
| `listCounts` — `GET /problems`, page of 20 (D49 amendment) | 6 227 buf / 61.8 ms | 7 362 / **27.6** | 1 189 / **26.3** |
| `detailCounts` — `GET /problems/{code}` | **19 201** / 6.7 | 6 653 / 6.5 | **480** / 1.6 |
| `statsTotals` — `/stats` totals | **19 201** / 9.6 | 6 653 / 6.1 | **480** / 1.3 |
| `statsVerdicts` — `/stats` histogram | 19 206 / 6.4 | 6 658 / 6.5 | 485 / 0.9 |
| `statsLanguages` — `/stats` languages | 19 203 / 6.7 | 6 658 / 9.0 | 485 / 1.0 |
| `statsFirstSolver` — `/stats` first solver | 4 847 / 2.4 | 4 047 / 2.9 | 526 / 1.1 |
| `statsFastest` — `/stats` ten fastest | 481 / 0.52 | 481 / 0.68 | 481 / 0.43 |
| `tagBars` — `/users/me/progress` | 721 / 0.42 | **141** / 0.17 | 141 / 0.16 |
| `difficultyBars` — `/users/me/progress` | 3 734 / 5.1 | 3 362 / 3.4 | **268** / 1.3 |
| `streak` — `/users/me/progress` | 43 / 0.56 | 31 / 0.31 | 31 / 0.06 |
| `problemsListPage` — the page's own rows (`meSolvedLateral`) | 1 601 / 12.4 | 1 583 / 12.5 | 1 522 / 12.4 |
| `bestOneSide` — the homework grid | 2 671 / 2.0 | 2 251 / 1.8 | 282 / 1.3 |

`bestOneSide`'s "after" is the only row not taken from a captured statement:
the dump harness does not drive `ProblemSetAccessService`, so its predicate was
spliced by hand into its own captured statement. That splice was then checked
against the shipped text character by character — identical apart from
whitespace — rather than assumed.

**The plan, before and after, for the statement the line was drawn on:**

```
before — GET /problems counters, 496 240 contest submissions
  Hash Right Anti Join
    ->  Hash Join
          ->  Parallel Seq Scan on contest_submissions   (rows=206 767 × 3)
          ->  Hash -> Hash Join
                     Join Filter: now < CASE WHEN virtual = -1 THEN ... END
                     ->  Parallel Seq Scan on contest_participations (36 488 × 3)
                     ->  Seq Scan on contests (31)
    ->  Parallel Hash -> Bitmap Heap Scan on submissions (the page's 20 problems)

after
  Hash Anti Join
    ->  Bitmap Heap Scan on submissions  (the page's 20 problems)
    ->  Hash -> Nested Loop  (rows=16 240)
                 ->  Index Scan using contest_participations_ends_at_idx
                       Index Cond: (ends_at > $2)          rows=2 030
                 ->  Index Only Scan using contest_submissions_participation_idx
                       Index Cond: (participation_id = ...)  Heap Fetches: 0
```

The inner side stopped being a function of the table's size and became a
function of the round in progress. With nothing in progress the `Index Scan`
returns **0 rows** and the `Nested Loop` never probes.

## The freeze's agreement test still tests what it names

`apps/api/test/submission-freeze.spec.ts`'s agreement test pins
`frozenSubmissionsWhere` against `isSubmissionFrozen`. **That predicate was not
touched**, and `participationEndsAtSql()` was not touched, so it emits the same
bytes it emitted at `bf2023a` and the test passes for exactly the reason it
passed before — not for a new one. This is stated rather than left implicit
because the brief asks for it, and because "the green test now tests something
else" is the failure the question is guarding against.

What the slot DID add is the agreement that was missing:
`contestWindowOpenWhere` never had a row-form twin, and now the instant it
reads has one — three forms compared in
`apps/api/test/participation-ends-at.spec.ts` (stored column,
`participationEndsAtSql()`'s own emitted SQL, `participationWindow`'s
TypeScript), over every participation shape and after a contest edit moves each
of `end_time`, `time_limit_seconds` and `start_time`.

## What migration 0048 locks, and for how long

Timed statement by statement on the 496 240-row copy, the way F-51 timed 0047.
Drizzle runs migrations in one transaction, so none of this is `CONCURRENTLY`
and every lock below is held until the transaction commits.

| statement | lock | time |
| --- | --- | --- |
| `DROP INDEX contest_submissions_participation_idx` | `ACCESS EXCLUSIVE` on `contest_submissions` | 1.7 ms |
| `ADD COLUMN ends_at … DEFAULT 'epoch' NOT NULL` | `ACCESS EXCLUSIVE` on `contest_participations`, **no table rewrite** (PG11+ fast default) | 1.3 ms |
| the backfill, 62 030 rows | row locks under the same transaction | **341.6 ms** |
| two functions + two triggers | `SHARE ROW EXCLUSIVE` on the two tables | 2.3 ms |
| `CREATE INDEX … (ends_at)` | `SHARE` on `contest_participations` | 33.2 ms |
| `CREATE INDEX … (participation_id, submission_id)` | `SHARE` on `contest_submissions` | **151.1 ms** |
| commit | | 3.0 ms |
| **total** | | **≈535 ms** |

On the live database (333 participations, 325 contest submissions) this is
milliseconds. On a province it is **half a second during which no submission can
be attached to a participation**, so it should be run outside a contest window —
the same advice 0044's `CREATE INDEX` and 0045's backfill carry. It is committed
and **not applied**; only the controller deploys.

## Verification

Every assertion below was demonstrated **red** first.

| Suite | Result |
| --- | --- |
| `apps/api` — the FULL package, `--no-file-parallelism` | **1287 passed** (153 files) |
| `packages/db` — the FULL package | **99 passed** (20 files) |
| `apps/judged` — the FULL package (its harness migrates too, so 0048's triggers fire in every one of its fixtures) | **148 passed** (19 files) |
| of those, `apps/api/test/contest-window-plan.spec.ts` (container, run alone) | 1 passed |
| of those, `apps/api/test/participation-ends-at.spec.ts` (container, run alone) | 3 passed |
| of those, `apps/api/test/submission-freeze.spec.ts` — the agreement test, untouched | included in the 1287 |
| of those, `packages/db/test/integrity-check-script.spec.ts` — 27 planted violations, two of them new | included in the 99 |
| of those, `packages/db/test/migration-journal.spec.ts` — D133's drift guard, 0048 in the journal | included in the 99 |

`typecheck` and `lint` clean for `@duckoj/db` and `@duckoj/api`.

Reds, in order:

- **Revert the predicate** to its pre-0048 form → `expected 'select "problems"…'
  not to match /"contests"\."time_limit_seconds"/`. The assertion is on the text
  drizzle built, not on a transcription of it.
- **Narrow the widened index** back to `(participation_id)` in the migration →
  `expected 'GroupAggregate…' to match /Index Only Scan using
  contest_submissions_…/`. This is the red that proves the second index column
  is load-bearing rather than tidy.
- **Give the trigger's `CASE` a wrong branch** (a virtual entrant handed the
  contest's end instead of their own window) → two of the three tests red, both
  the SQL comparison and the TypeScript one.
- **Drop the row trigger** → all three red, including the `'epoch'` assertion:
  every participation the fixture inserts carries the default.
- **Drop the contest-side trigger** → only the contest-edit test reds, which is
  the point of separating it: it is the half a reader would forget.

## What is NOT done

- **Migration 0048 is not applied to production.** Timed and costed above.
  0045's backfill is also still unapplied (F-45), and the two should go out in
  the same window.
- **`upcomingContests` still evaluates the `CASE`.** It is 30 buffers and
  healthy at province size (F-44 measured it, and this slot re-measured nothing
  to the contrary); `ends_at` would make it sargable and nothing asks for that.
  Named here so it is not rediscovered as a surprise.
- **`problemsListPage` is unchanged at 1 601 → 1 583 buffers**, and its
  `Seq Scan on contest_participations` (31 030 rows) is **not** D49's — it is
  `actingParticipationWhere`'s, D113's sanctioned predicate, whose `user_id = ?
  OR team_id IN (…)` disjunction F-44 already refused an index for. That refusal
  stands; this slot did not revisit it, and it is now the largest remaining
  contest-side scan on `GET /problems`.
- **`load/RESULTS.md` is not refreshed.** No load test was run; the brief
  forbade it.
- **Nothing is pushed.** Three commits on `main` in this clone.

## Hygiene

- The live database was read only: `SELECT` and `EXPLAIN`, no row written, no
  index created by hand, no migration applied. No container was started,
  stopped, restarted or rebuilt. `apps/web/dist` was not touched and the web
  build was not run. Nothing under `.secrets/` was read, printed or committed.
- `f54_scratch` was created and dropped. The capture harness and its output
  were deleted from `duckoj_api_1` and from `duckoj_postgres_1`.
- No process was left running; every command ran under `nice -n 19` and every
  container-backed spec alone with `--no-file-parallelism`.

## Commits

| | |
| --- | --- |
| `7ed0a90` | `feat(db): a participation remembers when its window closes (migration 0048)` |
| `9fe461c` | `perf(api): D49's window exclusion reads the contests that are open (D194)` |
| (this file) | `docs(D194): the predicate that grew with the season, and the two plans it grew into` |
