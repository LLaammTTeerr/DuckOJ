# B-35 — Hunt the gates and the derived column: report

**Status**: done. **Two defects**, one fixed with a red test and one recorded
as a measured residual. **The derived column is clean**: all 341 live
participations recomputed from `contests` and compared, zero disagreement,
zero `'epoch'` sentinels, and the triggers survive every bulk path but one,
which is named. Decisions **D195** (the meter's real yield, and the third list
of people) and **D196** (U+0000); **D197 unspent**. Three commits in this
clone on `main`; **nothing pushed**, and **no direct write to the live
database** — the only rows it gained are the one probe account the meter
measurement had to register through the API and its 22 `rate_events`, named in
§5.

The live host has grown past the brief's figures: **481 accounts** (482 after
the probe account below), **205 contests**, **341 participations**, 31
organizations. Every number below is this host, today, at `eef05c1`.

---

## Defects

| # | Sev | What | Where | Status |
| --- | --- | --- | --- | --- |
| 1 | medium | **A NUL byte in a path parameter, a search term or a filter answers `500 internal_error`**, on **twelve routes**; eight of the reproductions need no credential at all. Postgres cannot hold U+0000 in `text`, and the `22021` comes back as an unmapped `DrizzleQueryError`. | every controller whose parameter reaches a text comparison | **fixed** — `NulByteInterceptor`, D196, red-tested |
| 2 | medium | **The walk meter bounds the cursor and nothing else.** One ordinary account takes the entire 482-account directory in **576 requests and 1.5 seconds** spending **zero** walk budget, while `?cursor=` is capped at 2 000 rows an hour. Separately, `GET /contests/{key}/scoreboard` is a third bulk list of people — `@Public()`, uncapped, unmetered — that D192's "the rows are events, not people" argument stops one dereference short of. | `walk.meter.ts`, `contests.controller.ts` | **recorded, not closed** — D195; D192 rules the `q` residual open on purpose |

Nothing found on the derived column. §3 shows the work.

---

## 1. Defect 1 — the NUL byte

### The bytes, captured rather than reasoned about (B-33's method)

Anonymous `curl` through the edge, no cookie and no token:

```
GET /api/v1/users/%00           500 internal_error
GET /api/v1/orgs/%00            500
GET /api/v1/problems/%00        500
GET /api/v1/contests/%00        500
GET /api/v1/problems?q=%00      500
GET /api/v1/contests?org=%00    500
POST /api/v1/auth/login  {"usernameOrEmail":"a\u0000b"}   500
```

and signed in as an account thirty seconds old:

```
GET /api/v1/users?q=%00                       500
GET /api/v1/submissions?user=%00              500
GET /api/v1/submissions?problem=%00           500
GET /api/v1/submissions?contest=%00           500
GET /api/v1/users/me/teams?contest=%00        500
GET /api/v1/orgs/{slug}/members?q=%00         500
GET /api/v1/orgs/{slug}/members?cursor=%00    500
POST /api/v1/auth/register  displayName "a\u0000b"   500
```

The API's own log names it: `ERROR [ProblemFilter] { name: 'DrizzleQueryError' }`
with the whole request object beside it, `responseTime: 3`. No row is written
— Postgres refuses the bind — so this is not a disclosure; it is an
unauthenticated 500 with a stack in the log on the most public routes in the
product, which is `route-fuzz.spec.ts`'s first stated property ("a 500 on bad
input is a bug every time") violated on twelve routes at once.

By contrast `/orgs?q=%00` and `/contests?q=%00` answer **200**: those two
filters never reach a text comparison. The vector is not "a NUL somewhere", it
is a NUL **in a place that survives to a statement**.

### Why three specs missed it

The brief asked specifically for a route that slipped past
`route-marker-coverage`, `route-fuzz` and `authz-default`. This is one, and
the mechanism is instructive:

