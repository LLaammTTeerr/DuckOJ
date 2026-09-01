# F-49 — Every paginated list an organiser touches, and the count at which it breaks

**Status**: done. Nineteen lists swept, **every one given a number**. One
fixed end to end (`GET /orgs/{slug}/teams`, API and web, **D177**); six
recorded as indicted and deferred with the count and the live figure beside
each (**D178**); one recorded as the only list in the codebase with no bound
at all (**D179**). **Seven** lists checked and found **healthy** — which is a
row too, and the sweep's other real finding is that **no list in this codebase
can skip or repeat a row**: every cursor matches its order exactly.

Nothing pushed. The deployed edge is still `925f27a`; none of this slot's
commits is on it. `podman-compose`, `scripts/compose-up.sh` and
`scripts/deploy.sh` were never run and **no container was started, stopped or
restarted**. **`apps/web/dist` was never written and no `vite build` ran.**
Nothing under `.secrets/` was read, printed or committed. The live database
received **`SELECT` and `EXPLAIN` only** — no row was written, so D153 owes
nothing and there is no live artefact to delete.

---

## Commits

| | |
| --- | --- |
| `695650f` | `fix(api)` — a school's teams are listed newest first, and the cursor walks backwards with them (D177) |
| `be67161` | `fix(web)` — the teams panel can reach page two, because it stops dropping the cursor (D177) |
| `f6f08db` | `docs(D177,D178,D179)` — nineteen lists, the count each becomes unusable at, and the N+1 measured against its own comment |
| `3996f7b` | `docs(f49)` — the suite counts this report was written before it had |
| *(this commit)* | `docs(f49)` — the commit table, and D178's statement count said per screen |

`HEAD` before the slot was `cc69b3e` (the orchestrator's ledger commit, which
landed on top of `925f27a` while this slot was orienting).

---

## How the numbers were obtained

Two databases, F-44's method reused rather than reinvented.

- **`duckoj`, live, read-only.** Every "live today" figure below is a
  `SELECT count(*)` against the deployed database on 2026-09-02: **28
  organizations, 65 teams (46 of them in one school), 167 contests, 446
  users, 110 org members, 22 problem sets, 1 pending join request.**
- **`f49_scratch`, created and dropped inside this slot.** Schema `pg_dump`ed
  from `duckoj`, then grown to a province: **400 schools, 25 000 accounts,
  29 339 org memberships, 12 370 teams, 37 110 team memberships, 61 850 team
  contest participations, 3 000 rounds, 3 200 homework sets, 20 000 sessions**,
  plus one late-joining school whose rows all sit at the tail of `teams_pkey`
  and one school holding 5 000 pending join requests. `VACUUM (ANALYZE)`
  before every measurement. Dropped at the end of the slot.

Timings are from a thermally-capped 16-core host and are **not** a capacity
figure — the plan shape is the finding. **No load test was run.**

**Two rows of the table were also reproduced against the deployed edge**, with
a plain public `GET` and nothing else:

```
GET /api/v1/contests   → items: 25, nextCursor: "25",
                         first e2e-contest-1787326579768 (2026-08-21),
                         last  e2e-p5-1788098680309      (2026-08-30)
GET /api/v1/orgs       → items: 25, nextCursor: "53"
```

167 contests exist; the front page serves the 25 oldest and hands out a cursor
the web app throws away. That is the defect, on the live judge, today.

`GET /orgs/{slug}/teams`' statement was checked against what drizzle actually
emits: `team-list-order.spec.ts` drives the real controller over HTTP against
a container, and the hand-issued `EXPLAIN`s below use the same predicate,
column list and order the service builds. The one thing the plans decided —
that no index is warranted — does not depend on a transcription detail; both
directions are sub-millisecond at province size.

---

## The table

**"Unusable at N"** means: the count at which a reader can no longer get to a
row they have every right to see. It is not "the page size".

### The organiser's own surfaces

