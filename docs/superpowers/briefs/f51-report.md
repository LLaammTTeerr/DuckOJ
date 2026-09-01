# F-51 — Finding a person, and a school

**Status**: done. All four items closed — the search F-49 named and F-50
deferred (**D185**), `GET /orgs` served in its reader's order (**D186**), both
of D178's silent caps (**D187**), and the organiser walk's team accumulation
fixed at its source and proven on the live host.

Nothing pushed. The deployed edge is still `b8701f4`; none of this slot's
commits is on it. `podman-compose`, `scripts/compose-up.sh` and
`scripts/deploy.sh` were never run and **no container was started, stopped or
restarted**. **`apps/web/dist` was never written and no `vite build` ran**
(and the root `verify` script, which contains one, was never invoked).
Nothing under `.secrets/` was read, printed or committed. The live database
received **`SELECT` and `EXPLAIN` only**; the live judge received the
organiser walk's ordinary API writes, all D153-named, accounted for below.

---

## Commits

| | |
| --- | --- |
| `6cff13f` | `feat(api,db)` — a teacher types `nguyen` and finds `Nguyễn` (D185) |
| `c5d7f59` | `feat(web)` — three screens where a person can now be found by name (D185) |
| `531ad81` | `fix(api)` — a province finds its school by name, not by when it registered (D186) |
| `ee30f86` | `fix(api,web)` — two caps a reader could not see, answered differently (D187) |
| `b5f0829` | `test(e2e)` — the organiser walk keeps two teams instead of leaving two more |
| `767e239` | `docs(D185,D186,D187)` |
| `f672670` | `fix(db,api)` — 0047 is re-runnable, and the fold column is pinned server-side |
| *(this commit)* | `docs(f51)` — the brief, the report, and the measured figures corrected to the live count of 461 |

`HEAD` before the slot was `b8701f4`.

---

## 1. The diacritics ruling, and the test that proves it

**A teacher types `nguyen` and finds `Nguyễn`. The fold is applied to BOTH
sides.**

Vietnamese carries a diacritic on nearly every syllable and is typed, most of
the time, without any of them. A search that made the reader reproduce the
accents answers only for people who already know how the row was spelled —
which is nobody who needs to search. So `nguyen`, `Nguyễn` and `NGUYEN` are
one query, and `do` finds `Đỗ`.

**The second half of the ruling is the WORD prefix.** Vietnamese puts the
family name first and the given name last, and a person is addressed and
looked for by the last word: *Nguyễn Văn An* is "An" to their teacher. A
whole-string prefix cannot find him — and, because the haystack begins with
the username, cannot even find `Nguyễn`. It is deliberately not a substring
match either: `%an%` returns every *Hoàng*, *Lan*, *Thanh* and *Trang* in a
province.

### How it is built

`searchFold()` in `packages/db/src/schema/identity.ts` is the **one**
definition. `users.search_fold` (migration 0047, a stored generated column) is
produced by it, and the needle every search builds is folded by the same
function, so a typed name and the row it should find cannot be folded
differently. Four steps: `lower()`, `normalize(…, NFD)`, strip
`U+0300–U+036F`, `translate`.

- Step 2 is what peels the **two** marks Vietnamese stacks on one vowel (`ế`
  is `e` + circumflex + acute; `ữ` is `u` + horn + tilde), and step 3's range
  covers both, horn (`U+031B`) and breve (`U+0306`) included.
- Step 4 exists because **`đ` has no decomposition at all** — a letter with a
  stroke, not a letter with a mark. NFD leaves it exactly as it was, so
  without a hand-written mapping every Đỗ, Đặng and Đình in the province is
  unfindable from a keyboard that cannot type it. It also turns `-`, `_` and
  `.` into spaces, which is what makes `nguyen` find `gv-nguyen-van-an`.
- The character class is written `[\u0300-\u036f]`, not as the marks
  themselves: a combining mark in source is invisible and a reviewer cannot
  tell a correct range from a mangled one by looking at it.

