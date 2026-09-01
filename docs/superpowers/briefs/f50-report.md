# F-50 — The six lists that cannot reach page two

**Status**: done. **All eight pieces of work closed** — the six cursor-dropping
surfaces D178 indicted, D179's unbounded list, and D178's second item (the
teams panel's N+1). Nothing deferred.

Nothing pushed. The deployed edge is still `5150b08`; none of this slot's
commits is on it. `podman-compose`, `scripts/compose-up.sh` and
`scripts/deploy.sh` were never run and **no container was started, stopped or
restarted**. **`apps/web/dist` was never written and no `vite build` ran.**
Nothing under `.secrets/` was read, printed or committed. The live judge was
touched only with **anonymous public `GET`s** — no write, no `.secrets`, no
database connection at all — so **D153 owes nothing and there is no live
artefact to delete**.

---

## Commits

| | |
| --- | --- |
| `ee4e533` | `fix(web)` — an admin can rate contest #26, because the rating table stops dropping the cursor (D180) |
| `81d904a` | `fix(web)` — the contest list reaches all 167 rounds, and can be asked for the one that is on (D180) |
| `4e5f742` | `fix(web)` — the schools list, a school's rounds, its homework and the org picker all reach past page one (D180) |
| `c17fc79` | `feat(api,web)` — a school's join queue answers a page, and keeps its FIFO order (D181) |
| `94e0838` | `perf(api,web)` — a page of teams carries its rosters, and the comment that argued against it is gone (D182) |
| `ab480ca` | `docs(D180,D181,D182)` — six screens, one missing bound, and the N+1 built against its own comment |
| *(this commit)* | `docs(f50)` — the report |

`HEAD` before the slot was `5150b08`.

---

## The seven items, and the eighth

The brief ranks the work; this is the accounting.

| # | Item | Closed | How |
| --- | --- | --- | --- |
| 1 | `admin.tsx` `RateContests` — **blocks a write** | **yes** | `useInfiniteQuery` + `common.loadMore`, order kept |
| 2 | `contests.tsx` `ContestsPage` | **yes** | load-more **and** `?phase=`, which D151 built and no page asked for |
| 3 | `orgs.tsx` `OrgsPage` | **yes** | load-more; order kept, name-order named as a follow-up |
| 4a | `orgs.tsx` `OrgContests` | **yes** | load-more, with the `org` filter carried on every page |
| 4b | `problem-sets.tsx` `OrgSets` | **yes** | load-more |
| 4c | `org-picker.tsx` at 101 | **yes** | **not** a button — the cursor is walked to exhaustion |
| 5 | `GET /orgs/{slug}/requests` — no bound at all (D179) | **yes** | `PaginationQuery` + `asc(id)` cursor, FIFO kept, contract regenerated |
| 6 | The teams panel's N+1 (D178's second item) | **yes** | `members` on `TeamSummary`; the stale comment rewritten |

### 1. What an operator had to do instead, until now

`RateContests` is the only screen in the app that can rate a round, it showed
the oldest twenty-five of **167**, and `limit` cannot rescue it —
`PaginationQuery` caps at 100. So contests #26 to #167 had **no Rate button
anywhere an administrator could reach**.

The route is `@SessionOnly()`, so a personal access token is refused by the
guard: the only credential it accepts is the browser session cookie. That left
two ways round it, and both are worse than they sound.

1. **Hand-issue the POST from devtools** on the judge's own origin, with the
   contest key read out of a contest URL — the session cookie and the D82
   `Origin` check are both satisfied by being on the page. This works, and it
   is the whole of the product's answer for 142 of its 167 rounds.
2. **Flip `contests.is_rated` in the database.** This does *not* run the
   replay, so it records a rating state the rating history contradicts —
   `scripts/integrity-check.ts` has an audit (`rating-event-on-unrated-contest`)
   for exactly that shape.

### 2. Why `contests.tsx` got the filter *and* the pages

D178 offered `phase=active` as the cheaper thing. On its own it trades one
truncation for another — the archive becomes unreachable instead of the recent
rounds — and load-more on its own leaves a reader paging through 2023 to find
this Saturday. Both, therefore: the unfiltered id-ordered list stays the
default and now walks, and `?phase=` is a deep-linkable `<select>`.

