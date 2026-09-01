# F-44 — The queries a province will actually run, measured

**Status**: done. Two indexes shipped (migration 0044), one query rewritten,
six routes measured, four of them found healthy and recorded as such.
Decisions **D163** and **D164**. Nothing pushed; nothing written to the live
database.

---

## How each statement was obtained

Not reconstructed by hand. A harness ran **inside `duckoj_api_1`** (the
deployed image, commit `6089829`), built the real `ProgressService`,
`ProblemAccessService`, `SubmissionAccessService` and `ContestAccessService`
over a `createDb(…, { logger })`, drove the actual route methods with a
`ScoreboardCache` whose store always misses — so every call is the **cold**
path — and captured the SQL drizzle emitted together with its bind values.
Each captured statement was then handed **verbatim, parameters included** to
`EXPLAIN (ANALYZE, BUFFERS)` on the same connection. 41 statements, 0 EXPLAIN
failures.

The harness had to run inside the container because the deployed Postgres
publishes no host port — the same reason `scripts/integrity-check.ts` shells
out to `podman exec … psql`. It read `DATABASE_URL` from the container's own
environment; nothing under `.secrets/` was read, printed or committed. The
temporary script lived in the container's `/tmp` and has been deleted.

**Two databases.**

- **`duckoj`, live, read-only.** 446 users, 880 submissions, 74 problems, 163
  contests. Every statement here is `SELECT`/`EXPLAIN`; no index was created
  by hand, no row written.
- **`f44_scratch`, created and dropped.** Same cluster, schema `pg_dump`ed
  from `duckoj`, live data restored, then grown to a province: **2 446 users,
  200 880 submissions, 474 problems, 364 contests, 2 263 participations,
  16 252 contest submissions, 248 755 subtask case rows**, with one live
  2 000-pupil × 8-problem round mid-flight and a 30-minute freeze. `VACUUM
  (ANALYZE)` before every measurement — an un-vacuumed synthetic table
  measures the seeding, not the query. Dropped at the end of the slot.

Timings below are from `f44_scratch` on a thermally-capped 16-core host and
are **not** a capacity figure. **The plan shape is the finding**; the
milliseconds are there to rank the shapes against each other.

---

## The table

Buffers are `shared hit` for one cold execution.

### 1. `GET /users/me/progress` — seven aggregates (D83)

| # | Aggregate | Plan shape before | Change | Plan shape after | Buffers |
| --- | --- | --- | --- | --- | --- |
| 0 | `loadUser` | `Index Scan users_pkey` | — | unchanged | 3 |
| 1 | `tagBars` | `HashAggregate` over `submissions_user_problem_points_idx` bitmap, **anti-joined against a full hash of `contest_submissions ⋈ contest_participations ⋈ contests`** (3 seq scans) | none — see "not fixed" | unchanged | 278 (7.5 ms) |
| 2 | `difficultyBars` | same shape, same anti-join | none | unchanged | 263 (6.5 ms) |
| 3 | `heatmap` (own page) | Bitmap heap scan of the pupil's rows **+ a `problems` join with no predicate on it**, probing `problems_pkey` once per submission | **D164**: join dropped when it filters nothing; `submissions_user_created_idx` added | **`Index Only Scan using submissions_user_created_idx`, `Heap Fetches: 0`** | **305 → 10** |
| 4 | `streak` | Bitmap heap scan of the pupil's rows + nested-loop anti join on `contest_submissions_submission_idx` | none — argued below | unchanged | 352 |
| 5 | `recent` | Read **all** of the pupil's rows and top-N sort them; or, when strangers' rows are newer, `Index Scan Backward submissions_pkey` discarding 60 000 (1 074 buffers) | **D163**: `submissions_user_recent_idx (user_id, id DESC NULLS FIRST)` | `Index Scan using submissions_user_recent_idx`, no `Sort`, LIMIT stops after ten | **117 → 15** |
| 6 | `upcomingContests` | `Seq Scan contest_participations` — `user_id = ? OR team_id IN (…)` is not indexable | index tried, **refused** | unchanged | 30 |
| 7 | `homework` | `Seq Scan org_members` (110 rows) → `problem_sets_org_slug_lower_idx`; the two counters are `Index Only Scan submissions_problem_user_verdict_idx`, `Heap Fetches: 0` | none — **healthy** | unchanged | 2 |