| # | List | Ordered by | Is that the reader's order? | Page | Page two reachable? | Filter / search | **Unusable at** | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `GET /orgs/{slug}/teams` | ~~`asc(id)`~~ → **`desc(id)`** | ~~no~~ → **yes** | 25 | ~~**no**~~ → **yes** (D177) | none | ~~**26**~~ → ∞ | **FIXED (D177).** Live today: one school has 46 teams and the panel showed the oldest 25 |
| 2 | `GET /contests` — `admin.tsx` `RateContests` | `asc(id)`, oldest | **no** | 25 | **no** | none | **26** | **worst row in the sweep.** Live today **167 contests**: an admin cannot rate or unrate #26+ *at all*. The only one that blocks a WRITE. `limit=100` does not save it — 167 > the schema max |
| 3 | `GET /contests` — `contests.tsx` | `asc(id)`, oldest | **no** | 25 | **no** | none in the UI (the API has `phase`, `mine`, `org`) | **26** | **142 rounds unreachable today.** D151 built `phase=active` for exactly this reader and the list page never asks for it |
| 4 | `GET /orgs` — `orgs.tsx` | `asc(id)` | no | 25 | **no** | none | **26** | **3 schools already unreachable today** (28 orgs) |
| 5 | `GET /orgs` — `org-picker.tsx` | `asc(id)` | no | **100** (asked for) | **no** | none | **101** | the school switcher stops at 101. Not urgent at 28; monotonic |
| 6 | `GET /contests?org=` — `orgs.tsx` `OrgContests` | `asc(id)` | no | 25 | **no** | none | **26** | a school's 26th round is invisible on its own page |
| 7 | `GET /orgs/{slug}/sets` — `problem-sets.tsx` `OrgSets` | `asc(id)` | no | 25 | **no** | none | **26** | homework set #26 invisible to the class. Same shape as row 1, deliberately not fixed |
| 8 | `GET /orgs/{slug}/members` | `asc(username)` | **yes** — a roster is looked up by name | 25 | **yes** | **none** | **~400** | pages correctly; there is no way to *find* a pupil. The org-import contract advertises a 5 000-pupil roster = **200 presses of "load more"** |
| 9 | `GET /orgs/{slug}/requests` | `asc(id)` — **correct**, a queue is FIFO | **no limit at all** | n/a | n/a | none | **the response, not the page** | **D179.** 5 000 pending → 219 kB of JSON and 5 000 `<tr>` in one DOM. Statement itself healthy (2.6 ms) |
| 10 | admin user list | — | — | — | — | — | — | **there is no such screen.** `GET /users?q=` is fully built server-side (prefix match, `%`/`_` escaped) and has **zero callers**. An admin reaches an account only by typing its exact username into a free-text box |

### The lists that were checked and are fine

