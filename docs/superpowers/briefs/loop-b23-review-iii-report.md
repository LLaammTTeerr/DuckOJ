# B23 — whole-diff review III (`4c1508a..HEAD`, 81 commits)

Every non-generated source diff read (D100 counters, D102 tokens, D104 seats,
D105 feed, D109 comments, D110/D111/D113/D116, F-25 team gaps, web UI). Method:
B-18's — read the diff, not steady state. One defect confirmed
(red→green→commit); rest cleared or noted. No D108 index item re-reported.

## Blocker — none.
## Major (fixed)
**1. A cross-org team-slug collision refused a pupil their own team.** `8c8e6c7`.
`contest.teams.ts::resolveContestTeam` picked the lowest team id matching the
slug among a contest's schools, IGNORING the caller's membership; then
`contest.access.ts:1237` refused a pupil on only the higher-id `doi-1` with 422
`contest_team_not_member` — a team they were eligible to enter, blocked because
another school shared the slug. F-25's per-team eligibility said "eligible"
while join said no (the client/server disagreement D99-amended set out to
prevent). The docstring already CLAIMED membership-based resolution; the code
did not. Fix: `resolveContestTeam` takes `preferMemberId`, join passes
`actor.userId` (lowest-id team they're ON wins); organiser-seeding keeps
lowest-id-of-all; single-team contests unaffected. Red→green: new
`contest-teams.spec.ts` cross-org case 422→201.

## Minor (design, not fixed — file:line + scenario)
**2.** `teams.tsx TeamPage` renders contest start times with raw
`new Date(entry.startTime).toLocaleString()` — browser zone, not the account's
(D57); every other screen uses `formatDateTime(…, locale, timeZone)`. Cosmetic.
**3.** `contests.tsx:451` picker `<select>` uses `team.slug` alone as the option
value; a caller on TWO same-slug teams in one contest can't disambiguate in the
UI (server now picks the lowest-id one they're on — #1's fix, D99's tiebreak).
Closing it needs org-in-value + a contract change; narrow, left.
## Cleared with evidence
- **Route markers:** `route-marker-coverage.spec` green (boots module tree,
  walks every route incl. comments/diff/previous/myTeams/seedParticipant);
  contracts `route-coverage.spec` cross-checks controllers↔contracts. New
  `GET /problems/{code}/comments` = `@Public()+@RequireScope` (legal pair).
- **Migrations 0037–0039:** `drizzle-kit generate` → "No schema changes";
  fresh throwaway pg (podman) migrate 0001→latest clean = 34 migrations, 41
  tables (C-1 was 33/40; +0039). Journal monotonic.
- **Counters × rejudge × recompute (D100):** lock order submissions→solvers→
  stats consistent across create/`noteContestVerdict`/rejudge; deltas apply
  only on a fenced-match row inside the write's txn; rejudge & AC-loss recompute
  in-txn, never decrement. `contest-monitor-plan.spec` + D104 race test pin it.
- **Cache keys:** monitor `?recompute=1` `put`s the same `monitorCacheKey` the
  read `through`s; scoreboard key = privileged+phase only (boards are data, no
  locale/view mixing).
- **Diff (D111):** both ids via `getVisible` + `source===null` gate (D27 ⊇
  freeze); `previous` caller-own; DP cap present.
- **Comments (D109):** body via `renderStatement` (DOMPurify, sweep dd69698);
  `hiddenDuringContest` note shown; meter `record`s after create; spoiler-hide
  team-aware; notification `problem_comment_reply` mapped+linked.
- **D102 tokens:** `issue`+`resolve` both refuse on flag; no token in any log;
  WS-refusal pinned. **i18n/theme/app-css** guards green (47); theme first-paint
  script == `theme.tsx`; `system` removes `data-theme`.
- **Samples cache × publish:** N/A — no `statement-samples` change in range. No
  new `as any`/`: any`; no new secret-bearing log line in the diff.
## Concerns
Full `pnpm -r test` (20 pkgs, ~16m) not run end-to-end; ran typecheck(+scripts),
lint(+scripts), regen(no-diff), vite build, all contest/team API suites (70) +
contracts (39) + web i18n/theme/css (47) + guards, plus the full `@duckoj/api`
suite serially (result appended). Fresh-DB pg torn down; nothing pushed.