Whole page, cold: **≈1 350 → ≈960 buffers, ≈15.8 ms of database time.**

**Is every aggregate needed at that granularity?** Yes, on the evidence.
`homework` and `upcomingContests` are already `LIMIT 20` and cost 32 buffers
between them. The bars are per-*problem*, not per-submission, which is what
keeps them at 278 buffers rather than at the size of the pupil's history. The
expensive part of the page is not its granularity, it is the D49 anti-join
below.

### 2. The contest-morning routes

| Route | Statements | Plan shape | Verdict |
| --- | --- | --- | --- |
| `GET /problems` (page of 20, signed in) | 4 | visibility probes 284 + 212 + 6 buffers; then D49's per-problem solver counts: `Bitmap Index Scan submissions_problem_user_verdict_idx` (the right index) anti-joined against the **full** contest-window hash | **7.9 ms, watch.** Behind `throughMany`'s per-problem 30 s cache, so a warm page costs none of it. The index is right; the anti-join is the cost |
| `GET /problems` (anonymous) | 3 | same, one fewer visibility probe | healthy |
| `GET /problems/{code}` (with D154 per-language limits) | 10 | nine statements ≤ 0.2 ms, all index-served; the tenth is the same D49 aggregate for one problem (650 buffers, 9.3 ms). The D154 limits join is `problem_language_limits ⋈ languages` — 2 buffers | **healthy except the shared anti-join.** The per-language limits added in D154 cost nothing measurable |
| `GET /submissions` (unfiltered, a pupil) | 1 | `Index Scan Backward submissions_pkey` + `visibleSubmissionsWhere`'s OR-of-hashed-subplans as a filter; early-terminates at the LIMIT | **8.7 ms / 1 261 buffers, watch.** Ordered index scan with early termination is the right shape; the cost is how far back the reader's own rows sit. Not indexable — the predicate is a disjunction with subplans |
| `GET /submissions?user=…` (D138 home panel) | 1 | index on `user_id` + top-N sort, then the link joins | 0.8 ms — **healthy**; D163's index also serves it |
| `GET /contests?phase=active&mine=true` (D138/D151 home panel) | 2 | `Seq Scan contests` (364 rows) + `Sort (start_time, id)`; `mine=true`'s org subquery is `contest_orgs_org_idx` | 0.4 ms — **healthy at province size.** An index on `end_time` was tried and refused: 364 rows, and the visibility `OR` cannot be pushed |
| `GET /contests/{key}/scoreboard`, cold fold | 6 | see below | **one real hazard** |

### 3. The scoreboard, in detail (D22/D23/D25)

| # | Statement | Plan | Buffers / ms |
| --- | --- | --- | --- |
| 29 | load the contest | `contests_key_lower_idx` | 3 |
| 30 | org gate | `contest_orgs` | 1 |
| 31 | contest problems | `Seq Scan contest_problems` (198) → `problem_revisions_pkey` | 53 / 0.15 |
| 32 | participations + users | `Seq Scan contest_participations` filtered to the contest | 68 / 1.3 |
| 33 | every submission of the contest | `Index Scan contest_submissions_submission_idx` merge-joined to `submissions_pkey` | 1 489 / **17.9 ms** |
| 34 | **every subtask case of every one of them** | `Parallel Seq Scan on submission_cases` with a `submission_id = ANY(16 252 ids)` list, twice, + external-merge sort spilling ~4.7 MB | 13 326 + 1 589 temp / **146 ms** |

**The freeze does not change the SQL.** The public and privileged folds emit
**byte-identical statements** (29–34 vs 35–40) with identical plans. D22's
freeze is applied in the JavaScript fold and D25's freeze phase only changes
the *cache key*. That is worth an operator knowing: freezing a contest costs
the database nothing.

**Statement 32's `Seq Scan` is correct, not a defect.** 2 000 of 2 263
participation rows *are* this contest, and no index beats a scan at that
selectivity. `contest_participations_identity_idx` leads with `contest_id`, so
once a province's table is a season deep and one contest is a small fraction
of it, the planner switches on its own. Nothing to add.

