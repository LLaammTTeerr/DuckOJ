# F1 — contest clarifications and announcements

Status: **DONE_WITH_CONCERNS** (one pre-existing flake, see 3).

## What shipped

`contest_clarifications` (migration **0017**) plus four routes under the
`Contests` tag, the D14 producers for them, and a "Hỏi đáp / Thông báo" panel
on the contest page. Decision recorded as **D31**.

- `POST /contests/{key}/clarifications` — a **joined** participant asks;
  `@RequireScope('contests:write')`, mirroring `join`. 20/user/contest/hour
  via `RateLimiter`, refused loudly (429 `clarification_rate_limited`).
- `GET /contests/{key}/clarifications` — `@Public()` + `contests:read`.
  Organiser sees all; everyone else sees public rows plus their own.
- `PATCH /contests/{key}/clarifications/{id}` — creator or admin answers and
  publishes; 403 `contest_forbidden` for a viewer who does not run it.
- `POST /contests/{key}/announcements` — creator or admin; a row with no
  question, public on creation.
- Notifications: `clarification_answered` (asker, first answer only),
  `clarification_published` and `contest_announcement` (every **distinct**
  participant, one `notifyMany` INSERT inside the tx, cap 10000).
- `ContestAccessService.loadVisible` became public so "may this actor see
  this contest" still has exactly one implementation.

## Files

`packages/db/src/schema/guarded.ts`, `packages/db/migrations/0017_*.sql`,
`packages/contracts/src/contests.ts`, `openapi.json`,
`packages/sdk/src/generated.ts`, `apps/api/src/authz/contest.clarifications.ts`
(new), `apps/api/src/authz/{contest.access,authz.module}.ts`,
`apps/api/src/contests/contests.controller.ts`,
`apps/api/src/notifications/notifications.service.ts`,
`apps/web/src/routes/{contests,notifications}.tsx`,
`apps/web/src/i18n/{en,vi}.ts`, `docs/DECISIONS.md`.

## Tests — red first, then mutation-checked

- `packages/db/test/contest-clarifications.spec.ts` (3). Red: dropped the
  CHECK from 0017 → "refuses a row with neither a question nor an answer"
  failed; restored → green.
- `apps/api/test/contest-clarifications.spec.ts` (10). All 10 red before the
  service existed. Seven mutations, each restored: list ignores the private
  filter (1 red) · notify on every PATCH (1) · `selectDistinct` → `select`
  (2) · rate limit disabled (1) · join requirement removed (1) · problem
  resolved globally instead of within the contest (1) · `canRunContest`
  dropped from answer/announce (2).
- `apps/web/test/contest-clarifications.spec.tsx` (7) + one case in
  `notifications.spec.tsx`. Seven mutations, each red then restored: never
  poll · always poll · ask form shown to a non-participant · answer controls
  shown to a participant · publish overwriting the answer · private marker
  removed · the three kinds falling through to the raw-kind default.
- `apps/web/test/contests.spec.tsx`'s mocks now answer the third GET the page
  makes; without that they returned the participation stub for it.

Full ritual green: `-r typecheck`, `typecheck:scripts`, `-r lint`,
`lint:scripts`, `-r test` (603 api / 218 web / all packages), contracts+SDK
regen with no diff, `vite build`.

## Rulings (all in D31)

One row for both shapes · notify on transitions only · fan-out is one INSERT
over distinct participants · asking needs a participation (403
`contest_not_joined`) · reading is public · 429 rather than D13's silent drop
· a foreign `problemCode` is `problem_not_found` · 30 s polling while running,
none afterwards, no WebSocket · `RateLimiter` re-provided in `AuthzModule`
(stateless; importing `AuthnModule` would close a cycle).

## Concerns / left out

1. Clarifications are **not** governed by the freeze (D22/D23). An organiser
   publishing an answer during the freeze window reveals it to everyone,
   which is the intent — but nothing stops an answer that names a verdict.
   Organiser discipline, not a mechanism.
2. The feed is not paginated and not capped on read. A contest with thousands
   of questions serves them all in one response; the ask limiter bounds the
   growth rate, not the total.
3. `contest-scoreboard-cache.spec.ts` "drops the cached board when a
   participant is disqualified" failed once under the parallel `-r test` and
   passed alone, on a clean full api rerun, and on a second full `-r test` —
   the same flake `f1-api-fixes-report.md` §5 already records. Untouched by
   this work.
4. No e2e/Playwright journey for the panel, and it was not exercised against
   the live stack.