**`unaccent` was refused, and not on taste.** The extension is not installed —
live `pg_extension` holds `plpgsql` and nothing else — and, decisively,
`unaccent(text)` is **STABLE** (its dictionary is a file on disk), so it may
not appear in a generated column and may not be indexed. `normalize()` is
`IMMUTABLE` and ships with Postgres, so no extension is needed at all and
migration 0047 adds none.

### The proof

`apps/api/test/user-search-diacritics.spec.ts` — **8 passed**, every fixture a
real Vietnamese name, over HTTP against a real Postgres because the fold is a
stored column and a unit test of a TypeScript function would prove nothing
about it.

| Case | Asserts |
| --- | --- |
| `nguyen` / `Nguyễn` / `NGUYEN` | all three answer `Nguyễn Văn An`, `Nguyễn Thị Bình` and `gv-nguyen-van-an` |
| `an` | finds *Nguyễn Văn An* by the **given name**, and NOT `Hoàng Thị Lan`, `Lê Ngọc Trang`, `Trần Thanh Hà` |
| `do` / `dinh` / `uoc` | `Đỗ Hữu Ước`, `Phạm Đình Dũng`, `Đỗ Hữu Ước` |
| `%`, `%nguyen`, `_` | nothing — characters a person typed, not wildcards |
| roster `?q=nguyen` | the matched rows **with the `displayName` that matched** |
| roster paging | the walk carries `q` on every page; the page that forgets it is a different list |
| roster, private school | 404 for a stranger, search or no search |
| disclosure | `?q=` carries exactly the keys the unfiltered list carries; no `email`, `status`, hash or `search_fold`; anonymous and signed-in results identical |

**Demonstrated red three ways**, all in the commit message:

| Change | Red |
| --- | --- |
| unfolded string prefix (the pre-D185 shape) | **6 of 7** |
| folded, but whole-string prefix | **5** — `nguyen` finds *nothing*, because the haystack starts with the username |
| substring match | **2** — `an` drags in Hoàng/Lan/Thanh/Trang, and `%` matches the whole table |
| the fold column served on the wire | **1** — `the user list must not contain searchFold` |

### The numbers, and the index that was refused

The fold is five function calls per row, so the worst case a search has is a
query matching **nothing** — which is what every typo is — because it must
examine every row and pay for all of them. On `f51_scratch`: 25 000 accounts,
400 schools, 30 000 memberships, one school of 5 000 pupils, `VACUUM
(ANALYZE)` before every measurement.

| | per-row fold | stored column |
| --- | --- | --- |
| global `GET /users?q=`, no match | **172 ms** | **4.2 ms** |
| one 5 000-pupil school's roster, no match | **22 ms** | **5.5 ms** |
| the same roster, a three-word query | **40 ms** | **5.5 ms** |

**A third number was nearly missed.** Every figure above was first measured
with the needle inlined as a literal, which the planner constant-folds. In
production `q` is a bind parameter and postgres.js prepares its statements, so
once Postgres settles on a **generic** plan the fold-and-escape is
re-evaluated per row again. Under `plan_cache_mode = force_generic_plan`:

```
inline, generic plan          47.9 ms
wrapped in a scalar subquery   7.8 ms
```

`nameSearchWhere` carries those parentheses — a scalar subquery over no table
becomes an InitPlan, run exactly once — and a comment saying so. Removing them
is a six-fold regression no test would notice and no plan printed from a
literal would show.

**A `pg_trgm` GIN index was measured and refused, in D177's shape.** It takes
the global no-match case to **0.26 ms** and does **nothing at all** for the
roster search — **5.7 ms against 5.5 ms** — because that plan is driven by
`org_members` and probes `users` by primary key, and the roster is the surface
that actually carries a province. Against that it costs an extension the
database does not have, **1.3 MB on a 3.6 MB table**, and write amplification
on D61's five-thousand-row account imports.

### One comment that was wrong

`UserListQuery` said prefix was chosen over substring because "the existing
`users_username_lower_idx` serves a prefix directly". It does not. An `ILIKE`
prefix cannot use a b-tree index at all unless the pattern starts with a
non-alphabetic character, and the `OR` across two columns rules one out
regardless. On the **live** database:

```
username ILIKE 'ng%'        -> Seq Scan on users, Rows Removed by Filter: 461
lower(username) LIKE 'ng%'  -> Seq Scan on users, Rows Removed by Filter: 461
```

