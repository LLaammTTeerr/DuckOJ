# F23 — organiser live monitor (D95) — DONE_WITH_CONCERNS

## Shipped
- `GET /contests/{key}/monitor` (tag `Contests`, `contests:read`, not `@Public`): per-problem
  attempts/accepted/distinct-solvers/queued, contest-scoped queue depth + oldest pending age,
  judge liveness, last 50 submissions with **real** verdicts (D22/D23 exempt organisers),
  unanswered clarifications + newest 5, participants online, D80 refusals (10 min). 404 unseen /
  403 `contest_forbidden` seen-but-not-run — the similarity shape. Cached 5 s through
  `ScoreboardCache.through` (`duckoj:monitor:v1:<id>`), no invalidation.
- WS `{type:'watch-contest',key}` → `contest-watched`; `{type:'contest-activity',key}` fanned out
  on the existing Redis submission channel. Organiser-only via `assertMayWatch`; the
  submission→contest lookup is skipped when the worker holds no watcher. Plus `unwatch-contest`,
  8-contest per-socket cap.
- Presence: the gateway ZADDs each authenticated connection's user id on accept and on its 30 s
  sweep; the monitor intersects that set with `contest_participations`. Never fails a caller.
- Migration **0035**: `contest_submissions (contest_problem_id, id)` — no index into that table
  from a contest existed — and `(participation_id)`, a missing FK index under `ON DELETE CASCADE`.
- Web `/contests/{key}/monitor`: glass tiles, per-problem table + pass-rate bar, feed and questions
  tables; `refetchInterval: 5_000` + the socket; every entity a link; vi/en; `canEdit`-gated link.
- New: `authz/contest.monitor.ts`, `realtime/contest-presence.ts`, `web/routes/contest-monitor.tsx`,
  3 specs, `db/migrations/0035_*`; gateway, both modules, controller, contracts, openapi+SDK,
  `router.tsx`, `routes/contests.tsx` and i18n touched.

## Tests — 20 new (api 14, web 6); every mutation below applied, seen red, restored
Drop `canRunContest` in `snapshot` → 403 red; in `assertMayWatch` → WS-refusal red. Unscope
`queue()` → queue red; drop `answer is null` → clarifications red; bypass `cache.through` → cache
red; unscope `participantsOnline` → presence red; flip the feed's inner `LATERAL` order → feed
red. Remove the `contest-activity` handler / the refusal's `disposed = true` /
`void this.notifyContest(…)` → three hook + realtime tests red.

## Rulings (all in D95)
Presence is connected-users ∩ participations, a floor not a roster (D31 gave the contest page no
socket, so the gateway cannot know which contest one is for). Refusals are deployment-wide: D80
keys on the user. Judge silence reuses D47's 90 s over "last minute", so monitor and dashboard
cannot disagree. Clarifications list the newest five **unanswered**. The feed's `verdict`/`state`
are plain strings: importing the enums back from `submissions.ts` is a zod-time cycle. 0035 as
briefed; `migration-journal.spec.ts` explicitly tolerates the 0030–0034 gap.

## Concerns
1. One mutation would not go red: deleting the feed's **outer** `order by x.id desc` still passes
   — Postgres returned `[120,…,71]` anyway (edit verified applied, ids dumped). Kept: that plan
   is not guaranteed at scale, and the inner ordering IS pinned.
2. The contest-page link's `canEdit` gate has no test of its own (same expression as the adjacent
   edit link; covering it meant editing a spec outside the touch list).
3. `RealtimeModule` now imports `AuthzModule` — acyclic, but it widens `buildAppWithRealtime`.

## Verify
`pnpm -r typecheck`, `typecheck:scripts`, `pnpm -r lint`, `lint:scripts`, `vite build` green.
Tests in three passes, not one `-r test` (api is ~40 min, run alone to avoid podman contention):
api 113 files / 994 tests, web 50 / 501, other packages 78 — green. Contracts+SDK regenerated.