**Statement 34 is the hazard, and no index fixes it.** The seq scan is the
*optimal* plan for "read 240 000 of 248 755 case rows" — the query is the
finding. At 2 000 pupils × 8 problems the cold fold costs 146 ms and spills to
disk, and the bind list grows linearly with the contest's submissions. D25's
2 s TTL plus per-worker coalescing bounds this to about four folds per two
seconds across `API_WORKERS=4`, i.e. **≈0.3 s of CPU per wall-clock second, a
third of one core of sixteen, continuously, for one province round.**
Survivable today; the fix is a smaller fold (subtask points summarised per
submission rather than re-derived from cases), which is a redesign and not
this slot's.

---

## What was fixed, and what it costs

**Migration 0044** (`packages/db/migrations/0044_f44_progress_indexes.sql`,
generated with the repo's `drizzle-kit generate` so the journal wrote itself —
D133 exists because a hand-managed journal entry was skipped forever):

```sql
CREATE INDEX "submissions_user_recent_idx"  ON "submissions" ("user_id","id" DESC NULLS FIRST);
CREATE INDEX "submissions_user_created_idx" ON "submissions" ("user_id","created_at");
```

- **Write cost**: two extra btree entries per `INSERT` into `submissions`. One
  row per submit, and the fleet grades ≈35 submissions/min, so this is not a
  hot write path. No `UPDATE` touches either indexed column after insert.
- **Deploy cost**: drizzle runs migrations in a transaction, so these are
  plain `CREATE INDEX`, not `CONCURRENTLY`. On the live table (881 rows) that
  is a `SHARE` lock held for milliseconds. On a province's table it would be
  seconds and should be run outside a contest window.
- **`DESC NULLS FIRST` is not cosmetic.** `ORDER BY id DESC` means NULLS FIRST
  in Postgres; drizzle's bare `.desc()` emits `DESC NULLS LAST`, a different
  pathkey, and the planner declined the index and sorted anyway (107 buffers
  vs 15). Both indexes hold identical entries — `id` is `NOT NULL` — and only
  one of them is usable.

**One rewrite** (D164): `ProgressService.heatmap` drops the `problems` join on
the own-page path, where nothing filters on `problems`. The join is
semantically free (`problem_id` is `NOT NULL` → a primary key) and was what
forced heap access; removing it is what makes the new index an *index-only*
scan. The public path keeps the join, because there it carries
`visibility = 'public'`.

**A stale claim corrected.** Gap 3 said "the heatmap's day is not sargable".
The sargable `created_at >=` bound has been in the file since the commit that
created it (`4ec5999`, 30 Aug) — a day *before* the gap text (`7d54a96`,
31 Aug). What is not sargable is the `to_char(...) BETWEEN` beside it, and it
is not meant to be: the plans show it removing **one** row from a read the
bound had already narrowed. The defect was the join one line above, not the
predicate.

---

## Indexes and fixes the evidence REFUSED

Recorded because a province operator needs to know what was tried.

| Candidate | Measured outcome |
| --- | --- |
| `submissions (user_id, created_at)` **alone** | Planner never chose it. 305 buffers before, 305 after. It only earns its bytes with D164's rewrite (→10) |
| `contest_participations (user_id)` | Not chosen. `upcomingContests` reads `user_id = ? OR team_id IN (…)` — D113's sanctioned predicate — and a disjunction with a hashed subplan is not indexable |
| `contests (end_time)` | Not chosen. 364 rows, and `visibleContestsWhere`'s `OR`-of-subqueries cannot be pushed |
| An index for the **streak** | Would have to carry `user_id, created_at, verdict, id`. Index bytes on every row of the table to save one aggregate on one page; the arithmetic does not justify it |
| An index for **statement 34** | The seq scan is optimal for reading 96 % of the table. Not an index problem |
| Rewriting `contestWindowOpenWhere` | **Deliberately not attempted** — see below |

### The one thing indicted and not fixed

Five of the eight slowest statements ([1], [2], [11], [14], [23]) share one
sub-plan: D49's window exclusion, `contestWindowOpenWhere`, which the planner
turns into a **Hash Anti Join whose inner side is the whole of
`contest_submissions ⋈ contest_participations ⋈ contests`** — three sequential
scans, rebuilt per statement. Its cost has nothing to do with the page being
rendered and everything to do with how much contest activity the deployment
has *ever* seen. At 16 252 contest submissions it is 6–9 ms; a province's
second season is an order of magnitude more.

