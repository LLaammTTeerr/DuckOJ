# B18 — whole-diff review II (`7134632..HEAD`)

325 files, ~57.6k insertions; every non-generated source diff read. Six defects confirmed, each red→green with a mutation check, one commit apiece. Ruling **D101**; D102–D103 unspent. Full ritual green. Every confirmed defect is in the **D99 team seam** — F-24 merged last, so every per-user surface predates it and none was re-asked.

## Blocker

**1. Two of three teammates could not read or submit the round's problems.** `authz/problem.visibility.ts:110,175` — `inJoinedContest`, the clause that makes a contest's PRIVATE problems readable to the people sitting it, asks `contest_participations.user_id = you`. D99 made a team one participant with one participation, held by whoever pressed Join, so the answer is *no* for every other member of every team: `GET /problems/{code}` 404s, the booklet comes back empty (D62 filters it through `visibleProblemsWhere`), `POST /submissions` 404s `problem_not_found`. The round is unrunnable for them, on contest day, for the feature that shipped last. Every existing team test seeded a `public` problem, which is not what a contest uses. One `actingParticipationWhere` now serves both twins. **ccd320d** (D101)

## Majors

**2.** `authz/participation.ts:130` — D99: "a member removed mid-round stops being able to submit for the team from that moment". `actingParticipations` said `user_id = you OR team_id in (your teams)`, and the first half never expires: the captain is the one member a removal cannot remove, and the likeliest to be taken off. Removing a pupil who did not turn up changed nothing at all. **1002da8**

**3.** `authz/team.access.ts:175` — "a person holds at most one participation per contest" was enforced at `join` and nowhere else, so a roster PATCH (any admin of any of the contest's schools, mid-round) could add somebody already competing. D99 names the cost: `actingParticipations` picks between two rows by id, `setDisqualified` moves both, the board counts one pupil's work twice. The same back door fe85612 closed for the team NAME. Residual, as for that check: a PATCH and a concurrent `join` do not serialise, so the race D99 already records for the name can still land here. **88087e2**

## Mediums

**4.** `authz/contest.monitor.ts:498` — "participants online" intersects presence with `contest_participations.user_id`, one person per squad: the invigilator's "is the room here" number was a third of the room, and fell when a captain closed a tab. **bda0a35**

**5.** `web/src/routes/contests.tsx:1250,1386` — the similarity report labels by TEAM (D99); both views linked that label to `/users/{name}`, which 404s. The scoreboard 200 lines up already refused to. **535be24**

**6.** `web/src/routes/contests.tsx:311` — the join picker read its teams as `data?.items ?? []`, so a 500 told a competitor at the bell they belong to no team and disabled Join. B-4's rule, B-8's nine survivors, a tenth after both. **68e0629**

## Recorded, not fixed

- **`must_change_password` is bypassable and the design's premise moved.** D61 left the flag to the web because a pupil "would have to be driving the API by hand"; `oj login` + `apps/mcp` (D89) are now exactly that, documented. `authn/tokens.controller.ts:33` is `@SessionOnly` with no flag check and no password re-proof, so a session opened on a printed password mints a durable token. A change still revokes it, so the exposure is the forced change never happening. Needs a ruling, not a patch.
- `packages/draft.store.ts:99` — the store's own `FILE_NAME_PATTERN` admits `.` and `..`, which `DraftFileName`, the layer it claims to back up, refuses. Unreachable today: every non-HTTP writer names its files itself.
- `cluster.ts:236` — D85's breaker trips on the FIRST exit when `API_WORKERS=1`; one transient crash inside a minute exits the primary and `deploy.sh` rolls back a healthy build.
- `web/src/routes/teams.tsx:65,163,202` — three more `?? …` swallows; blast radius is a 422'd save, not a wipe (an empty `slug` fails `TEAM_SLUG`).
- D89's "samples are parsed out of the statement" is stale against D94; `submissions.gateway.ts:415` sends the watch-cap error with no `readyState` guard; `prepare --token <t>` puts a token in `argv`. Still open from B-8: `dashboard.access.ts` `workers()`, unbounded, every 15 s.

**Cleared:** migrations 0024–0036 (`drizzle-kit generate` — no changes; journal monotonic, unused 0030–0034 harmless like 0020's); route markers (enforced at runtime by `route-marker-coverage.spec`); MCP's `mutates` flag pinned against its scope by `mcp/test/server.spec.ts`; `CsrfOriginGuard` is a global `APP_GUARD`, so every write added after D82 is covered; booklet/results/certificate caches content-addressed and the monitor key single-audience; presence Redis-backed across `main.ts`'s forks; no secret in any log line; i18n parity; contracts/SDK regen (no diff).