The load-bearing detail is that **`phase` is part of the query key**. A
`phase` page is ordered by start time with D151's composite `<millis>_<id>`
cursor; the unfiltered page's cursor is a bare id. One key for both carries
one grammar's cursor into the other's seek — D177's mismatched seek, which
truncates a walk silently and cannot be seen from page one. The spec asserts
both the composite passing through unchanged and the walk restarting with no
cursor when the filter changes.

### 4c. Why the picker is the one that did NOT get a button

`org-picker.tsx` asked for one page of 100 and stopped, with a comment calling
that deliberate. The comment answers the wrong question: `GET /orgs` serves
every organization **visible** to the caller, not the ones they own, and
`mine` is filtered out of that page afterwards. A setter owning exactly one
school loses it the moment the judge's 101st organization sorts ahead of it,
and a checkbox that is simply absent gives no sign — no scroll position, no
empty state, no button. A form control has to offer the whole option set at
the moment it is read, so the cursor is walked to exhaustion inside the query,
bounded by `PICKER_MAX_PAGES = 500`.

---

## Ordering: who reads it, and what order they need

The brief asked for this per list, and D177's precedent is that ordering is a
separate question from reachability. **No order changed anywhere in this
slot.**

| Surface | Who reads it | Order they need | Changed? |
| --- | --- | --- | --- |
| `RateContests` | an admin working a rating backlog | oldest-unrated first | no — `asc(id)` already is that |
| `contests.tsx` | someone browsing the judge's rounds | creation order, with a filter for "now" | no — the filter answers "now" |
| `OrgsPage` | someone looking for their own school | **by name** | **no — a real gap, named below** |
| `OrgContests` | a visitor reading a school's noticeboard | top to bottom | no |
| `OrgSets` | a pupil reading a course in sequence | oldest first | no |
| org picker | a setter ticking their own schools | any — the whole set is offered | no |
| join queue | a decider answering the front of a queue | **oldest first** | no — and D177's argument deliberately does not transfer |

`OrgsPage` is the one where the reader's order genuinely is not the served
order. Fixing it means a second cursor grammar over `organizations.slug` plus
the search box F-49 argued for on the org roster. At 28 schools, reachable is
the whole of today's defect; the name-ordered list is named as a follow-up
rather than smuggled in behind a load-more button.

---

## Reproduced on the live judge today

Anonymous public `GET`s against the edge at `5150b08`, walked with
`limit=100`. These are the visible-to-anonymous counts; D178's 167 and 28 are
the totals including private rows.

```
GET /api/v1/contests               → 136 contests, 2 pages of 100
GET /api/v1/contests?phase=active  →   1 contest,  1 page
GET /api/v1/orgs                   →  26 organizations, 1 page
```

At the app's default page of 25: the contest list served **25 of 136** and the
schools list **25 of 26**, each with a `nextCursor` the screen threw away.
And the filter the contest list never asked for answers the whole question in
**one row**.

---

## The N+1, built (D182)

`TeamSummary` carries `members`. `membersByTeam` **replaces** `memberCounts` —
the same `IN` over the same index, answering the rows instead of `count(*)` —
so the widening costs **no extra query at all**, and `memberCount` is now
`members.length`, which is what makes the count and the roster incapable of
disagreeing.

F-49's measurement, which is what this closes:

| | Before | After |
| --- | --- | --- |
| HTTP requests to render one screen of 25 teams | **26** | **1** |
| statements | **181** | 6 |
| database time | **≈20 ms** | **0.175 ms** |

**The comment is rewritten, not deleted.** It argued that widening "would make
a page of twenty teams a page of sixty usernames nobody asked for" while the
panel asked for every one of those sixty usernames one request at a time; it
now says why widening won, with the numbers. A comment explaining why not to
do the thing the code just did is how the next reader gets misled — which is
what happened here between F-42 and F-49.

A failure mode disappeared with the request: there is no "members could not be
read" state any more, because there is no second request to fail.
`teams.membersError` and `teams.memberCount` were deleted from **both**
catalogues rather than left as strings nothing renders, and
`teams-read-errors.spec.tsx`'s case for that path was replaced by the property
that removed it.

---

## Verification

Every new assertion was demonstrated **red** first.