| # | List | Ordered by | Page | Page two | Filter / search | **Unusable at** | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 11 | `GET /problems` | `asc(id)` | 25 | **yes** | search box, tag checkboxes, difficulty range, per-viewer status (D35/D125) | — | **healthy — the best-built list in the app.** `asc(id)` is right here: a catalogue is browsed, not tailed, and every filter is deep-linkable |
| 12 | `GET /submissions` | `desc(id)` | 25 | **yes** | problem, user, contest, verdict | — | **healthy.** Newest first with an `lt` seek — the shape D177 gave the teams list. The only list in the app with a real D136 card fallback |
| 13 | `GET /problems/{code}/comments` | `asc(id)` | 25 | **yes** | none | — | **healthy, and D112's bound still holds.** Threads read oldest-first, which is what a discussion is. Replies are fetched whole per page — the ceiling on top-level rows is what bounds the fan-out, exactly as D112 says |
| 14 | `GET /users/{u}/rating` — `user.tsx` | `asc(end_time, id)` composite | **100** | **yes** | none | — | **healthy.** A rating curve is read left to right; the composite cursor is why two divisions ending on one bell cannot lose a row |
| 15 | `GET /users/{u}/rating` — `progress.tsx` | same | 100 | **no** — the infinite query has no button | none | **101 rated contests** | **watch.** Benign today, silent when it stops being |
| 16 | `GET /orgs/{slug}/sets/{s}/progress` | `asc(username)` | 25 | **yes** | `format=csv` escape hatch, cap 20 000 rows with `truncated` | — | **healthy.** The one list that already answers "the page is not the whole answer" out loud |
| 17 | `GET /notifications` | `desc(id)` | **fixed 50, no cursor** | n/a | none | **51** | **watch.** Newest-first is right; the 51st notification is gone with **no signal at all**. Compare row 18, which does this properly |
| 18 | `GET /contests/{key}/clarifications` | `desc(id)` | **200 + `truncated`** | n/a | none | 200, **and it says so** | **healthy.** The pattern rows 9 and 17 should copy |
| 19 | `GET /users/me/teams` | `asc(org name, team name, id)` | **yes** — a picker is scanned by name | **200 + `truncated`** | n/a | `?contest=` eligibility | 200, **and it says so** | **healthy.** Deliberately unpaged (D99/F-25); alphabetical is right for a `<select>`, where D177's newest-first would be wrong |

### One verdict that covers the whole sweep

**Every cursor in this codebase matches its order exactly.** Eleven
cursor-paginated endpoints, nine parse helpers, and not one single-column
cursor sitting over a non-unique order key. The two composite orders
(`(start_time, id)` for `phase`-filtered contests, `(end_time, id)` for rating
history) both carry composite cursors, and the one non-id cursor (username)
sits over a column with a unique index. `GET /problems` even keeps D109-hidden
rows *in* `items` (blanked) so the walk position stays true, and the comment
list cursors on the last row **examined** rather than the last row displayed,
so a deleted comment cannot make the next page skip.

**No list in this codebase can skip or repeat a row.** That was the failure
mode the brief warned about — "a paginated list that drops a row is worse than
one in an awkward order" — and the sweep found none. The defects are all
reachability and order, never correctness.

---

## What was fixed, and what the cursor costs (D177)

`GET /orgs/{slug}/teams` now orders `desc(teams.id)` and seeks with `lt`. The
web panel is `useInfiniteQuery` + the existing `common.loadMore` button.

**The cursor cost, stated as the brief asked.** `teams.id` is unique and
monotonic, so `desc` + `lt` is the *same* stable keyset `asc` + `gt` was: no
tiebreak, and no row can be skipped or repeated. **`created_at` was refused**
— it reads identically to a human, it is **not** unique (a roster imported in
one `INSERT` shares an instant to the microsecond), and it would have needed
D151's composite `millis_id` cursor to be safe. A second cursor grammar, for
no gain over the id.

**One residual, accepted and written into D177.** Both grammars are a bare
`teams.id`, so a cursor issued before the deploy parses and walks the other
way. Cursors here are in-flight state — the UI holds them in a mounted
`useInfiniteQuery` and never writes one to a URL, a bookmark or storage — so
the window is the moment between a deploy and the reader's next click.
Inventing a version prefix would refuse a cursor that is arithmetically fine.
Checked, not assumed: `apps/web/src/router.tsx` mentions `cursor` in **no**
`validateSearch`, so no list in this app deep-links one.

### The plans, and the index that was refused

On `f49_scratch` (12 370 teams, 400 schools), one page of 26 rows:

| Case | Plan | Buffers / ms |
| --- | --- | --- |
| **before**, `asc(id)`, a school with 400 teams | `Index Scan using teams_pkey`, **Rows Removed by Filter: 9 975** | 152 / 0.78 |
| **after**, `desc(id)`, same school | `Index Scan Backward using teams_pkey` | **3 / 0.035** |
| **before**, `asc(id)`, a school with 30 teams | `Bitmap Index Scan on teams_org_slug_lower_idx` → sort | 38 / 0.32 |
| **after**, `desc(id)`, same school | same bitmap + sort, `Sort Key: id DESC` | 32 / 0.08 |
| **after**, a school that joined the province late (all its rows at the tail) | same bitmap + sort | 8 / 0.08 |

