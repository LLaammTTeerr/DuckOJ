# F-24 — Team contests ("thi đồng đội", ICPC-style). DONE_WITH_CONCERNS

**Migration 0036** — `teams` (org-scoped, slug unique per org), `team_members` (PK
both + FK index on `user_id`), `contests.participation_mode` + `max_team_size`, and
`contest_participations.team_id` (`ON DELETE RESTRICT`) under a partial unique index
`(team_id, contest_id)` that doubles as that FK's index.

**API.** `TeamAccessService` + `TeamsController` —
`POST/GET/PATCH/DELETE /orgs/{slug}/teams[/{teamSlug}]`, tag `Organizations`;
owner-or-admin writes, members read their own, 404 for anyone else.
`POST /contests/{key}/join` takes `{ teamSlug? }` with nine refusals (D99).
`actingParticipations` is the ONE resolver for "which participation does this person
act under" — join, `/me`, `?contest=` submissions, clarifications. The board prints
the team's name; who the team is rides in a camelCase `teams` sidecar folded inside
`computeScoreboard` (absent for an individual contest), which results, certificates
and similarity read. A team contest is refused rating inside `setRated`.
`packages/contest-formats` untouched: all 27 goldens and 23 replays identical.
**Web.** `OrgTeams` on the org page; a join picker; "competing as <team>"; a team
scoreboard row linking the school (not a profile that would 404) and disqualifying
through the sidecar's `captain`; mode + cap on contest-new/edit; i18n vi/en, NFC.

**Files.** New: `migrations/0036_teams.sql`, `authz/{team.access,contest.teams}.ts`,
`orgs/teams.controller.ts`, `contracts/src/teams.ts`, `web/routes/teams.tsx`, two
spec files. Edited: `db/schema/guarded.ts`; `authz/{participation,contest.access,contest.mapping,contest.clarifications,contest.similarity,rating.service,authz.module}.ts`;
`contests/{contests.controller,results.service,results-csv}.ts`; `statements/results.ts`;
`contracts/src/{contests,index}.ts`; `openapi.json` + SDK; `web/routes/{orgs,contests,contest-new,contest-edit}.tsx`;
`web/i18n/{en,vi}.ts`; `docs/DECISIONS.md` (D99).

**Tests.** `apps/api/test/contest-teams.spec.ts` (16, incl. a two-teammate Join race
on `testDbUrl()`); `apps/web/test/contest-teams.spec.tsx` (6). Red→green: twenty
mutation checks, each rule broken alone with its pinning test re-run — 19 red first
try. The twentieth (disbanding a team that competed) stayed green with only its
pre-check removed (`ON DELETE RESTRICT` catches it too) and went red once both that
and the FK catch were gone: the database is the guard, the pre-check is the race
loser's answer.

**Rulings — all in D99.** One participation per team, held by the joining member; no
virtual replays; a person holds at most one participation per contest; DQ rides the
existing `participants/{username}` route through the captain; team names unique per
contest, case-folded; the camelCase sidecar; team mode requires organizations (422);
mode and cap freeze at the start (D38); `TEAM_MAX_MEMBERS = 12` vs the contest's own
cap; owner **or admin** manages teams — widened from the brief's "owner creates" on
D66's rank, D61's owner-only rule being about minting accounts; rosters stay live
during a contest; never rated; the exports' `members` column and team-scoped org
column; similarity labels by team, so teammates are never compared.

**Concerns.** (1) Mid-edit, the coordinator's B-16 merge staged with
`git add -A` and swept my then-uncommitted contracts, teams controller, module
wiring and a first cut of `team.access.ts` into merge commit **031dbbc** —
nothing lost or altered, but this task's diff spans it. (2)
`contest-monitor.spec.ts` was already red on main (B-16 made the harness apply
`configureApp`, `/api/v1/...`, and the sweep missed that file); mechanical
prefix fix in `e0151c7`, no assertion changed. (3) The team-name join race is
unguarded — two same-named teams joining in the same instant both land and the
loser shares the winner's sidecar entry; display-only, named in D99. (4) No
"my teams" endpoint: the picker issues one `GET /orgs/{slug}/teams` per
organization the contest names — fine at two schools, not at twenty. (5)
Rosters are read, never frozen, and no screen warns the teacher. (6) Not
built: a team detail page, team-scoped notifications, organiser seeding of a
team (a team enters only by a member pressing Join).