The plan never changed; only the comment was wrong. It is replaced with the
EXPLAIN, in both the contract and the service.

---

## 2. The surfaces that got search, and the ones that did not

| Surface | Search? | Endpoint, and the argument |
| --- | --- | --- |
| **Org roster** (`orgs.tsx`) | **yes** | `GET /orgs/{slug}/members?q=`. F-49's biggest single win: the org-import contract advertises a 5 000-pupil roster, which was **200 presses of "load more"** to reach one pupil |
| **Team form member entry** (`teams.tsx`) | **yes** | the same roster route, scoped to that school |
| **Admin role grant and TOTP reset** (`admin.tsx`) | **yes** | `GET /users?q=` — **its first caller ever** |
| Contest participant management | **n/a** | **there is no such screen.** `contest-edit.tsx` edits a window and an org allow-list; seats are a PDF download; the scoreboard's disqualify is a button per row, and a row is not a search. Nothing to wire |
| `submissions.tsx`'s `user` box | **no** | it is an EXACT-username filter the server resolves and the router deep-links. Making it fuzzy changes what a shared URL means, and "every submission by everyone called An" is not a question anyone asks |
| `problem-edit.tsx` members | **no** | there is no member editor at all — its own comment defers it to a later phase — so there is nothing to attach a picker to |

**The authorization ruling.** `q` went on `GET /orgs/{slug}/members`, **not**
as an `org=` filter on `GET /users`. `GET /users` is `@Public()`; teaching it
about organizations would publish "who belongs to this school" — a **private**
school's roster included — through a route with no organization gate on it at
all. The roster route already runs `findVisibleOrgRow`, the same 404 gate
`GET /orgs/{slug}` uses, so the search inherits exactly the visibility the
roster already had. A spec case pins it: a stranger's `?q=nguyen` against a
private school is 404.

**D26, checked rather than assumed.** `GET /users` was already a fully
enumerable public directory **with no `q` at all** — an anonymous caller can
page every account on the judge — and D26's oracle is the **email**, never the
username: `username_taken` stays a 409 precisely because a username is public,
on every scoreboard and in every submission list. So the box discloses nothing
that was not already served, and does not undo D26. What it adds is finding an
account by DISPLAY NAME, which `GET /users/{username}` has always served
publicly one request at a time; the fold makes that cheaper to sweep.
**Precisely: this endpoint has no rate limiter and never had one** — D16
meters login and D26 meters registration, and neither is in this path. That
was true before this slot and is unchanged by it. If metering is ever wanted
here, D13's DB-backed limiter in D16's shape is what it should be; a worse
search is not.

