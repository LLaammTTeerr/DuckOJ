# F-25 — monitor counters (D100) + the four team gaps (D99 amended)

**Three commits, one per item, nothing pushed:** `50305a6` counters, `04ffd27` teams, `9e8127a` banner.

## 1. Migration 0037 — the monitor stops scanning (D100)
`contest_problem_stats` (contest_problem_id PK, submitted/accepted/solvers/pending/updated_at) **plus
`contest_problem_solvers`**: a counter cannot maintain a distinct count, and the only other way to decide a
first `AC` is a scan of that problem's submissions on judged's hot path — `ON CONFLICT DO NOTHING RETURNING`
decides it in one probe. Both backfilled in 0037. One copy of the arithmetic in `packages/db/src/contest-stats.ts`
(`reclaimExpiredLeases`'s reason), each function taking the caller's transaction.
`SubmissionAccessService.create` counts an attempt; `EventWriter.writeTerminal` — now
transactional, prior outcome read `for update`, deltas applied **only when the fenced UPDATE returned a
row** — applies the verdict; `RejudgeService` **recomputes** the contest problems it touched inside the
requeue transaction rather than decrementing (a requeue moves verdicts every direction at once, and a wrong
decrement rule is wrong silently, forever). `?recompute=1` is the organiser's repair and *replaces* the 5 s
cache entry (`ScoreboardCache.put`). `queue()` no longer groups by problem: `pending` has one source.

**EXPLAIN, one fixture, both statements (`contest-monitor-plan.spec.ts`)** — 100k `contest_submissions` in a
foreign contest, 200 in this one. Before: `Seq Scan on contest_submissions (rows=100200)` **and** `Seq Scan
on submissions (rows=100200)`, **30.9 ms**. After: `contest_problems` (10) + `contest_problem_stats` (20) +
`problems` (21), widest node **21 rows**, **0.126 ms**.

## 2–3. Teams (D99 amended in place, not appended)
`GET /users/me/teams` (tag `Users`, **`orgs:read`** — it returns rosters), one request across every school;
`?contest=` annotates each row with `eligible` and the code the join would refuse with, and the picker greys
options out from that. Team page `/orgs/{slug}/teams/{teamSlug}`: members, contests entered, captain, link to
each board — **no rank** (a board fold per row, and meaningless mid-round). The same-instant name race is
closed by `pg_advisory_xact_lock(contest_id, hashtext(lower(name)))` around the whole of `join`'s tail, keyed
on the NAME because the racing rows are two *different* teams and only the shared name makes them collide. A roster change during a running contest is 409
`team_locked_during_contest` unless the caller runs **every** such contest; renames stay free.
`POST /contests/{key}/participants {teamSlug}` seeds a team (captain = lowest user id, 422 empty roster,
`startTime = max(now, start)`, refused after the end). The org teams tab warns and names the teams
mid-round. vi/en, NFC.

## Tests — 25 new; every mutation applied, seen red, restored
judged 5, api 5 + 2 + 9, web 4 (+ the picker test rewritten). Red on: the counter call dropped from the event
writer and from `create`; the fence result ignored; `solversDelta` forced to 1; rejudge's recompute removed;
`cache.put` removed; the plan spec's SQL copy drifted; the advisory lock removed (3/3 runs); the roster lock
removed; eligibility ignoring the org; captain as `max` id. **`packages/db` is consumed from `dist`** — a
mutation there needs `tsc -b` first, or it passes for the wrong reason.

## Verify
`-r typecheck`, `typecheck:scripts`, `-r lint`, `lint:scripts` green; contracts + SDK regen left **no diff**;
`vite build` green. `--no-file-parallelism` throughout, api in its own pass: **api 120 files/1051**,
web 52 files/518, judged 128,
mcp 87, contest-formats 120, oj 32, db 49, contracts 39, prepare 62, polygon-import 19, judge-agent 8, sdk 2.

## Concerns
1. `assertRosterUnlocked`'s **every**-vs-**any** exemption is untested — the fixture has one running contest,
   so that mutation stayed green; a team in two simultaneous rounds is the uncovered branch.
2. `?contest=` eligibility is a snapshot, not a promise: what it reports can change between picker and click,
   and the advisory lock is what actually decides.
3. `TeamAccessService` now injects `ContestAccessService` (for `?contest=`'s 404 alone) — acyclic, but it
   widens that constructor. `pending` (submissions not terminal) and `queue.depth` (jobs not done) are also
   different facts and may legitimately disagree on screen.
