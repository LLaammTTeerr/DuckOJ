# F-52 — Who may enumerate a school's children

**Status**: done. The ruling is **D188**: `GET /users` stops being an anonymous
download, and the WALK — not the search — is metered per account. **D189 and
D190 were not needed and are not used.** No migration: **0048 is still
unconsumed**.

Nothing pushed. The deployed edge is still `709d75f`; neither of this slot's
code commits is on it. `podman-compose`, `scripts/compose-up.sh` and
`scripts/deploy.sh` were never run and **no container was started, stopped or
restarted**. **`apps/web/dist` was never written and no `vite build` ran** (the
root `verify` script, which contains one, was never invoked). Nothing under
`.secrets/` was read, printed or committed. The live database received **no
queries at all** from this slot — every live measurement below is an anonymous
HTTP `GET` through the edge. **No rows were written to the live judge**, so
there is no D153 inventory to account for and nothing to delete.

---

## Commits

| | |
| --- | --- |
| `3ad6cd2` | `feat(api,contracts)` — the pupil directory is not a public download (D188) |
| `b98d462` | `docs(D188)` — the ruling, its alternatives, and the meter behind one school NAT |
| *(this commit)* | `docs(f52)` — the brief and this report |

`HEAD` before the slot was `709d75f`.

---

## 1. The caller inventory — the fact the ruling turns on

This was enumerated, not assumed, and it is the whole argument. **`GET /users`
(the list) has exactly ONE caller in the entire product.**

| Caller | Calls the list? | What it sends |
| --- | --- | --- |
| `FindAccount`, `apps/web/src/routes/admin.tsx:81` | **yes — the only one** | signed in as an admin, always `q`, **never a cursor** |
| The three person pickers F-51 shipped (`orgs.tsx`, `teams.tsx`) | no | they ride `GET /orgs/{slug}/members`, which has its own org gate |
| `apps/mcp` | **no** | its one `users:read` tool is `me_progress` → `GET /users/me/progress` |
| `apps/oj` (CLI) | **no** | it does not reference `/users` at all |
| `e2e/`, `scripts/` | **no** | no reference |
| `submissions.tsx`'s `user` box | no | an exact-username filter the server resolves; not a list |

The `findMore` line beside the admin lookup is a **hint paragraph, not a "load
more" button** — so nothing in this product has ever sent a cursor to this
endpoint.

**Three api specs did call it anonymously** and were updated deliberately, not
mechanically: `user-search-diacritics.spec.ts`, `lookup-consistency.spec.ts`,
and `users.spec.ts`. The last was **not found by grep** — it builds the request
with `.query({ q: 'alpha' })` rather than a query string — but by running the
**full** api suite, which is exactly the failure mode `CLAUDE.md` warns about.

---

## 2. The ruling, and what it costs a legitimate user

