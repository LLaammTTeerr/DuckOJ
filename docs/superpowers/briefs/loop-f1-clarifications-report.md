# F1 — contest clarifications and announcements

Status: **DONE_WITH_CONCERNS** (one pre-existing flake, see 3).

## What shipped

`contest_clarifications` (migration **0017**), four routes under the
`Contests` tag, their D14 producers, and a "Hỏi đáp / Thông báo" panel on the
contest page. Rulings are **D31**.

- `POST /contests/{key}/clarifications` — a **joined** participant asks;
  `@RequireScope('contests:write')`, mirroring `join`. 20/user/contest/hour
  via `RateLimiter`, refused loudly (429 `clarification_rate_limited`).
- `GET /contests/{key}/clarifications` — `@Public()` + `contests:read`.
  Organiser sees all; everyone else sees the public rows plus their own.
- `PATCH /contests/{key}/clarifications/{id}` — creator or admin answers and
  publishes; 403 `contest_forbidden` for a viewer who does not run it.
- `POST /contests/{key}/announcements` — creator or admin; public on creation.
- Notifications: `clarification_answered` (asker, first answer only),
  `clarification_published` / `contest_announcement` (every **distinct**
  participant, one `notifyMany` INSERT inside the tx, cap 10000).
- `ContestAccessService.loadVisible` became public: one implementation of
  "may this actor see this contest".

## Files

`packages/db/src/schema/guarded.ts` + `migrations/0017_*.sql`;
`packages/contracts/src/contests.ts` + `openapi.json` +
`packages/sdk/src/generated.ts`; `apps/api/src/authz/contest.clarifications.ts`
(new) + `authz/{contest.access,authz.module}.ts` +
`contests/contests.controller.ts` + `notifications/notifications.service.ts`;
`apps/web/src/{routes/{contests,notifications}.tsx,i18n/{en,vi}.ts}`.

## Tests — red first, then mutation-checked
- `packages/db/test/contest-clarifications.spec.ts` (3). Dropping the CHECK
  from 0017 reds the "neither question nor answer" case; restored, green.
- `apps/api/test/contest-clarifications.spec.ts` (11). All red before the
  service existed. Eight mutations, each restored: list ignores the private
  filter · notify on every PATCH · `selectDistinct`→`select` · limiter off ·
  join gate off · problem resolved globally · `canRunContest` dropped · the
  `Number.isInteger` id guard removed (1–2 red each).
- `apps/web/test/contest-clarifications.spec.tsx` (7) + one case in
  `notifications.spec.tsx`. Seven mutations, each red then restored: never
  poll · always poll · ask form for a non-participant · answer controls for a
  participant · publish overwriting the answer · private marker gone · the
  three kinds falling through to the raw-kind default.
- `apps/web/test/contests.spec.tsx`'s mocks now answer the third GET the page
  makes; without it they returned the participation stub for it.
Ritual green: `-r typecheck`, `typecheck:scripts`, `-r lint`, `lint:scripts`,
`-r test`, contracts+SDK regen with no diff, `vite build`.
## Concerns
1. Clarifications are **not** governed by the freeze (D22/D23): nothing stops
   a published answer naming a verdict. Organiser discipline, not a mechanism.
2. The feed is unpaginated and uncapped on read; the ask limiter bounds the
   growth rate, not the total.
3. `contest-scoreboard-cache.spec.ts` "drops the cached board when a
   participant is disqualified" failed once under parallel `-r test`, passed
   alone and on two clean reruns — the flake `f1-api-fixes-report.md` §5
   already records. Untouched here.
4. No Playwright journey for the panel; never exercised against the live stack.