**No index. Refused, with the reason.** `teams` carries only `teams_pkey` and
`teams_org_slug_lower_idx (org_id, lower(slug))`, and the planner switches
between a backward pkey walk and a bitmap-plus-sort on that second index
depending on how big the school is relative to the province. Both are
sub-millisecond; the worst plan measured in either direction was 152 buffers.
A `teams(org_id, id)` index would make the direction irrelevant and buys
nothing at this size — it earns its bytes only if one school ever holds a
large enough fraction of `teams` for the pkey walk to be chosen *and* its rows
sit far from the walk's start.

**This is a product fix, not a performance fix.** Saying so is the point: the
brief asked whether `asc(id)` was a defect, and the answer is that it was a
perfectly sound engineering choice with a wrong product consequence.

---

## The second item — one detail request per row, measured

The panel served a `memberCount` on the summary and fired `GET
/orgs/{slug}/teams/{teamSlug}` **once per row** to print the names. The
comment in `teams.tsx` argued against widening the summary: it would make "a
page of twenty teams a page of sixty usernames nobody asked for".

**Measured, the comment is wrong on its own terms — the panel asks for every
one of those sixty usernames, one HTTP request at a time.**

One screen of 25 rows, on `f49_scratch`:

| Statement (per detail request) | Plan | Buffers / ms |
| --- | --- | --- |
| session resolve (once per HTTP request) | `sessions_token_hash_idx` → `users_pkey` | 6 / 0.070 |
| `findVisibleOrgRow` | `Seq Scan organizations` (400 rows), member subplan never executed | 1 / 0.172 |
| `roleOf` | `org_members_org_id_user_id_pk` | 7 / 0.095 |
| `findTeam` | `teams_org_slug_lower_idx` → `organizations_pkey` | 5 / 0.057 |
| `membersOf` | `team_members_..._pk` → `users_pkey`, sort | 15 / 0.118 |
| `contestsOf` | `contest_participations_team_idx` → `contests_pkey` → `users_pkey` | 40 / 0.201 |
| `teamEditVersion` (D176) | `teams_pkey` + `string_agg` over the roster | 15 / 0.088 |
| **per detail** | **7 statements** | **89 / 0.801** |

| | Today | The one-statement alternative |
| --- | --- | --- |
| HTTP requests to render one screen | **26** | 1 |
| statements | **181** | 6 |
| database time | **≈20 ms** | **0.175 ms** |
| buffers | ≈2 225 | 279 |

The alternative is `select … from team_members join users where team_id in
(25 ids) order by team_id, username` — `Index Only Scan` + nested loop,
**279 buffers, 0.175 ms**, which is the same shape `memberCounts` already
issues for that page (51 buffers, 0.050 ms).

**Verdict: worth widening the summary after all — and not done in this slot.**
The reasons, in order:

1. The payload the comment defends is **~2.3 kB of names the page displays
   anyway**. It is not "nobody asked for"; it is asked for 25 times.
2. Every one of those 25 responses also carries a `contests` array and a D176
   `version` token **the panel throws away**. The N+1 moves *more* bytes than
   the widening, not fewer.
3. The blast radius is small and was checked: `TeamSummary` feeds exactly
   three schemas — `TeamPage`, `TeamDetail` (which already `extend`s it with
   `members`), and `MyTeamSummary`, whose route is capped at
   `MY_TEAMS_LIMIT`. **No scoreboard shape.** `memberCount` becomes derivable.
4. It is **not** done here because it would be the third rework of one panel
   in one slot, it changes a public response shape, and the members-error path
   has its own tests (`teams-read-errors.spec.tsx`). It is an hour's work,
   fully specified in D178.