- `route-fuzz.spec.ts` **has sent `cursor: '\u0000'` since it was written** and
  was green. The NUL never reached a bind: `BAD_PARAMS.slug` is `'../..'`, so
  `findVisibleOrgRow` 404s the roster before its cursor is parsed; the `/users`
  cursor is parsed as a number and 422s; `q` — the parameter that goes straight
  into `nameSearchWhere` on four routes — **was never fuzzed at all**; and no
  path parameter ever carried one.
- `route-marker-coverage` and `authz-default` ask *who may*, not *what
  happens*. A 500 satisfies neither question.

### The fix, and the red

`apps/api/src/common/nul-byte.interceptor.ts`, registered globally in
`configureApp`. A request whose **raw** URL contains `%00` (path segments and
query string at once — the raw string is checked because a literal NUL cannot
travel in a request line, and because 87 `@Param()` bindings in this API take a
string with no pipe at all), or whose parsed body holds U+0000 at any depth,
answers `422 validation_failed` — **keys as well as values**, because several
columns here are `jsonb` and Postgres refuses a NUL inside one with `22P05`
exactly as `text` refuses it with `22021`. `%2500` is the five-character text
`%00` and is still served. An **interceptor** rather than middleware, because middleware
runs before the guards and D188's anonymous 401 on `GET /users` must keep
coming first — the full argument, and the one ordering that does move, is
D196.

Red, with the registration removed:

```
apps/api/test/nul-byte.spec.ts
  × a NUL byte is refused, above every handler (D196)
    → {"q":"\u0000"}: expected 500 to be 422

apps/api/test/route-fuzz.spec.ts
  × routes answered 5xx to malformed input:  228 route/mode combinations
    e.g. [session/NUL bytes in path parameters, search and filters]
         GET /contests/{key} -> 500
         GET /contests/{key}/scoreboard -> 500
         GET /users/{username}/rating -> 500
         POST /contests/{key}/participants -> 500
```

Green after: both files pass, and the full API suite is in §4.

**The live edge is not fixed.** The brief forbids restarting a container, so
`duckoj_api_1` keeps serving the code at `eef05c1` and every 500 quoted above
is still reproducible against `http://localhost:8080` right now. It stays that
way until the next deploy — B-33's precedent, said again.

---

## 2. The gates — the route inventory against them

### The rule was applied to every route that can name a person

Every `GET` in the published OpenAPI document was read for a person-shaped
field and then **probed live**, anonymously and as a signed-in non-member,
rather than reasoned about.

| Route | Names people? | Anonymous | Signed-in stranger | Verdict |
| --- | --- | --- | --- | --- |
| `GET /users` | username, displayName | **401** | 200, metered on `cursor` | D188 holds |
| `GET /users/{username}` | username, displayName | 200 | 200 | `@Public()` by D188, unmetered — confirmed by 263 sequential fetches |
| `GET /orgs/{slug}/members` | username, displayName | 200, **one page, no cursor, no `q`** | 200, metered on `cursor` | D191 holds |
| `GET /orgs/{private}/members` | — | **404** | **404** | D56 holds |
| **`GET /contests/{key}/scoreboard`** | **username per `ranking` row** | **200, uncapped, unmetered** | 200 | **§2.3 — the gap** |
| `GET /contests/{key}/clarifications` | asker usernames | 200 | 200 | 28 distinct names here |
| `GET /problems/{code}/stats` | `firstSolver`, `fastest` | 200 | 200 | 40 distinct names |
| `GET /problems/{code}` | author | 200 | 200 | 7 |
| `GET /problems/{code}/comments` | username | 200 | 200 | 0 on this host |
| `GET /contests/{key}/monitor` | username | 401 | 403 | gated |
| `GET /contests/{key}/results.csv` / `.pdf` / `certificates.pdf` / `seats.pdf` | every participant | **401** | 403 | gated — no `@Public()`, deliberately |
| `GET /contests/{key}/similarity[/{a}/{b}]` | username | 401 | 403 | gated |
| `GET /orgs/{slug}/teams`, `/sets`, `/sets/{s}/progress`, `/requests` | username, displayName | **401** | 200 filtered / 403 | gated |
| `GET /users/me/teams`, `/notifications`, `/admin/dashboard` | username | 401 | own rows only | gated |
| **WebSocket** `submissions.gateway.ts` | — | **401 before the upgrade** | authorized per `subscribe` / `watch-contest` | clean: every frame carries an id or a contest key, **never a name** (D23) |
| `apps/mcp` | `contests_scoreboard`, `contests_clarifications` under `contests:read`; its only `users:read` tool is `me_progress` | — | — | reaches the same two rows §2.3 names |
| `apps/oj` (CLI) | no reference to `/users`, `/orgs` or a roster | — | — | clean |

