# loop-b22 — the team participation seam, closed structurally (D113)

**Status: DONE.** Branch `worktree-agent-ae7d99254c3714982`, not pushed. Ruling
**D113** (D114/D115 unspent). 21 participation-by-`user_id` reads found; **1
fixed**, 20 audited — 3 sanctioned, 11 team-aware, 6 individual-only. 1 guard
test; full ritual green. One commit — fix, guard and ledger together, because
the guard's allowlist IS the sweep.

## The class
A read keys a `contest_participations` row on `user_id = you` for "is this
person IN this contest / what may they see / count them". In TEAM mode (D99)
that row is the captain's alone — B-18 (404 private problems), B-19 (monitor
named captain), B-21 (spoiler + broadcast to captains). B-21 gave the right
clause: `actingParticipationWhere`.

## Fixed (1) — red→green, mutation-checked
- **`progress.access.ts::upcomingContests`** — the last surviving read of the
  family; a non-captain's My-progress page was empty of the round they sit. Now
  via `actingParticipationWhere`. `team-progress-seam.spec.ts`: non-captain sees
  `seam-round`, red before (`expected [] to include 'seam-round'`).

## Made impossible to reintroduce (D113)
- **Exported `actingParticipationWhere`** (`problem.visibility.ts`) as the one
  sanctioned READ predicate; `participation.ts` holds the ACT-now resolver.
- **Guard `apps/api/test/team-participation-invariant.spec.ts`** (source scan,
  shape of `route-marker-coverage.spec`): every `contestParticipations.userId`
  / raw `part.user_id` read must be in the sanctioned module or the ALLOWLIST
  (keyed `file::function` + reason). A new read fails, named, with the two legal
  moves; a removed one fails as stale — a live census. Mutation-checked: the
  reverted fix reddens it, naming the site.

## Sites swept, classified in the allowlist
- **Sanctioned (3):** `actingParticipationWhere` (read predicate),
  `actingParticipations` (act-now), `listParticipations` (exact-user resolver).
- **Team-aware / team-scoped (11):** `computeScoreboard`, `assertMembersFree`,
  `assertAddedMembersFree`, `eligibilityFor`, `broadcastRecipientsQuery`,
  `participantsOnline`, similarity `loadCandidates`, `contestsOf`, and the
  team-join paths `joinAsTeam` / `enterTeam` / `teamParticipation` (team_id).
- **Individual-only, correct (6):** `setDisqualified` (DQ of a named person,
  D37); `rankedFieldFor` (per-user Glicko-2 — teams unrated); `loadParticipantOrgs`
  (skipped for team contests); `countParticipants` + `contest-stats`
  `noteContestVerdict`/`recomputeContestProblemStats` (one per participation = team).
- **Fixed prior loops, re-verified:** `?contest=` mapping, `/contests/{key}/me`,
  monitor feed (D105), comments spoiler + editorial + D35 mask, booklet, results.

## Ruling left open (no D spent)
- **Freeze escape** (`frozenSubmissionsWhere`) keys on `submissions.user_id`,
  stays individual: a teammate cannot read another member's contest submission
  at all (`visibleSubmissionsWhere` has no team clause), so widening it is
  unobservable without first deciding whether teammates see each other's
  submissions mid-round — a product question, recorded not patched.

## Verify (all green)
`-r typecheck`; `typecheck:scripts`; `-r lint`; `lint:scripts`; contracts + SDK
regen **no diff**; `vite build`; non-api workspaces pass; api serial 126 files /
1103 tests. `graphify update .` run.

## Concerns
1. Guard rests on the drizzle idiom + the `part.` raw-SQL alias convention; a raw filter under another alias would slip it — widen the regex if one appears.
2. Freeze / team-submission-visibility (above) is the one open product question.
