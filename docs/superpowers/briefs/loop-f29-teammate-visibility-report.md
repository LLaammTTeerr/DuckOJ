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
- `authz/submission.visibility.ts` — team clause on `visibleSubmissionsWhere` +
  row twin `viewerOwnsViaTeam` (`canViewSubmission`/`loadSubmissionContext`).
- `authz/submission.freeze.ts` — team escape on `isSubmissionFrozen` /
  `isContestSourceHidden`; `frozenSubmissionsWhere(db,actor,now)` gains
  `(actingParticipationWhere) IS NOT TRUE` (NULL-safe); freeze ctx loads it.
- `authz/submission.access.ts` / `user.access.ts` — thread `db`/`actor`/`id`;
  join `teams`→`teamName`, `users`→ detail `username`.
- `contracts/submissions.ts` (+ openapi/sdk regen) — `teamName`, detail `username`.
- web `submission.tsx` / `submissions.tsx` (+ vi/en) — "nộp bởi <member> (đội <team>)".
- All team clauses route through the sanctioned `actingParticipationWhere` (D113) — no fourth idiom; the D113 invariant guard stays green.

## Tests — red→green, mutation-checked
`test/submission-teammate-visibility.spec.ts` (7, testDbUrl): teammate reads
row+verdict+source; member lists team's `?contest=` rows; non-teammate 404 +
unlisted; another team's AND an unrelated individual's frozen verdict stay
hidden (the SQL NULL trap); SQL/row freeze forms agree for a team viewer. Five
mutations each reddened the right test (list clause, canViewSubmission clause,
freeze escape, source escape, `IS NOT TRUE`→`NOT` — caught by the agreement
test). Web: team-label tests on both screens.

## Rulings made
- Reused `?contest=` rather than adding a `team=` filter — the widened
  `visibleSubmissionsWhere` already returns the team's rows. Kept small.
- Reused `actingParticipationWhere` (own OR team) wholesale; the own half is
  redundant with `user_id = :me` but keeps the D113 guard green.

## Verify (all green)
`-r typecheck`; `typecheck:scripts`; `-r lint`; `lint:scripts`; contracts+SDK
regen idempotent; `vite build`; non-api workspaces pass; api serial **127 files
/ 1110 tests**. `graphify update .` run.

## Concerns
None blocking. `user.access.ts` stats now count a teammate's own-team rows as
unfrozen for a member viewing their profile — consistent with the ruling, noted
in case it surprises.