### The exemptions are verified against the org being read

`OrgAccessService.listMembers` computes `metered = query.cursor !== undefined
&& !isAdmin(actor) && (await this.roleIn(actor, row.id)) === null`. `row` is
the row `findVisibleOrgRow` just resolved from the slug, so **membership is
checked against that organization and not against "any org at all"** — the
failure the brief asked for is not present. A member of school A paging school
B is metered; verified live with an account that belongs to nothing.

### The meter is sound where it applies

One session, one account, measured end to end:

```
20 cursor-bearing roster pages of a school it does not belong to  → 200 ×20
the 21st                       429 user_walk_rate_limited   Retry-After: 3211
a malformed cursor AT THE WALL              422 invalid_cursor     (D191's 9th)
GET /users?cursor=<valid> AT THE WALL       429   ← ONE budget across BOTH routes
GET /users?limit=100  (page one, no cursor) AT THE WALL      200
GET /orgs/{slug}/members?q=b                AT THE WALL      200, with pupil rows

rate_events:  user_walk × 20      refused:user_walk × 2   (D47's markers)
key:          user:487            purpose text unchanged, so 0048 stayed unconsumed
```

Three things this establishes: the budget is a **table**, so the four
`API_WORKERS` share one window (there is no process-local counter to diverge);
D16's split works — the two refusals recorded nothing and the window drains;
and the key is `user:<id>`, never an address, so a NAT'd computer room is
thirty windows.

Two more shapes were tried and are not a way around it. **Several tokens** do
not help: the key is the user id, so every credential the same account holds
spends the same window (confirmed — the session and the account are one key in
`rate_events`). **A limit that returns everything** does not exist: `limit=101`
is `422` on both routes, and a request without a cursor answers the same first
page however often it is asked, which is the whole reason D188 counts cursors.

### Ordering, on the neighbours F-53 did not touch

```
                              anonymous    signed-in
/contests?cursor=zzz             422          422
/orgs?cursor=zzz                 422          422
/problems?cursor=zzz             422          422
/problems/{code}/comments?cursor=zzz   422    422
/users/{u}/rating?cursor=zzz     422          422
/submissions?cursor=zzz          401          422    ← guard first, then the cursor
/users?cursor=zzz                401          422    ← D188's ordering
/orgs/{slug}/members?cursor=zzz  401          200*   ← D191's ordering
/orgs/{slug}/members?limit=1000  422          422    ← the DTO pipe has always preceded that 401
```

\* the roster cursor is an **opaque string**, only length-checked
(`parseMemberCursor`), so `zzz` is a legal cursor past the end of the roster
and `200 {items:[],nextCursor:null}` is correct. The 422 is reached with a
cursor over `MAX_MEMBER_CURSOR`, and it precedes the 429 at the wall, as shown
above. **No neighbour is out of order.** The one ordering this slot *does*
move is `?cursor=%00` for an anonymous caller on the roster — 422 rather than
401, argued in D196.

### 2.3 The third list of people