| Spec | Cases | Red how |
| --- | --- | --- |
| `apps/web/test/admin.spec.tsx` | 3 new | dropped cursor; and the D145 case red on the old "no contests yet" fall-through |
| `apps/web/test/contests.spec.tsx` | 3 new | `getNextPageParam: () => undefined` reds two walks; a **shared query key** reds both filter cases |
| `apps/web/test/orgs.spec.tsx` | 3 new | dropped cursor |
| `apps/web/test/problem-sets.spec.tsx` | 1 new | dropped cursor |
| `apps/web/test/contest-orgs.spec.tsx` | 1 new | walk broken after one page |
| `apps/api/test/org-requests-page.spec.ts` | 4 new | unbounded response reds 3 of 4 (60 rows for 25, one page for three); `lt` under `asc` reds the walk at 2 pages instead of 3 |
| `apps/api/test/team-list-order.spec.ts` | 1 new | an empty `members` on the summary |
| `apps/web/test/teams-read-errors.spec.tsx` | 1 rewritten | a re-introduced per-row query |

`teams-roster-refresh.spec.tsx`'s two existing cases were not rewritten as
assertions, but their fixtures were: the names a teacher sees after a save now
flow through the SUMMARY, so those two cases pin the new path rather than the
old one. They were not re-demonstrated red and no claim is made that they
would be.

**Full suites of every package touched**, `nice -n 19` and
`--no-file-parallelism` throughout:

| Package | Result |
| --- | --- |
| `@duckoj/api` | **`Test Files  147 passed (147)` / `Tests  1255 passed (1255)`** |
| `@duckoj/web` | **`Test Files  72 passed (72)` / `Tests  781 passed (781)`** |
| `@duckoj/contracts` | **`Test Files  9 passed (9)` / `Tests  39 passed (39)`** |
| `@duckoj/sdk` | **`Test Files  1 passed (1)` / `Tests  2 passed (2)`** |

`typecheck` and `lint` clean for all four, run separately — a passing `tsc` is
not a passing `eslint`. `openapi.json` and `packages/sdk/src/generated.ts`
were regenerated from **both** contract changes and committed with them.

### No Playwright walk, and why — checked, not assumed

The brief says the teams fix is on the edge so a walk can prove this slot
green. It cannot, and the reason is structural rather than about F-49's
particular commit.

`apps/web/playwright.config.ts` points at `http://localhost:8080` — the
**composed stack**, serving the bundle in `apps/web/dist`. Six of this slot's
eight items are web-only, and the two that touch the API are served by a
container running the deployed build. Putting any of this behind a browser
would need either `vite build` (**forbidden**: "never write to
`apps/web/dist`, do not run the web build") or a container restart
(**forbidden**), and the config's own escape hatch — `E2E_BASE_URL` at
`:4321` against a `vite preview` — is that same forbidden build. So a walk
could only ever show these fixes red, which is F-49's position exactly.

What was done instead is the honest substitute: the defect reproduced against
the live edge with anonymous `GET`s (above), and every fix pinned by a spec
that drives the real component and asserts the cursor that actually went out
on the wire.

---

## What was NOT done

Deliberately out of scope, per the brief: `contestWindowOpenWhere` (D49),
registration's account-existence oracle (D26), roster freezing (D99), and the
`GET /users?q=` search box with zero callers.

Named as follow-ups by this slot, with the reasoning in D180:

1. **`GET /orgs` ordered by name**, so a reader can find their own school
   rather than walk to it. Needs a second cursor grammar over
   `organizations.slug`.
2. **A search box on the org roster**, wired to `GET /users?q=`'s existing
   server-side prefix match — still F-49's biggest single win, and still a
   feature rather than a correction.
3. **The two silent caps D178 recorded and this slot did not touch**:
   `progress.tsx`'s rating history stops at 100 with no button, and `GET
   /notifications` is a fixed 50 rows with no cursor and no "there is more"
   signal. Both are benign today and neither is one of the seven.

## Housekeeping

- The live database was never connected to. The live judge received
  **anonymous public `GET`s only** — no write, so no D153-named artefact
  exists to delete.
- No scratch database was created; F-49's `f49_scratch` figures were reused
  rather than re-derived, and the live counts above were taken through the
  public API.
- No process left running.