**`GET /users` loses `@Public()` and keeps `@RequireScope('users:read')`.** One
marker, so `route-marker-coverage.spec.ts` is satisfied; the refusal is
`AuthGuard`'s existing **401 `authentication_required`**, the same one `GET
/submissions` has always answered. **No 403 is introduced for a read.** Both
that spec and `authz-default.spec.ts` were **run and confirmed green**, not
reasoned about.

**Individual visibility is untouched.** `GET /users/{username}`, `/progress` and
`/rating` stay `@Public()` — a judge is a public thing, D46's rank ramp hangs off
exactly those, and a profile linked from a scoreboard must open for a stranger.
What is ruled on is **bulk**: the difference between looking a person up and
downloading the school.

**Not `@SessionOnly()`.** This is an API as well as a website, and a token
carrying `users:read` is a **named, revocable principal** — which is exactly what
an anonymous caller is not.

### The alternatives, and why they lost

| Alternative | Why not |
| --- | --- |
| **Public page, private cursor** (the brief's second option) | It leaves anonymous `q`-harvesting wide open with **no attribution** — 100 rows per query, which D185's fold just made cheap — and the page-one it preserves is one **no screen in this product renders**. It buys presentation, not privacy. |
| **Scope the list to the caller's org** | Refused on D185's own reasoning: teaching `GET /users` about organizations publishes "who belongs to this school", a private school's roster included, through a route with no organization gate. The org-scoped list already exists and is already gated — `GET /orgs/{slug}/members`, behind `findVisibleOrgRow`. |
| **Trim the fields instead** | Closes nothing. The disclosure was the bulk (see §4). |

### The cost, stated plainly

An anonymous visitor loses a directory **no page in this product displays** —
there is no `/users` screen. A scripted consumer must hold a session or a token,
and every existing one already does or does not call this route at all.

**And the honest limit of the claim**: registration is open (metered per IP by
D26), so a determined party can still make an account. The gate's real yield is
**attribution and revocability**, not impossibility. The roster stops being an
anonymous download and becomes something a named account did, recorded in
`rate_events`, revocable.

---

## 3. The meter — its key, and one school behind one NAT

**This is the part the brief called the heart of it, and it is why the gate and
the meter are one ruling rather than two.**

| | |
| --- | --- |
| Purpose | `user_walk` in `rate_events` — D13's **DB-backed** limiter, correct across all four `API_WORKERS` and deterministic under test. **Not** an in-process counter, and not a new Redis structure |
| **Key** | **`user:<id>`. The meter never sees an address at all** |
| What is counted | **only a request carrying `cursor`** |
| Limit | 20 pages per hour (`USER_WALK_LIMIT`) — one constant, a judgement, exactly as D16 says of its three |
| Refusal | **429 `user_walk_rate_limited`** with `Retry-After` in whole seconds (the header, per RFC 9110, through `AppError`'s headers bag), plus the D47 `refused:` marker |
| Accounting | D16's split — `retryAfterSeconds` then `record` — so a **refused request records nothing and the window drains**, rather than a caller pinning themselves against the wall. That is D16's own anti-lockout property, copied on purpose |
| Migration | **none.** `rate_events.purpose` is plain text by design. **0048 is still unconsumed** — the journal was checked |

### What a school behind one NAT address looks like to it

**Nothing. It is invisible to the meter, and that is the point.**

Thirty pupils in a computer room share one public address. An **IP-keyed** meter
hands that room **one budget between all thirty of them**, and the last arrivals
are refused in the middle of a contest by their classmates' ordinary use — D16's
self-lockout, generalised from one account to a whole classroom, and strictly
worse than the problem it solves.

Requiring an actor is precisely what **makes the per-account key available**:
thirty pupils behind one address are **thirty separate windows**. There is a test
for it — two accounts, both sending `X-Forwarded-For: 203.0.113.7`, each
spending a whole budget without touching the other's.

### Why only the walk is counted

A request with **no** cursor answers the same first page however often it is
asked. That is a lookup. A cursor is the **only** way to advance, so counting
cursor-bearing requests bounds a sweep *exactly* — and a search box, which never
sends one, is **structurally incapable** of spending the budget.

The alternative was metering every request, and the arithmetic kills it. The one
caller is a keystroke-driven box **with no debounce**: a ceiling low enough to
bound enumeration (say 30 per 15 min) locks an admin out halfway through typing a
name, and a ceiling high enough for the box (~300 per 15 min) still allows a
caller to harvest a hundred rows per distinct `q` underneath it. That is D16's
self-lockout risk taken on **for no bound at all**. It was also demonstrated red:
metering every request reds *"a search box can never spend the budget"*.

### The residual, named rather than papered over

A signed-in caller can still harvest up to `limit` rows per distinct `q` without
touching the walk budget. **Accepted** — it is attributable and revocable, which
the anonymous walk was not. Closing it would need a search meter, at the cost of
the admin box. It is written into D188 as an open property, not a closed one.

---

## 4. The fields, and D26

**`globalRole` and `createdAt` stay.** `UserProfile` is `UserSummary.extend(...)`,
so both are **already served one account at a time, to anyone**, by the
still-public `GET /users/{username}`. Trimming the list would fork the two DTOs
and buy nothing an attacker cannot get by naming a username they already have.
`globalRole` is a setter/admin badge the profile renders and the admin lookup
shows beside a name, which is what makes "yes, that is the person" answerable at
all. `createdAt` is a join date every judge prints. Neither is a **moderation**
fact — that is `status`, which has never been on this list.

**D26 is not undone.** Its oracle is the **email**, and nothing here answers
"does this email have an account": no email is served, `username_taken` is still
a 409 because a username is public on every scoreboard, and the new 401 is
**credential-shaped, not account-shaped** — it is identical for a caller who
names a real account and one who names nothing at all.

---

## 5. Zero web changes, verified rather than assumed

The one caller is **signed in** (so it never sees the 401) and **never sends a
cursor** (so it never sees the 429). No surface in the product can reach either
refusal, so **D145's "name the failure, offer the next move" and D18's two
catalogues have no new string to carry.** Had any surface been able to reach
either, both would have been required — this is a finding, not an omission. The
only web edit in the slot is a **comment** in `admin.tsx` that said the endpoint
behind the lookup was `@Public()`, which it no longer is.

---

## 6. Demonstrated red — four ways, and one that stayed green

| Change | Red |
| --- | --- |
| the true pre-D188 shape (`@Public()` + `@MaybeActor()`) | **2 of 15** — the anonymous walk, and D185's disclosure case |
| metering **every** request, not only the walk | **3 of 7** — including *"a search box can never spend the budget"*, which is D16's self-lockout reappearing on the one screen that uses this endpoint |
| an **address-keyed** meter, as a NAT'd room sees it | **2 of 7** — the classroom shares one budget |
| the meter absent entirely | **3 of 7** |

**A fifth attempt stayed GREEN and is worth recording**, in F-51's spirit about
the mapper: putting `@Public()` back and changing *nothing else* **does not red**,
because `@CurrentActor()` throws the same 401 when no actor was attached
(`authz-default.spec.ts` pins exactly that second layer). The route is defended
**twice**; the marker is not the whole enforcement. The real red needed
`@Public()` **and** `@MaybeActor()`. That is written into the handler's comment
so the next reader does not assume the marker is the only thing holding.

---

## 7. The neighbours — measured, reported, deliberately **not fixed**

Every figure below is one **anonymous** `GET` through the live edge today, no
cookie and no token. **None of these routes has a rate limiter**, checked in
`org.access.ts`, `problem.access.ts` and `contest.access.ts` — no `RateLimiter`
reference in any of them.

| List | Anonymous? | Cursor served? | Metered? | Measured today |
| --- | --- | --- | --- | --- |
| **`GET /orgs/{slug}/members` on a PUBLIC org** | **yes, 200** | **yes** (`nextCursor` is a username) | **no** | **the sharpest one — see below** |
| `GET /orgs` | yes, 200 | yes (`<lower(slug)>_<id>`, D186) | no | 27 orgs, **all 27 public**, in **1** request at `limit=100` |
| `GET /contests` | yes, 200 | yes (id) | no | **146 contests in 2** requests |
| `GET /problems` | yes, 200 | yes (id) | no | 54 problems in 1 request — public problems only, and a problem is not a child |
| `GET /tags` | yes, 200 | **no** — 25 rows, uncursored | no | a fixed vocabulary |
| `GET /orgs/{slug}/members` on a PRIVATE org | **404** | — | — | `findVisibleOrgRow`, correct (D185 pins it) |
| `GET /orgs/{slug}/teams` | **401** | — | — | already gated |
| `GET /submissions` | **401** | — | — | already gated |

### The sharpest neighbour, stated precisely

**`GET /orgs/{slug}/members` on a public organization is the same finding,
unfixed**, and it is the one the next slot should take:

```
GET /api/v1/orgs        -> 27 orgs, all public, one anonymous request
then one walk per org   -> 80 distinct pupils in 27 anonymous requests
```

Each row carries `username`, `displayName`, `role` and `joinedAt` — **the display
name being what F-51 added in D185, and the roster being searchable by folded
name since the same slot.** So an anonymous caller who cannot walk `GET /users`
any more can still assemble a pupil list **school by school**, and the
org-import contract advertises a **5 000-pupil** roster, so the province-scale
figure is not 80.

It was **not fixed in this slot, deliberately**, because it is a different
ruling: `GET /orgs` and the public roster are how a school advertises itself and
how F-51's three person pickers work, and gating them would break callers this
slot has no mandate over. The evidence above is what the next slot needs instead
of suspicion.

`GET /contests` at 146 rows in two anonymous requests is the same *shape* and a
much smaller stake — a contest is not a person — but it is the one other list
where a cursor walks an unbounded, growing table with nothing metering it.

---

## Verification

| Package | Result |
| --- | --- |
| `@duckoj/api` | **`Test Files 150 passed (150)` / `Tests 1274 passed (1274)`** |
| `@duckoj/web` | **`Test Files 75 passed (75)` / `Tests 789 passed (789)`** |
| `@duckoj/contracts` | **`Test Files 9 passed (9)` / `Tests 39 passed (39)`** |
| `@duckoj/sdk` | **`Test Files 1 passed (1)` / `Tests 2 passed (2)`** |

`@duckoj/db` and `@duckoj/judged` were **not** run: neither was touched. This
slot added no column, no migration and no schema change — the meter rides
`rate_events`, whose `purpose` column is plain text by design.

`typecheck` and `lint` clean for all four, **run separately** — a passing `tsc`
is not a passing `eslint`.

Cross-cutting guards `CLAUDE.md` names, run rather than reasoned about:

- `apps/api/test/dockerfile-manifest.spec.ts` — **`Tests 4 passed (4)`**. **No
  workspace dependency was added** (`RateLimiter` already lives in `apps/api`,
  and no app's `package.json` changed), so the manifests cannot have gone stale;
  the guard was run anyway.
- `scripts/verify-csp-hash.ts` — **`verify:csp OK`**.
- `apps/api/test/route-marker-coverage.spec.ts` (**3 passed**) and
  `authz-default.spec.ts` (**5 passed**) — the two that would catch a marker
  mistake, confirmed green rather than assumed.

`openapi.json` and `packages/sdk/src/generated.ts` were regenerated and
committed, then **regenerated once more and `git diff --exit-code` confirmed
byte-identical** to what is committed.

**No Playwright.** The reason is structural and is F-51's, unchanged: the edge
serves `apps/web/dist` built at `709d75f`, and the only web change here is a
comment — there is no new screen to walk. More to the point, the new refusals
**cannot be verified on the live edge at all**, because the deployed API is
`709d75f` and this slot may neither deploy nor restart a container. So the
anonymous curls in §7 and in the brief are the **"before"** evidence, measured
against the real host, and vitest is the **"after"**.

---

## Housekeeping

- **No live writes.** The live database received **no queries** from this slot;
  every measurement is an anonymous HTTP `GET` through the edge. Nothing to
  clean up, no D153-named rows created, no scratch database made or dropped.
- `graphify update .` run after the code settled: 9 642 nodes, 16 579 edges,
  706 communities. `graphify-out/` is gitignored, so nothing from it is staged.
- No process left running, and no leaked Testcontainers. `podman ps` shows the
  **six** long-lived DuckOJ stack containers (postgres, redis, caddy, api,
  judge, judged); the two `midasium-*` containers belong to another project on
  this host and were never touched.
- **One observation reported rather than buried**: `duckoj_api_1` shows an
  uptime of ~29 minutes at the end of this slot, shorter than its neighbours'.
  It was **not** restarted here. `podman inspect` reports `RestartCount 0` and
  `StartedAt 04:33:08`, which is **before this slot's first live request**
  (04:41), and the only podman commands issued in this slot were `ps`,
  `inspect` and `logs` — never `start`, `stop`, `restart`, `compose` or a
  deploy script. The stack's containers have independent uptimes generally
  (judged ~5 h, judge ~8 h, caddy ~43 h), so something outside this slot cycles
  them.
- `docs/DECISIONS.md` gained **D188** only. **D189 and D190 were not needed and
  are not used** — one ruling covered the gate, the meter and the fields, and
  splitting it would have separated the argument from its own load-bearing
  half.