D192 left `GET /contests` open because "the rows are events, not people". True
of `ContestSummary`, and one dereference short: **`GET
/contests/{key}/scoreboard` is `@Public()`, has no cursor, no page cap and no
meter, and every `ranking` row carries `participant` — a username.**

```
anonymous  GET /contests?limit=100 ×2      → 159 contests
anonymous  a scoreboard for each           → 159 requests, 249 ranking rows,
                                             142 DISTINCT usernames, 0 errors
of those 142, reachable through NO other anonymous route:            108
```

Adding every other anonymous source measured above:

| source | distinct accounts |
| --- | --- |
| scoreboards of the 159 listable contests | 142 |
| roster page one of the 29 listable orgs (post-D191) | 86 |
| `firstSolver` / `fastest` / author on 56 problems | 46 |
| clarification feeds | 28 |
| **union** | **264 of 481 — 54.9%** |
| resolved to a display name by the still-`@Public()` profile route | **263 of 264** |

Before D188 it was 461 in five requests; it is 264 in about 450 now. The gates
moved the cost by two orders of magnitude and did not close the class.

**The visibility predicate holds and was checked, not assumed.** An
`org`-visibility contest answers **404 to the scoreboard as well as to the
detail** (`rehearse-icpc-1788140136101`, anonymous and signed-in), so the 46
restricted rounds on this host disclose nobody. A private school still 404s
(`GET /orgs/fe42-truong` and `/members` → 404 anonymously) — but two of its
members are named on public scoreboards they joined
(`fe42-monitor-1788251254119` → `["fe42-a2","fe42-a1"]`, anonymous), and
`GET /users/fe42-a1` then answers `displayName: "FE42 fe42-a1"` to the same
stranger. The scoreboard does not say *which* school; what it publishes is that
these accounts exist and competed.

**It is left as it is** — D195 carries the argument — because a scoreboard
naming its competitors is what a scoreboard is for, and gating it is gating the
judge's front door. The edge worth a future slot's attention is named there: a
pupil **seeded** by an organiser (`POST /contests/{key}/participants`) never
opted into that publication, and a 2 000-pupil round is one uncapped response.

### 2.4 D192's residual, measured

The brief asked for a number, and it is larger than the ruling assumed. One
ordinary account, one session, **never sending a cursor**:

| | requests | distinct accounts | elapsed | walk budget spent |
| --- | --- | --- | --- | --- |
| `q` = each of `a–z0–9` | 36 | 320 of 482 | 0.12 s | **0** |
| refined whenever a page came back full | **576** | **482 of 482** | **1.5 s** | **0** |
| the metered path, for comparison | 20/hour | ≤2 000 rows/hour | one hour | 20 |

So the honest description of the meter is **attribution and forensics, not a
volume bound** — which is exactly what D188 claimed of its gate and what D192
claimed of its residual, now with the number attached. The same mechanism
applies to `GET /orgs/{slug}/members?q=` for a signed-in non-member (same
`nameSearchWhere`, same 100-row page, unmetered); it could not be *measured* at
scale here because the largest roster on this host is five members, so the
`/users` figure is the honest proxy and is stated as one. **Not closed**: D192
rules it open on purpose and the brief says so.

---

## 3. The derived column — `contest_participations.ends_at`

### 3.1 The writer/reader table (B-32's method)

`ends_at` is maintained by two **database** triggers, so the writer question is
not "which module remembers" but "which path can reach the table without firing
a trigger". Both are enumerated.