It is left alone on purpose:

- every one of the five sits behind a cache (D49's 30 s per problem, D83's
  60 s per user), so the cost is per cache miss, not per request;
- the only rewrite that removes the scans is a redesign of the predicate. The
  obvious "imply `end_time > now`" conjunct does **not** work — the plans show
  that filter already running *after* the join, and a virtual participation
  legitimately outlives its contest's `end_time`, so no constant bound on
  `contests` is implied;
- the predicate is pinned by `apps/api/test/submission-freeze.spec.ts`'s
  agreement test between the row form and the SQL form. Editing it for a fix
  that does not fix it is risk with no return.

Named as a follow-up in D163/D164 and in `PROVINCE-READINESS.md` gap 3.

---

## The cache, argued (brief §1)

Per-user keys mean 2 000 pupils opening the page at 07:00 are **2 000 distinct
keys**, so `ScoreboardCache.through`'s in-flight coalescing — which is
per-worker, per-key — collapses nothing. That is the worst arrival pattern for
an uncached expensive query, and it is worth doing the arithmetic rather than
building for it:

**≈15.8 ms of database time × 2 000 pupils ≈ 32 s of single-core work**,
spread over however long the 07:00 rush lasts. Over a minute that is **half of
one core out of sixteen**, against a Postgres already sized for the load
profile in `load/RESULTS.md`. After D163/D164 it is ≈14 ms and ≈29 s.

**Conclusion: no stampede machinery.** Not a distributed lock (D25 already
argues the round trip is not worth `API_WORKERS − 1` folds), not a longer TTL
(60 s is already the point where a pupil's own solve stops appearing on their
own page), not a precompute (2 000 rows recomputed on a timer to serve the
fraction of pupils who open the page). If the arithmetic changes — a bigger
province, or the D49 anti-join growing a season deep — the number to watch is
the one printed above.

---

## Against `load/RESULTS.md` (30 August)

| Figure there | Status |
| --- | --- |
| 2 000-VU contest-day profile, per-route p95 | **Not invalidated and not re-measured.** No load test was run — the brief forbade it and the host had read 93 °C. Those figures predate five languages, D154's limit joins, D161's optimistic-concurrency reads and migrations 0042–0043, so they are stale in the direction of *optimism*; this slot does not refresh them |
| Scoreboard p95 3.57 s pre-D25, and the cached figure after | **Unaffected.** The fold's SQL is unchanged by this slot, and the freeze provably does not change it either |
| Soak run, CPU by container | **Unaffected.** No code on those paths changed |
| One judge ≈35 submissions/min | **Unaffected**, and it is the number that bounds D163's write cost |
| Anything about `/users/me/progress` | There is none — that is why gap 3 existed |

Nothing here claims a speed-up in milliseconds on the live database. On 881
submissions the new plans and the old ones are indistinguishable in time; the
buffer counts above come from the 200 880-row scratch copy, and the point of
every one of them is the **shape**, which is what stops being true as a
province fills the table.

---

## Verification

- `apps/api/test/progress-plan.spec.ts` — container-backed, **run alone**
  with `--no-file-parallelism` per the thermal cap. It drives
  `ProgressService.myProgress` for real, captures the emitted SQL from
  drizzle's logger, re-binds the captured parameters and `EXPLAIN`s them, and
  asserts on the resulting plans. `1 passed`.
- Demonstrated red **twice, independently**: reverting D164's branch reds the
  "the emitted SQL mentions no `problems`" assertion; blanking 0044's
  `CREATE INDEX` statements reds the `Index Only Scan … Heap Fetches: 0` and
  `submissions_user_recent_idx` assertions.
- `packages/db/test/migration-journal.spec.ts` — `7 passed` (D133's drift
  guard, with 0044 in the journal).
- `apps/api/test/user-progress.spec.ts` + `team-progress-seam.spec.ts` —
  `16 passed`.
- `typecheck` and `lint` clean for `@duckoj/db` and `@duckoj/api`.