**`OrgMember` gains `displayName`**, and it is half the feature rather than a
nicety: without it the roster is a column of `hs000123` (which is exactly what
D61's bulk import mints), and a search that matched a NAME could not show the
name it matched. It is also what D122's deterministic initials are computed
from. It discloses nothing new — `GET /users/{username}` already serves
`displayName` publicly for every account.

**The two pickers are scoped differently on purpose.** The team form searches
the SCHOOL, because every teammate must already be a member: a picker over the
whole judge would offer people the save is about to refuse, and would turn a
form on a private school's page into a directory of everyone. The admin lookup
searches the judge, because a global admin acts across every organization. The
team picker **appends through the same state setter typing uses**,
deduplicated — anything else would rebuild the silent-overwrite class D183 has
just closed.

`apps/web/test/person-search.spec.tsx` — **4 passed**, red three ways: the
request built without `q` (2 red — the server is never asked, and the empty
state claims the school is empty rather than that nothing matched), a picker
that REPLACES the box instead of appending, and the admin lookup simply
absent.

---

## 3. `GET /orgs`, and the cursor grammar (D186)

Ordered by **`lower(slug)`**, the expression `organizations_slug_lower_idx` is
built on, with `organizations.id` as the tiebreak. The cursor is
`<lower(slug)>_<id>`, seeking the same pair the order is by, written as the
explicit two-branch disjunction rather than `(a, b) > (x, y)` — a row
constructor over an *expression* is exactly the shape that stops the planner
using that index. At 400 schools: `Index Scan using
organizations_slug_lower_idx` plus an incremental sort of single-row groups,
**10 buffers / 0.14 ms**.

**`name` was refused**: not unique, no index, and a school renamed mid-walk
moves under the cursor. A slug reads as the name on this table
(`thpt-chuyen-le-hong-phong`), and `UpdateOrgRequest`'s own comment already
says a slug here is a display handle because nothing in the schema references
an organization by it.

**The tiebreak is provably unreachable today and is carried anyway.** The
index is UNIQUE and `ORG_SLUG` will not admit a slug differing from another
only by case, so `id` can never decide. It is there because it makes the OLD
grammar **distinguishable**: a bare id — `"53"`, which this route issued until
now — has no `_`, so it is refused `422 invalid_cursor` instead of being read
as a slug and walked from wherever `53` happens to sort. That is deliberately
the **opposite** of D177's accepted residual, and for the opposite reason:
there both grammars were the same bare `teams.id` and were arithmetically
interchangeable, so refusing one would have refused a cursor that was fine.
Here the grammar changed shape, and a stale cursor read under the new order is
a silently wrong page. The split is on the LAST `_`, because `ORG_SLUG` admits
`_`; `abc_1_5` is the slug `abc_1` at id `5`, unambiguous because the id half
is digits and nothing else.

`apps/api/test/org-list-order.spec.ts` — **3 passed**. Forty schools whose
alphabetical order is the **reverse** of their id order (a fixture where the
two orders agreed would prove nothing), the whole walk collected through its
own `nextCursor` at two page sizes and checked for gaps and repeats, plus six
refused cursors. **Red three ways**, D177's discipline copied exactly:

| Change | Red |
| --- | --- |
| `asc(id)` restored | **3 of 3** |
| an id seek left under a slug order — the mismatched seek | the walk truncates: **6 pages become 2** |
| a bare-slug cursor with no tiebreak | the stale id cursor is accepted silently |

The web side changed by not changing: F-50's `OrgsPage` and `org-picker.tsx`
already pass `nextCursor` back opaquely, which is what a cursor is for. The
only test that had to move was the one asserting the cursor's bytes.

---

## 4. The two silent caps (D187) — argued per list

**The rating curve is WALKED.** `progress.tsx` built the history as a
`useInfiniteQuery` and rendered no "load more" anywhere, so it served a pupil's
first 100 rated contests. It is worse than a truncated list, and that is the
argument: the history ascends by time and the page reads its **headline
rating** off the last row *loaded*, so past a hundred rounds it printed the
rating held at contest #100 as the rating today — a wrong number, not a short
list — under a sparkline that stopped there with no visible end.

A button is the wrong shape for a **chart**: a graph behind a press gives its
reader no reason to press, and a headline number behind a press is simply
wrong until pressed. `org-picker.tsx` made that argument about a form control
and reached the same answer, so the cursor is walked to exhaustion inside the
query, bounded at `RATING_MAX_PAGES = 20` (2 000 rated rounds) at the
endpoint's own maximum page of 100 — the fewest requests the whole history can
be had in. A failure on page four rejects the whole query rather than being
served as though it were the answer.

**`user.tsx` keeps its button and is right to.** Same endpoint, different
reader: it renders a TABLE of rounds, one page is a legible answer, and its
headline rating comes from the profile rather than from the last row on
screen. F-49's row 14 called it healthy; it still is.

**The notification feed KEEPS its cap and now says so.** `truncated` on
`NotificationList`, answered by fetching `FEED_LIMIT + 1` so one query decides
it rather than a second COUNT that could disagree, plus one muted line under
the table in both catalogues. Paging was refused: a notification is acted on or
ignored within days, one press clears the whole backlog, and nothing in this
product links to a notification by id — a cursor would be a walk into an
archive nobody keeps, and the contract has said "a feed, not an archive" since
D14. The reader this is for is the one whose numbers disagreed: `unreadCount`
counts every unread row, so sixty unread showed "60" above fifty rows with
nothing to reconcile them. Same cap-plus-flag `GET
/contests/{key}/clarifications` already serves, which F-49's row 18 named as
the pattern rows 9 and 17 should copy — row 9 became D181, and this is row 17.

Red: the walk stopped after one page (the headline reads 1299 instead of
1899); the cap fetched without its extra row (`truncated` false at sixty); the
line deleted.

---

## 5. The fixtures, and what the live host holds now

`fe42-truong` held **32 teams** on 2026-09-02, growing by two every run,
because journey 2 seats its pair in a contest and **D101 rightly refuses to
delete a team that has competed** — so `test.afterAll`'s delete loop could
never reach them. It only looked as though it might. That is the same
self-inflicted failure the teardown exists to prevent (a walk whose own
history moves its row off a page of twenty-five), arriving by a door the
teardown cannot close.

**Fixed at the source, as the brief asked, and not with a bigger delete
loop.**

- `fe42-doi-a` / `fe42-doi-b` are now **stable fixtures**: get-or-created every
  run, rosters reset to a known state, never deleted. **Two forever instead of
  two more.** A per-run org was considered and refused — it trades team
  accumulation for org accumulation, and an org that has held a contest is no
  easier to delete than a team that entered one.
- Their slugs deliberately do **not** begin `fe42-alpha`/`fe42-bravo`.
  Playwright's `hasText` is a substring match and the 32 existing rows are
  slugged that way, so a stable `fe42-alpha` would select seventeen rows and
  every row lookup in the file would be ambiguous. They still match
  `^fe[0-9]+-`, so D153's inventory classifies them exactly as before.
- The **create form** and the "this team has entered no contest" assertion
  moved to `fe42-moi-<run>`, per-run because both are only true of a team that
  has just come into existence — and which the teardown *can* delete, because
  it never competes.
- The teardown now says why the pair is not in its list, so the next reader
  does not restore a delete that was always going to be refused.

**Proven on the live edge, twice, `--workers=1`**: journey 2 and 2b green both
times, and `fe42-truong` held **34 teams before and after the second run** (32
undeletable historical rows plus the two new permanent ones).

```
✓ journey 2  — a teacher assembles a team in the form, and the one-seat rule names the pupil
✓ journey 2b — the panel shows the added pupil with no reload
  2 passed
```

**What this does NOT fix, named rather than left to be re-found.** The
`fe42-*` **contests** still grow by roughly one a run (30 before this slot, 32
after the two proving runs). Journey 1's scoreboard assertions need a round
with no history — `submitted`, `accepted` and `solvers` are pinned at 4, 3 and
2 — so its contest cannot be a stable fixture, and the API has **no contest
DELETE** at all. What reaches them is `scripts/cleanup-test-data.ts`, whose
`^fe[0-9]+-` pattern already covers both the contests and (through
`fe42-truong`) the teams. The 32 historical teams are **undeletable by design**
while their contests are kept, and no attempt was made to force them.

**D153 accounting for this slot's live writes**: two `fe42-thi-doi-<run>`
contests, the two permanent `fe42-doi-*` teams, two `fe42-moi-<run>` teams
(deleted by the walk's own teardown), and the participations between them.
Everything is D153-named. The permanent pair is deliberately kept — it is the
fix. The two contests are left because the API offers no way to remove one;
the inventory sweep is what they are for.

---

## Before you deploy: migration 0047, and what the search discloses

### 1. Is 0047 safe to apply to the live host?

**Yes, and it is a sub-second stall rather than a migration to schedule around
— but it is a stall, so do not run it mid-contest.**

| | |
| --- | --- |
| What it does | one statement: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "search_fold" text GENERATED ALWAYS AS (…) STORED` |
| Index created | **none.** A `pg_trgm` GIN index was measured and refused (above); nothing else is added |
| Lock taken | **`AccessExclusiveLock` on `users`** — a STORED generated column cannot be added without rewriting the table |
| How that was established | **observed, not inferred**: the ALTER was held open in a transaction and `pg_locks` read from a second session, which reported `AccessExclusiveLock` granted on `users` |
| What that blocks | every read and write of `users` for the duration — which is every authenticated request, since session resolution reads it |
| How long, at live scale | **11.4–12.6 ms** over four runs, on a copy of the live shape: **461** rows (`select count(*) from users` on the live database today), real Vietnamese display names |
| How long, at province scale | 0.25 s on the 25 000-account copy |
| The real risk | not the 10.9 ms. It is that an `ACCESS EXCLUSIVE` request **queues behind any long transaction already holding a lock on `users`**, and everything else then queues behind *it*. Apply when the judge is not running a contest |
| Idempotent on re-run | **yes, now.** `IF NOT EXISTS` was added deliberately and verified: the second run answers `NOTICE: column "search_fold" of relation "users" already exists, skipping`, then `ALTER TABLE` |

**Why `IF NOT EXISTS` at all**, since drizzle's migrator runs each journal
entry exactly once: **D131/D133**. That entry exists because `0025` was skipped
on production and had to be re-applied by hand, and a bare `ADD COLUMN` fails
on the second attempt. Making this one re-runnable costs nothing and is the
same instinct `0041` was written with.

**The journal, checked rather than assumed:**

- `{ idx: 47, when: 1788293150651, tag: '0047_f51_search_fold' }` — both `idx`
  and `when` **strictly greater** than `0046`'s (46 / 1788270113832), which is
  what the migrator executes by;
- `0047_snapshot.json`'s `prevId` equals `0046_snapshot.json`'s `id`, so the
  chain `drizzle-kit generate` diffs against is intact;
- **42 `.sql` files, 42 journal entries, 42 snapshots** — the same set,
  exactly;
- `packages/db/test/migration-journal.spec.ts` — **`Tests 7 passed (7)`** —
  pins all of that, migrates a fresh container from zero applying every entry,
  and reproduces the 0025-skipped production state and its repair;
- and D133's guard in `runMigrations` still throws if any journal entry is
  listed but unapplied once the migrator has finished, so a 0047 that silently
  did not run cannot exit 0.

### 2. Does the fold widen disclosure?

**No. `q` changes which rows come back and never which fields, and it adds no
caller that did not already have everything.**

| | |
| --- | --- |
| `GET /users` marker | `@Public()` + `@RequireScope('users:read')` — **exactly one marker, unchanged by this slot** |
| `GET /orgs/{slug}/members` marker | `@Public()` + `@RequireScope('orgs:read')` — **unchanged**, and the service runs `findVisibleOrgRow` before it reads a single row |
| Marker guard | `apps/api/test/authz-default.spec.ts`, green in the full suite: deny-by-default, exactly one marker per route |

**`GET /users` was already a fully enumerable public directory with no `q` at
all**, and that is the load-bearing fact. Anonymously, against the live edge
today — no credential, no search term:

```
GET /api/v1/users?limit=3
  {"items":[{"id":1,"username":"system","displayName":"System","globalRole":"user",
             "country":null,"rating":null,"maxRating":null,"createdAt":"2026-08-20T…"},
            …], "nextCursor": …}
```

So `q` introduces no caller (the route was public before), no row (the whole
table was already pageable) and no field (`displayName` was already in every
row of that response, and `GET /users/{username}` has always served it
publicly). What it changes is the *order* in which those rows are reachable.

**D26 is not undone.** Its oracle is the **email**; `username_taken` is
deliberately a 409 because a username is public — on every scoreboard and in
every submission list. Nothing here answers "does this email have an account".

**Precisely, because it is the sentence worth being exact about**: this
endpoint has **no rate limiter and never had one**. D16 meters login and D26
meters registration; neither is in this path. That was true before this slot
and is unchanged by it. If metering is ever wanted here, D13's DB-backed
limiter in D16's shape is what it should be — a narrower search is not.

**The roster search is gated, and a spec case proves it.** `GET
/orgs/{slug}/members?q=` runs `findVisibleOrgRow` — the same 404 gate `GET
/orgs/{slug}` uses — *before* `q` is applied. A stranger's `?q=nguyen` against
a private school is **404**, not an empty page and not a 403.

**And the new column never reaches the wire.** `user-search-diacritics.spec.ts`
gained an eighth case: the `?q=` response must carry exactly the keys the
unfiltered response carries; neither may contain `email`, `status`, a password
hash or `search_fold`; and a signed-in caller must get byte-identical results
to an anonymous one. The first attempt to demonstrate it red — adding
`searchFold` to `PUBLIC_COLUMNS` — stayed **green**, which located the real
enforcement: `toSummary` maps each row into an explicit DTO rather than
spreading it. The assertion was moved to the serialization point, where it
reds properly (`the user list must not contain searchFold`). That is worth
recording because the guard is a mapper rather than a column list, and the
next person adding a column to `users` should know which one is load-bearing.

---

## Verification

Every new assertion was demonstrated **red** first, and the reds are in the
commit messages.

| Package | Result |
| --- | --- |
| `@duckoj/api` | **`Test Files  149 passed (149)` / `Tests  1267 passed (1267)`** |
| `@duckoj/web` | **`Test Files  75 passed (75)` / `Tests  789 passed (789)`** |
| `@duckoj/db` | **`Test Files  20 passed (20)` / `Tests  99 passed (99)`** |
| `@duckoj/contracts` | **`Test Files  9 passed (9)` / `Tests  39 passed (39)`** |
| `@duckoj/sdk` | **`Test Files  1 passed (1)` / `Tests  2 passed (2)`** |
| `@duckoj/judged` | **`Test Files  19 passed (19)` / `Tests  148 passed (148)`** |

`@duckoj/judged` is run because this slot changed `@duckoj/db`'s schema
package, which it sits on — one package further than F-49 or F-50 went.

The `@duckoj/api` run above was started at `f672670` and finished after two
later edits to `0047`'s header, both of which are text inside `--` comments
with no SQL semantics; nothing the suite executes changed between the two.

`typecheck` and `lint` clean for every one, run separately — a passing `tsc` is
not a passing `eslint`. `openapi.json` and `packages/sdk/src/generated.ts` were
regenerated from all three contract changes and committed with them.

The cross-cutting guards CLAUDE.md names were run explicitly.
**No workspace dependency was added** — `apps/api` already depended on
`@duckoj/db`, which is where `searchFold` lives, and no app's `package.json`
changed — so the image manifests cannot have gone stale; the guard was run
anyway rather than reasoned about:
`apps/api/test/dockerfile-manifest.spec.ts` (**`Tests 4 passed (4)`**) and
`scripts/verify-csp-hash.ts` (**`verify:csp OK`**).
`packages/db/test/migration-journal.spec.ts` (**`Tests 7 passed (7)`**) is what
pins migration 0047's journal entry, `.sql` file and snapshot chain, and it
migrates a fresh container from zero.

`typecheck` and `lint` were also run for `@duckoj/judged` and for
`scripts/` (`typecheck:scripts`, `lint:scripts`) — all clean — and
`openapi.json` / `packages/sdk/src/generated.ts` were regenerated one last time
and `git diff --exit-code` confirmed they are byte-identical to what is
committed. The root `verify` script was **never** run: it contains a
`vite build`.

**Playwright**: journey 2 and 2b were run twice against the live edge and are
the live proof of the fixture fix. **The search work is vitest-only, and the
reason is structural** — F-50's position, unchanged: `playwright.config.ts`
points at the composed stack serving `apps/web/dist`, and putting a new
screen behind a browser would need either `vite build` (forbidden) or a
container restart (forbidden). A walk pointed at a search box the deployed
bundle does not contain could only ever be red.

---

## Housekeeping

- **`f51_scratch` and `f51_lock` both dropped** — the province copy (25 000
  accounts, 400 schools, one 5 000-pupil school) and the 461-row copy the
  migration was timed and lock-checked on. Their SQL was written to the
  session scratchpad, never into the repository. `pg_database` holds no `f51%`
  row.
- The live database was read with `SELECT` and `EXPLAIN` only. The live judge
  received the organiser walk's ordinary API writes, all D153-named and listed
  above.
- `graphify update .` run after the code settled: 9 597 nodes, 16 510 edges,
  702 communities. `graphify-out/` is gitignored, so nothing from it is
  staged.
- No process left running. `podman ps` shows the **six** long-lived DuckOJ
  stack containers (postgres, redis, caddy, api, judge, judged) — none of them
  started, stopped or restarted by this slot — and no leaked Testcontainers.
  The two `midasium-*` containers belong to another project on this host and
  were never touched.