| Writer of a participation | Site | Fires `contest_participations_ends_at`? |
| --- | --- | --- |
| join / virtual entry (individual) | `contest.access.ts:1384` (`join`) | yes — `BEFORE INSERT` |
| team entry, and `seedParticipant` which delegates to it | `contest.access.ts:1582` (`enterTeam`) | yes |
| disqualification | `contest.access.ts:1854` (`setDisqualified`) | yes — `BEFORE UPDATE` (no window change, but recomputed anyway) |
| the 0048 backfill | migration | n/a — it *is* the backfill |
| every fixture in the suite (raw insert) | `test/**` | yes — the reason D194 chose a trigger over a module |
| `scripts/cleanup-test-data.ts:726` | delete | n/a |
| contest **clone** | `contest.access.ts:935` | copies problems and orgs, **not** participations — nothing to maintain |
| contest **delete** | FK `on delete cascade` | rows go away |
| rejudge | touches `submissions` / `grading_jobs` only | no participation write — confirmed |

| Writer of a contest window | Site | Fires `contests_participation_ends_at`? |
| --- | --- | --- |
| create | `contest.access.ts:865` | INSERT — no participations exist yet |
| clone | `contest.access.ts:970` | INSERT — same |
| edit (D38 leaves all three columns editable after the gun) | `contest.access.ts:1199` | **yes**, and this is the half that is easy to forget |
| `rating.service.ts:84` (`isRated`) | UPDATE | not one of the three columns; the `WHEN` clause correctly declines |

| Reader | Reads | Note |
| --- | --- | --- |
| `contestWindowOpenWhere` (D49 statistics) | **the column** | the only column reader in the product |
| `frozenSubmissionsWhere` (D22/D23) | the `CASE` | deliberate — D194 kept the emitted bytes so `submission-freeze.spec.ts` still tests what it names |
| `upcomingContests` (`progress.access.ts`) | the `CASE` | D194 declined to make it sargable; nothing measured says it needs to be |
| `scripts/integrity-check.ts` | both, as an audit | `participation-ends-at-drifted`, `participation-ends-at-unwritten` |

The rewrite is semantically identical: the old form applied `at < (CASE)` after
a three-table join, the new one is `participation_id IN (SELECT id … WHERE
ends_at > at)`. `contest_submissions.participation_id` is `NOT NULL` with a
foreign key, so the two select the same rows, and `at < endsAt` ≡ `endsAt > at`.

### 3.2 The live recomputation

Read-only over `podman exec … psql`, recomputing the `CASE` from `contests`
independently of the stored column, over **every** participation:

```
 total | mismatched | epoch_sentinels | spectators | live | virtual
-------+------------+-----------------+------------+------+---------
   341 |          0 |               0 |          0 |  339 |       2
```

**No disagreement. No live visibility bug today.** And the audit script, which
asks the same question a second way plus 25 others:

```
ok   [high] participation-ends-at-drifted: 0
ok   [high] participation-ends-at-unwritten: 0

27 checks, 0 with violations (high 0, medium 0, low 0)
```

D194's brief item "consider adding the check to `scripts/integrity-check.ts`"
is **already done** — 0048 shipped both checks — so this slot ran it rather
than adding a third.

**The honest half.** This host has **0 spectator** rows and **2 virtual** rows,
so the live comparison exercises one branch of a three-branch `CASE`. The other
two are covered by §3.3's scratch battery and by
`apps/api/test/participation-ends-at.spec.ts`.

### 3.3 Does the trigger survive a bulk update?

A throwaway Postgres 16 container, migrated to 0048, seeded with the shapes the
live host lacks (a spectator, a live entrant, two virtual entrants, a contest
with and one without `time_limit_seconds`), then every bulk path the brief
named. `drift` recomputes the `CASE` for every row; `sentinels` counts
`'epoch'`.

