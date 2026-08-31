# loop-f29 — teammates share their team's contest submissions (D117)

**Status: DONE.** Branch `main`, not pushed. Ruling **D117** (standard ICPC:
one team is one entity). Closes the seam loop-b22 recorded open (concern #2):
`visibleSubmissionsWhere` and the freeze escape keyed on `submissions.user_id`,
so a teammate could not see another member's contest submission at all.

## The rule shipped
A submission mapped (via `contest_submissions ⋈ contest_participations`) to a
participation whose `team_id` the viewer is a member of is visible as if their
own — LIST, verdict/points, and (extending D27) SOURCE while the contest runs.
Scoped strictly to the same team's same-contest rows; other teams stay frozen
(D23) and source-hidden (D27) exactly as before.

## Files
- `authz/submission.visibility.ts` — `visibleSubmissionsWhere` gains
  `submissions.id IN (my acting participations' submissions)`; row twin
  `canViewSubmission`/`loadSubmissionContext` gain `viewerOwnsViaTeam`. Both via
  `actingParticipationWhere` (D113) — no fourth idiom; guard stays green.
- `authz/submission.freeze.ts` — `isSubmissionFrozen`/`isContestSourceHidden`
  gain the team escape; `frozenSubmissionsWhere(db, actor, now)` gains
  `(actingParticipationWhere) IS NOT TRUE` (NULL-safe: `NOT (...)` would
  unfreeze every stranger's individual row once the viewer holds any team);
  `loadSubmissionFreezeContext(db, actor, id)` loads the fact.
- `authz/submission.access.ts` / `user.access.ts` — thread `db`/`actor`/`id`;
  join `teams` for `teamName`, `users` for detail `username`.
- `contracts/submissions.ts` (+ openapi/sdk regen) — `teamName` on both, detail
  `username`; D27 prose extended.
- web `submission.tsx` / `submissions.tsx` (+ vi/en) — "nộp bởi <member> (đội
  <team>)"; a teammate can open a team submission.

## Tests — red→green, mutation-checked
`test/submission-teammate-visibility.spec.ts` (7, integration on testDbUrl):
teammate reads team row + verdict + source; captain reads member's; member
lists the team's `?contest=` rows; non-teammate still 404 + unlisted; another
team's row stays frozen+source-hidden; **unrelated individual entrant stays
frozen (the SQL NULL trap)**; SQL/row freeze forms agree for a team viewer. Five
mutations each reddened the right test (visibility list clause, canViewSubmission
clause, freeze escape, source escape, `IS NOT TRUE`→`NOT`). Web: team-label
tests on both screens. D113 invariant guard green.

## Rulings made
- Reused `?contest=` rather than adding a `team=` filter (the widened
  `visibleSubmissionsWhere` already returns the team's rows) — kept small.
- `actingParticipationWhere` (own OR team) reused wholesale; the own half is
  redundant with `user_id = :me` but keeps the D113 guard green.

## Verify (all green)
`-r typecheck`; `typecheck:scripts`; `-r lint`; `lint:scripts`; contracts+SDK
regen idempotent; `vite build`; non-api workspaces pass; api serial **127
files / 1110 tests**. `graphify update .` run.

## Concerns
None blocking. `user.access.ts` stats now count a teammate's own-team rows as
unfrozen for a member viewing their profile — consistent with the ruling (they
may already see those verdicts), noted in case it surprises.
