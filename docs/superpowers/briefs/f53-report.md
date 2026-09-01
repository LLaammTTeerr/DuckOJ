# F-53 — The same ruling, on the rosters that carry the same risk

**Status**: done. The ruling is **D191**: a public organization's roster stays
readable without a session, but an **anonymous caller gets one page — no
`nextCursor`, and `cursor` and `q` both 401** — and a signed-in **non-member's**
walk spends **D188's own budget**, not a second one. **D192** rules `GET
/contests` (and `GET /orgs`) unchanged, with the argument, and gives this slot's
verdict on F-52's residual. **D193 was not needed and is not used.** No
migration: **0048 is still unconsumed**.

Nothing pushed. `podman-compose`, `scripts/compose-up.sh` and
`scripts/deploy.sh` were never run and **no container was started, stopped or
restarted**. **`apps/web/dist` was never written and no `vite build` ran** (the
root `verify` script, which contains one, was never invoked). Nothing under
`.secrets/` was read, printed or committed. The live database received **no
queries**: every live measurement below is an anonymous HTTP `GET` through the
edge at `007540a`. **No rows were written to the live judge**, so there is no
D153 inventory to account for and nothing to delete.

---

## Commits

| | |
| --- | --- |
| `3c3ff10` | `feat(api,contracts,sdk)` — a public roster is a page, not a walk (D191) |
| `25ef54f` | `fix(web)` — the trimmed roster is said, and a 429 stops calling itself a missing school |
| `aa55f17` | `docs(D191,D192)` — the ruling, its alternatives, and the verdict on F-52's residual |
| `6a3069a` | `fix(api)` — the full suite's collateral, and the order of 401, 422 and 429 (D191) |
| *(this commit)* | `docs(f53)` — the brief and this report |

`HEAD` before the slot was `007540a`.

---

## 1. The caller inventory, per list

Enumerated, not assumed — it is what the ruling turns on, and it is why D188's
answer could not simply be repeated.

### `GET /orgs/{slug}/members`

| Caller | Sends | Signed in? |
| --- | --- | --- |
| `OrgPage`'s roster — `apps/web/src/routes/orgs.tsx:803` | a page, `q`, and `cursor` through "load more" | **not necessarily** |
| `MemberFinder` — `apps/web/src/routes/teams.tsx:313` | `q` only, never a cursor | yes — org staff, on a team form |
| `apps/mcp` | — | **no reference to `/orgs` at all** |
| `apps/oj` (CLI) | — | **no reference** |
| `scripts/rehearsal.ts:354` | `POST .../members`, not this read | yes |
| `problem-set.access.ts`'s progress grid | pages the same roster on its **own** route | that route is **401** |

**The discriminating fact, checked rather than assumed**: `router.tsx` registers
`/orgs/$slug` with **no `beforeLoad` and no guard anywhere in `apps/web/src`**,
so a stranger loads a public school's page today — roster, search box and "load
more" included. That is a legitimate anonymous reader, which `GET /users` never
had, and D56 makes `public` a deliberate setting rather than an oversight.

The neighbours were re-measured with the same anonymous curl instead of being
assumed from F-52's table:

```
GET /api/v1/orgs/probe-org/teams              -> 401
GET /api/v1/orgs/probe-org/sets               -> 401
GET /api/v1/orgs/probe-org/sets/x/progress    -> 401
GET /api/v1/orgs/probe-org/requests           -> 401
```

So **this roster was the only anonymous read of a list of people left on the
judge**, and closing it closes the class.

### `GET /contests`

| Caller | Anonymous? |
| --- | --- |
| the web `/contests` list | **yes, by design** — a judge's front door |
| `apps/mcp` `contests_list` (`contests:read`) | token-bearing |
| `apps/oj` | signed in |

---

## 2. The ruling, and what it costs a legitimate reader

**D191.** An anonymous caller gets a **page**: `nextCursor` is always `null` for
them, and `cursor` or `q` is **401 `authentication_required`** — the same
refusal `GET /submissions` and `GET /users` answer, never a 403 (this is a read)
and never a silently truncated page (D187's exact sin).

**`q` is refused for the same reason `cursor` is, not as an extra.** D185's
search matches a **word prefix** of the folded username or display name, so a
caller who cannot advance can still reconstitute a whole roster by iterating
prefixes. Closing the cursor alone would have been theatre — and that is
demonstrated red below, not asserted.

**The trim is `nextCursor`, and that is the brief's tension answered.** The
brief asked whether trimming the payload could serve both sides. It can, but the
field that mattered was never `displayName` or `joinedAt`: every column here is
already public one row at a time (`GET /users/{username}`), D185 added
`displayName` precisely so a roster minted by a bulk import is readable by the
teacher who has to use it, and D122's initials are computed from it. Trimming
those costs the legitimate reader everything and closes nothing, because **the
disclosure was the bulk** and `nextCursor` is what made the bulk reachable. So
the page still shows who is in the school and stops being a machine-readable
list of every pupil.

**No smaller anonymous page.** A smaller `limit` for anonymous callers would
have to be a silent trim (D187 again) or a 422 refusing a limit the contract
advertises, and it buys nothing: one fixed, non-advancing page defeats
exhaustion at any page size.

**The cost, stated plainly.** A signed-out visitor loses the roster's search box
and its "load more" on a public school's page, and is told so in both languages.
They keep the school, its name, its description, its contests and the first page
of its members. Nothing signed-in changes for anybody with standing in the
school. **No caller in the product breaks**: `MemberFinder` is org staff, the
MCP server and the CLI do not touch this route, and the progress grid rides a
route that was already 401.

**And the honest limit of the claim.** Registration is open (metered per IP by
D26), so a determined party can make an account and walk twenty pages an hour
with a name attached. The yield is **attribution and revocability**, exactly as
D188's was — not impossibility.

## 3. The meter — D188's, reused rather than rebuilt

`USER_WALK_PURPOSE`, `USER_WALK_LIMIT` and `USER_WALK_WINDOW_MS` moved to
**`apps/api/src/authz/walk.meter.ts`** and are **re-exported from
`user.access.ts` unchanged**, so `user-list-enumeration.spec.ts` imports from
where D188 put them and `GET /users` behaves identically. Both routes now spend
**one window, under one key** (`user:<id>`, never an address), refuse with one
code (`user_walk_rate_limited`, `Retry-After` in whole seconds, D47 marker), and
use D16's split so a refused request records nothing and the window drains.

Two budgets were tried and demonstrated red: they hand a caller who has
exhausted the directory **twenty more pages of every school in the province** —
the same sweep with one extra step in it.

**Members of the organization and global admins are exempt.** This is the half
that keeps the ruling honest. The import contract advertises a 5 000-pupil
school; at 25 rows a page that is **two hundred presses of "load more"**, and
metering the teacher at twenty pages an hour is D16's self-lockout on a real
screen — the failure D188 refused to buy on the admin lookup, bought here
instead. A caller with no standing in the school has no such page to render.

**The residual that creates, named**: on an `open` organization a harvester can
join and become exempt. Accepted — appearing on the roster is attribution of the
strongest kind available, and removal revokes it.

## 4. `GET /contests` — measured, argued, and left alone (D192)

`146 contests in 2 anonymous requests` at `limit=100`, reproduced live today.
Structurally the same walk, and put through D188's three questions rather than
waved past:

- **Who reads it**: the anonymous web list, MCP's `contests_list`, the CLI. A
  list of upcoming rounds a visitor must sign in to see is a judge nobody can
  enter.
- **What should anonymous get**: all of it. **The rows are events, not people.**
  `ContestSummary` is a key, a name, a window, a format and the orgs a round is
  restricted to — facts a contest exists in order to publish. Private contests
  are excluded by `contest.visibility.ts` before the page is built, and D56's org
  restriction governs who may **join**, not who may look.
- **What is metered**: nothing, and nothing should be. The harm D188 and D191
  bound is bulk disclosure of *people*; metering a walk that discloses none
  would cost the MCP tool and the front page for no privacy at all.

`GET /orgs` gets the same verdict and is recorded in D192 rather than as its own
decision: 27 rows in one request, and the rows are **institutions advertising
themselves** — D186 rebuilt that list's cursor alphabetically *for* the province
reader looking a school up by name. It is what makes D191 honest: the school
stays findable, its pupils stop being downloadable.

## 5. F-52's residual — the verdict, not a shrug

> a signed-in account can still harvest up to `limit` rows per distinct `q`
> without touching the walk budget.

**It stays open on `GET /users`, and it does not stay open on the roster. The
line is attribution, not volume.**

On `/users`, every searcher is now a named, revocable principal (D188), so the
residual is a thing an account *did* — recorded in `rate_events`, reversible.
Closing it needs a search meter, which costs the admin lookup its box (a
keystroke-driven field with no debounce) for a bound a determined caller beats
by varying `q` anyway.

On the roster it was **not** attributable at all: the searcher could be **nobody
at all**, and prefix-iteration over a folded word index is a complete roster
download with no cursor in sight. So this slot **closes it there** — anonymous
`q` is 401 — and leaves it exactly where D188 left it on `/users`. The residual
narrowed rather than being re-argued.

## 6. Before and after

**Before — anonymous, live, through the edge at `007540a`** (the brief's own
measurement, reproduced):

```
GET /api/v1/orgs?limit=100                     -> 27 orgs, ALL public, 1 request
GET /api/v1/orgs/probe-org/members?limit=100   -> 200; username, displayName, role, joinedAt
walk every public org's roster                 -> 80 distinct pupils, 28 requests
GET /api/v1/orgs/probe-org/members?q=probe     -> 200, 2 rows, anonymously
GET /api/v1/contests (walked)                  -> 146 contests, 2 requests
```

**After — in vitest, and only in vitest.** The deployed API is `007540a`; this
slot may neither deploy nor restart a container, so **no live "after" is claimed**
and none was taken. `apps/api/test/org-roster-enumeration.spec.ts` is the after:
anonymous page one served with `nextCursor: null` while a signed-in reader on the
same page is handed one; anonymous `cursor` and anonymous `q` both 401; a private
org still 404; a signed-in stranger refused at the budget with `Retry-After` and
a D47 marker; the budget shared with `GET /users`; a member paging past it
untouched; forty searches spending nothing; two accounts behind one NAT address
each getting a whole window.

## 7. Demonstrated red

The first five were measured against the spec's first **eight** tests; the
ninth — and the sixth row — was added after the full api suite caught collateral
two targeted runs could not (§9).

| Change | Red |
| --- | --- |
| the true pre-D191 shape (`return this.rosterOf(row.id, query)`) | **5 of 8** |
| anonymous `cursor` closed but anonymous **`q` left open** | **1 of 8** — the prefix-iteration hole, exactly |
| the meter with **no member exemption** | **1 of 8** — the teacher locked out of their own school |
| an **address-keyed** meter, as a NAT'd room sees it | **2 of 8** |
| a **second, parallel** roster budget instead of D188's | **3 of 8** |
| the cursor parsed **after** the meter instead of before it | **1 of 9** — 429 where the sibling lists all say 422 |
| `headlineKey` without its 429 case | **1 of 25** (web) — the 429 says "Không có tổ chức này" |
| the signed-out notice and hidden search box removed | **1 of 25** (web) |

## 8. What the FULL suite caught that the targeted runs did not

`CLAUDE.md` warns that the blast radius is wider than the diff, and it was:
`apps/api/test/org-writes.spec.ts` went **2 red** on a full run after six
targeted specs were green. Both failures called
`service.listMembers(null, …)` — passing `null` because it was the shortest
thing to write, not because the anonymous case was what they meant. One is
about keyset paging, the other about cursor validation.

That forced a real ordering decision rather than a mechanical test edit:

- **An anonymous caller meets the 401 before the cursor is parsed.** They may
  not send one at all, so answering "yours is malformed" would imply a
  well-formed one would have worked. This is also what `GET /users` does — its
  guard 401s before any parsing — so the two routes agree.
- **A signed-in caller meets 422 `invalid_cursor` before the 429**, which is
  D188's ordering said again: a malformed cursor is a *mistake*, not a walk,
  and gets the same answer the identical mistake gets on every sibling list —
  even from a caller who has spent their whole budget. `parseMemberCursor` is
  therefore called in `listMembers` before the meter is consulted.

Both orderings are now pinned: the ninth test in
`org-roster-enumeration.spec.ts` (422 at the wall) and a second assertion in
the updated `org-writes.spec.ts` (401 for the anonymous malformed cursor). The
two updated tests were given a real actor, deliberately, with the reason in the
diff.

One efficiency finding fixed in the same commit: `metered` originally called
`roleIn` on **every** signed-in request. The roster search box fires per
keystroke, so that was a SELECT per keypress added to a method whose own
comment brags about answering a page in one query. `query.cursor !== undefined`
now short-circuits it — a request that cannot be metered no longer pays to find
that out.

## 9. The web, where F-52 needed nothing

D188 recorded "no web change was needed" as a *finding*. Here the finding goes
the other way, and all three consequences were required:

1. **The trimmed state is said** (D187). `OrgPage` hides the search box from a
   signed-out visitor — a control that always 401s is worse than no control —
   and prints `org.rosterSignedOut` in **both catalogues** (D18). Without it a
   5 000-pupil school reads as a school of twenty-five.
2. **429 gets a sentence** (D145). `headlineKey` in `states.tsx` had **no case
   for 429**, so a refused walk fell through to the caller's own fallback and
   told a teacher **"Không có tổ chức này."** — this file's own bug (1),
   reappearing on a new status. `common.tooManyRequests`, both languages; not
   retryable, and the sentence *is* the next move.
3. **The roster query had no error state at all** (D144). `org.error` got a
   `LoadError`; a failing `members` query — including a `fetchNextPage` the
   meter refuses — vanished silently, and the empty state then said "Không thấy
   thành viên nào", a claim about the school the server never answered. Now a
   `LoadError` **below** the table, so a refused "load more" keeps the pages
   already loaded rather than punishing the reader for the meter.

---

## Verification

| Package | Result |
| --- | --- |
| `@duckoj/api` | **`Test Files 151 passed (151)` / `Tests 1283 passed (1283)`** |
| `@duckoj/web` | **`Test Files 75 passed (75)` / `Tests 792 passed (792)`** |
| `@duckoj/contracts` | **`Test Files 9 passed (9)` / `Tests 39 passed (39)`** |
| `@duckoj/sdk` | **`Test Files 1 passed (1)` / `Tests 2 passed (2)`** |

`@duckoj/db` and `@duckoj/judged` were **not** run: neither was touched. No
column, no migration, no schema change — the meter rides `rate_events`, whose
`purpose` column is plain text by design, and **0048 is still unconsumed**
(journal checked).

`typecheck` and `lint` clean for all four, **run separately** — a passing `tsc`
is not a passing `eslint`.

Cross-cutting guards `CLAUDE.md` names, run rather than reasoned about:

- `apps/api/test/dockerfile-manifest.spec.ts` — inside the api suite above.
  **No workspace dependency was added**: `walk.meter.ts` lives in `apps/api`
  beside the code that already imported `RateLimiter`, and **no app's
  `package.json` changed** (`git diff HEAD -- '*package.json'` is empty).
- `scripts/verify-csp-hash.ts` — **`verify:csp OK`**.
- `route-marker-coverage.spec.ts` and `authz-default.spec.ts` — green, and run
  explicitly as well as inside the suite. **No marker changed**: `GET
  /orgs/{slug}/members` keeps `@Public()` + `@RequireScope('orgs:read')` and the
  new 401 comes from the service, which is why the anonymous first page survives
  at all.

`openapi.json` and `packages/sdk/src/generated.ts` were regenerated and
committed, then **regenerated once more and `git diff --exit-code` confirmed
byte-identical** to what is committed.

**No Playwright, and the reason is structural.** The edge serves
`apps/web/dist` built at `007540a`; this slot may neither write that directory
nor run `vite build`, so a browser walk would exercise the OLD bundle and prove
nothing about the three web changes. More to the point, **no live "after" is
claimable at all**: the deployed API is `007540a` and this slot may not deploy
or restart a container. The anonymous curls in §6 are the *before*, measured
against the real host; vitest is the *after*.

---

## Housekeeping

- **No live writes.** The live database received no queries from this slot;
  every measurement is an anonymous HTTP `GET` through the edge. No D153-named
  rows were created, nothing to delete, no scratch database made or dropped.
- `graphify update .` run after the code settled: 9 685 nodes, 16 659 edges,
  713 communities. `graphify-out/` is gitignored, so nothing from it is staged.
- No process left running and no leaked Testcontainers. `podman ps` shows the
  **six** long-lived DuckOJ stack containers; the two `midasium-*` containers
  belong to another project on this host and were never touched.
- **The same observation F-52 reported, reported again rather than buried**:
  `duckoj_api_1` shows a much shorter uptime than its neighbours (~36 minutes
  mid-slot, against 44 h for caddy and 2 days for postgres). It was **not**
  restarted here — the only podman command issued in this entire slot was
  `podman ps`, never `start`, `stop`, `restart`, `compose` or a deploy script.
  Something outside this slot cycles it.
- `docs/DECISIONS.md` gained **D191** and **D192**. **D193 was not needed and is
  not used.**