| | drift | sentinels |
| --- | --- | --- |
| T1 plain `INSERT` (live entrant) | 0 | 0 |
| T2 all four `virtual` shapes across two contests, 9 rows | 0 | 0 |
| T3 `UPDATE contests SET end_time = end_time + '45 min'` (2 rows) | 0 | 0 |
| T4 `UPDATE contests SET start_time = …, time_limit_seconds = 1800` — **every contest, one statement** | 0 | 0 |
| T5 `UPDATE contests SET end_time = end_time` (no-op; the `WHEN` clause declines) | 0 | 0 |
| T6 `UPDATE contest_participations SET virtual = 5, start_time = …` | 0 | 0 |
| T7 `UPDATE contest_participations SET ends_at = 'epoch'` — **a writer setting the column to a lie** | 0 | 0 (the `BEFORE` trigger overwrites it) |
| T9 **`COPY contest_participations … FROM STDIN`** | 0 | 0 (`COPY` fires row triggers) |
| T10 the same insert **under `SET session_replication_role = replica`** | **1** | **1** |

**The one path that does not maintain it is `session_replication_role =
replica`** — equivalently `ALTER TABLE … DISABLE TRIGGER`, and equivalently
`pg_restore --disable-triggers`. `scripts/restore.sh` does **not** pass that
flag, and it restores a *full* `pg_dump -Fc` archive in which `ends_at` is an
ordinary dumped column and both triggers are post-data objects — so a restore
lands the correct values verbatim whether or not the triggers exist yet. The
hazard is therefore latent rather than live, it is the only one, and it is
exactly what `participation-ends-at-unwritten` is for: T10 left a sentinel the
audit finds. That is D168's argument holding up under a deliberate attack.

`COPY` was the interesting one and it is safe: Postgres fires `FOR EACH ROW
BEFORE INSERT` triggers on `COPY`, and T9 shows the recomputed instant landing.
A migration that touches `contests` is covered too, because migrations run as
an ordinary session — T4 is that case.

---

## 4. Verification

Full `@duckoj/api` suite, `nice -n 19`, `--no-file-parallelism`, one
container-backed spec at a time:

```
 Test Files  154 passed (154)
      Tests  1288 passed (1288)
   Duration  843.64s (transform 2.66s, setup 0ms, collect 150.14s, tests 650.49s, environment 36ms, prepare 8.43s)
```

Plus the live audit reproduced in §3.2 (`27 checks, 0 with violations`) and
the red demonstrations quoted in §1.

Nothing else was touched: the change is four files in `apps/api` (one new
source file, one line and one import in `app.setup.ts`, one new spec, one new
pass in `route-fuzz.spec.ts`) and no workspace dependency was added, so the
image manifests are unaffected — `dockerfile-manifest.spec.ts` runs inside the
suite above.

---

## 5. What was not finished

- **The roster `q`-sweep could not be measured at province scale.** The largest
  organization on this host has five members, so §2.4's figure is `GET /users`
  and the roster case is argued from the shared `nameSearchWhere` rather than
  measured. Seeding a five-thousand-pupil school is a write to the live
  database and was not done.
- **`GET /orgs/{slug}/teams` for a signed-in non-member of a *public* school**
  answers `200 {items:[]}` here, but every organization on this host that
  actually has teams is `private` (and correctly 404s), so the filter itself is
  unproven against live data. `team-list-order.spec.ts` covers it in the suite;
  it is named here because the live probe could not.
- **The seeded-participant edge in §2.3 is recorded, not resolved.** Whether an
  organiser seeding a pupil into a public contest should publish that pupil's
  name on an anonymous scoreboard is a question about `POST
  /contests/{key}/participants`, and it is a ruling for a human.
- **`b35-probe-1788313721`** (id 487) is a live row created to measure the
  meter, together with 22 `rate_events` under `user:487` (20 `user_walk`, 2
  `refused:user_walk`). It was **left in place**, and the naming is a genuine
  miss worth flagging rather than hiding: `scripts/cleanup-test-data.ts`'s
  D153 allow-list matches `^bh[0-9]+` for a bug-hunt slot, and this account was
  minted `b35-…`, which **matches no pattern in that script**. Deleting it by
  hand is a write to the live database, which this brief forbids; the
  sanctioned fix is a one-line `{ kind: 'user', regex: '^b35-' }` in
  `PATTERNS`, or a rename convention next slot. Nothing else was created.