**What is fine as it stands**: `memberCounts` and `teamsInRunningContest` are
already one query for the whole page, never one per row, and the plans confirm
it. The N+1 is the *names*, and only the names.

---

## Fixes proposed and NOT made, ranked

Recorded in D178 and D179 with the numbers. In the order a province operator
should take them:

1. **`admin.tsx` `RateContests` reaches page two.** Write-blocking today at
   167 contests. Cheapest correct form is the `phase`/`org` filter D151
   already built, or the cursor; a bigger `limit` cannot work (167 > 100).
2. **`contests.tsx` surfaces `phase=active`.** D151 built the filter for this
   exact reader and the list page never asks for it. Cheaper than pagination
   and answers the question a contest list is opened with.
3. **`GET /orgs/{slug}/requests` gains `PaginationQuery` + an `asc(id)`
   cursor** (D179). Keep the FIFO order — D177's newest-first argument does
   **not** transfer to a queue.
4. **Load-more on `OrgsPage`, `OrgSets`, `OrgContests`** — the same twelve
   lines D177 put in `teams.tsx`, three more times.
5. **A search box on the org roster**, wired to `GET /users?q=`'s existing
   server-side prefix match. This is the biggest of the five and the one that
   makes a 5 000-pupil school workable rather than merely walkable.

Deliberately **not** started, as the brief instructed: `contestWindowOpenWhere`
(D49's anti-join, still F-44's named follow-up), registration's
account-existence oracle (D26), team roster freezing (D99).

---

## Verification

Every new assertion was demonstrated **red** first.

- `apps/api/test/team-list-order.spec.ts` — **4 passed.** Sixty teams, the
  whole walk collected through its own `nextCursor` and checked for gaps and
  repeats, both page sizes, and four refused cursors. Red three ways:
  restoring `asc`+`gt` reds the newest-first assertions
  (`expected 'doi-01' to be 'doi-vua-lap'`); `desc`+`gt` — the mismatched-seek
  failure, invisible from page one — reds the walk at **2 pages instead of 3**
  and 2 instead of 9; both are in the commit message.
- `apps/web/test/teams-load-more.spec.tsx` — **2 passed.** Asserts the second
  request carries the **first page's cursor** (a button that re-asks page one
  is the bug wearing the fix's clothes) and that both pages are on screen at
  once. Red with `getNextPageParam: () => undefined`, which is the old
  behaviour exactly: `Unable to find role="button"`.
- **Full suites of every package touched**, `nice -n 19` and
  `--no-file-parallelism` throughout:

  | Package | Result |
  | --- | --- |
  | `@duckoj/api` | **`Test Files  146 passed (146)` / `Tests  1250 passed (1250)`** |
  | `@duckoj/web` | **`Test Files  72 passed (72)` / `Tests  770 passed (770)`** |
  | `@duckoj/contracts` | **`Test Files  9 passed (9)` / `Tests  39 passed (39)`** |
  | `@duckoj/sdk` | **`Test Files  1 passed (1)` / `Tests  2 passed (2)`** |

  `openapi.json` and `packages/sdk/src/generated.ts` were regenerated from the
  contract change and committed with it.
- `typecheck` and `lint` clean for `@duckoj/api`, `@duckoj/web`,
  `@duckoj/contracts` and `@duckoj/sdk` — lint separately, because a passing
  `tsc` is not a passing `eslint`.
- **No e2e was added.** Playwright points at the live edge deployed at
  `925f27a`, which predates both commits, so a walk could only ever show this
  fix red. `apps/web/e2e/organiser.spec.ts` is the walk whose own history
  produced this slot; it is untouched.

---

## Housekeeping

- `f49_scratch` **dropped**; the container's `/tmp/f49_*.sql` files deleted.
- The live database was read with `SELECT` and `EXPLAIN` only. **No live row
  was written**, so there is no D153-named artefact to delete.
- No process left running.
