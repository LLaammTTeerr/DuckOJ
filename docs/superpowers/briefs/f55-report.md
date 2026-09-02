# F-55 — A province decides how much of a child is public

**Status**: done. The ruling is **D197**: `NAME_DISCLOSURE`, one switch with
three rungs read in one place, defaulting to the **protective** one. **D198** is
the D113-shaped source-scan guard that keeps every surface on it. **D199 was not
needed and is not used.** **One migration, `0049_f55_org_members_user_id`** —
an index, not a schema change; see §5.

Nothing pushed. `podman-compose`, `scripts/compose-up.sh` and `scripts/deploy.sh`
were never run and **no container was started, stopped or restarted**.
**`apps/web/dist` was never written and no `vite build` ran.** Nothing under
`.secrets/` was read, printed or committed. Every live measurement below is an
anonymous HTTP `GET` through the edge at `fe4ec8d`, or a read-only `SELECT`;
**no row was written to the live judge by this slot**.

---

## Commits

In order.

| | |
| --- | --- |
| `e4187af` | `perf(db)` — the question D197's default rung asks has an index (0049) |
| `2dfdd4b` | `feat(api,contracts,sdk)` — a username is an identifier, a display name is a child (D197) |
| `041dc0e` | `test(api)` — the disclosure policy has one implementation, and a scan that says so (D198) |
| `10c020e` | `fix(web)` — a profile showing a handle says so, in both languages (D197, D187) |
| `c287a25` | `fix(scripts,api)` — the cleaner's D153 patterns, and the fuzzer's shape coverage |
| `0eafdb4` | `docs(D197,D198)` — the ladder, the alternatives, and the guard |
| `4032a9d` | `docs(api,contracts)` — three D191 comments that stopped being true, and one dead export |
| *(this commit)* | `docs(f55)` — the brief and this report |

`HEAD` before the slot was `fe4ec8d`.

---

## 1. The surface inventory, and what each shows at each rung

Enumerated by **source scan and live probe**, not by memory. The scan is now a
test (`name-disclosure-guard.spec.ts`), so this table is machine-checked rather
than a snapshot.

The reader columns are the ladder's four populations: an **anonymous** stranger;
a **new account** (signed in, no organization — B-35's thirty-second registrant);
an **affiliated** reader (a role in any organization); and **authority** (a
global admin or setter, a caller a surface has already authorized over exactly
these people, or yourself).

### 1a. Surfaces that carry a person's IDENTITY — these move

| Surface | Route | Carries | `public` | `authenticated` | **`affiliated` (default)** |
| --- | --- | --- | --- | --- | --- |
| **Profile** | `GET /users/{username}` — `@Public()` | `displayName`, `about` | name + about to all | anon → **handle, `about: null`**; new account → name | anon **and** new account → **handle, `about: null`**; affiliated/authority → name |
| Directory | `GET /users` — 401 since D188 | `displayName` | name | name | new account → **handle**; affiliated/authority → name |
| **Org roster** | `GET /orgs/{slug}/members` — page one public since D191 | `displayName` | name | anon → **handle** | anon **and** new account → **handle** |
| Team rosters | `GET /orgs/{slug}/teams`, `/teams/{t}`, `/users/me/teams` — 401 | `displayName` | name | name | name (every caller holds a role in the team's org) |
| Progress grid | `GET /orgs/{slug}/sets/{s}/progress` — org staff | `displayName` | name | name | **name** — `authority` |
| Progress CSV | `…/progress.csv` — org staff | `displayName` | name | name | **name** — `authority` |
| **Results CSV** | `GET /contests/{key}/results.csv` — contest staff | `displayName` | name | name | **name** — `authority` |
| **Results PDF** | `…/results.pdf` | `displayName` | name | name | **name** — `authority` |
| **Certificates** | `…/certificates.pdf` (D71) | `displayName` | name | name | **name** — `authority` |
| **Seat slips** | `…/seats.pdf` (D129) | `displayName` | name | name | **name** — `authority` |
| Import echo | `POST /orgs/{slug}/members/import` (D61) | `displayName` | the caller's own uploaded file, returned | — | — |
| `GET /auth/me` | your own row | `displayName` | yours | yours | yours |

### 1b. Surfaces that carry only an IDENTIFIER — these do not move, and that is the finding

Every one of these was checked, and **not one of them carries a display name**.

| Surface | Carries | Why it is already compliant |
| --- | --- | --- |
| **Scoreboard** `GET /contests/{key}/scoreboard` | `ranking[].participant` — a username | The route B-35 measured. A board that names its competitors is what a board is for (D46, D192, D195). **Zero lines of code**, and `name-disclosure.spec.ts` pins it so a future row carrying a name fails there instead of on a province's host. D25's 2 s cache stays correct because the payload does not vary by reader. |
| Monitor feed `…/monitor` | `username`, `askedBy` | gated 401/403 already, and handle-only anyway |
| Clarifications `…/clarifications` | asker `username` | handle-only |
| Submissions list `GET /submissions` | `username` | handle-only |
| Problem comments `…/comments` | `author: { username }`, `null` on a tombstone | handle-only |
| Problem stats `…/stats` | `firstSolver`, `fastest` | handle-only |
| Problem detail | `members[].username` | handle-only |
| Booklet (D48) | — | no person field at all |
| WebSocket (D23) | ids and contest keys | never a name; B-35 verified this |
| `apps/mcp`, `apps/oj` | — | HTTP clients of the routes above; they inherit whatever rung the deployment is on |

**So the scoreboard leaks identifiers and the profile leaks identity, and they
get different treatment on purpose.** The switch lives at the dereference on the
end of the chain, which is where B-35 measured the harm, and the board — the
thing a judge exists to publish — is untouched.

**The `about` field is in this slot because the coordinator measured it, not
because the brief named it.** The anonymous profile carries `about` — free text
a child typed about themselves, which can hold a class, a school, a birthday or
a phone number. It is **withheld** (`null`) rather than substituted, because
unlike a name it has no stand-in that keeps a page usable.

**Half of that disclosure is latent rather than measured, and the honest
sentence is this one.** Reproducing B-35's chain against the live edge today:

```
anonymous  GET /contests?limit=100 ×2      → 159 contests
anonymous  a scoreboard for each           → 142 DISTINCT usernames
anonymous  GET /users/{username} for each  → 141 resolved
   of those, displayName ≠ username:  133
   of those, a non-empty `about`:       0
   of those, a non-null `country`:      0
```

So on this rehearsal host the **name** disclosure is measured (133 of 141) and
the `about` disclosure is a property of the route rather than of its current
rows: nobody here has filled the field in. On a province's host, where a pupil
is invited to write about themselves, it is the same route with content in it.
The policy covers it because of what the field is, not because of what this
host happens to hold.

**What does NOT move, argued rather than overlooked**: `country`, `rating`,
`maxRating`, `globalRole`, `createdAt`, `stats`. A self-declared country is one
of two hundred coarse values that identifies nobody on a host where every
account is in one province; the rest are the numbers a judge exists to publish
and D46's rank ramp hangs off exactly them. D188 made the same call on the same
fields.

---

## 2. The default, and why it is that one

**`affiliated`.** An operator who reads nothing and sets nothing gets it, and
`.env.example` and `docker-compose.yml` both pass the variable through empty so
that "sets nothing" is a configuration the parser survives rather than a boot
crash (F-40's lesson; see §5).

The argument against the softer rung is a number this campaign measured itself.
Registration is open — **D26 meters it, it does not gate it** — and B-35 took
**482 of 482 accounts in 576 requests and 1.5 seconds** from one ordinary
session, spending zero walk budget. `authenticated` as a default would mean the
protective behaviour ends at "make an account", which is attribution rather
than protection. Attribution is a fair yield for a bound on *bulk* — it is
D188's and D191's own claim about themselves — but not when the payload is
children's real names.

`affiliated` asks for **standing**: a role in some organization. A teacher adds
you, or you ask and somebody decides (D179, D181). Where an organization is
`open` and you can add yourself, appearing on its roster is attribution of the
strongest kind available and removal revokes it — **the same residual D191
named and accepted**, named again here rather than papered over.

### The alternatives, and why they lost

| Alternative | Why not |
| --- | --- |
| **`public` as default** (today) | It is the measured harm: 264 of 481 accounts named to a stranger. Kept as a rung, because an open judge whose competitors are adults is a real deployment and this is the right setting for it. |
| **`authenticated` as default** | Defeated by open registration in thirty seconds, measured above. Kept as the **middle rung**, because the parent case below is real and a province that judges the trade differently should change one line, not fork the code. |
| **Real names only within the pupil's OWN organization** (the brief's other candidate) | Two counts. (1) It breaks the reader a province actually has: a provincial round's organiser belongs to none of the thirty schools whose pupils are in it, so their results sheet prints thirty columns of handles and the certificates are unusable. (2) It needs the viewer's organizations intersected with the subject's on every row of every board, roster, grid and export — an extra join on eight surfaces, which is the exact shape in which a seventh surface gets forgotten. B-35's finding is that failure one level up. |
| **Trim the field, or make it optional** | Rejected for D188's and D191's reason: it forks the contract, makes every renderer grow a branch, and **breaks D122's initial avatars**, which are computed from the display name and would then be computed from nothing. |
| **Gate the scoreboard** | Gating the judge's front door, refused by B-35 on D46's authority and by this slot on the same. The board carries no name; there was nothing there to gate. |

---

## 3. What a legitimate reader loses

- **A signed-out visitor.** Loses real names and About text. **Keeps** every
  scoreboard, every rank, rating and rank badge, every contest, every school
  page and its first roster page, and every profile — with the handle in the
  name's place, and a sentence in both languages saying so.
- **A parent looking up their child.** This is the sharpest loss and it is real:
  under the default a parent sees handles even with an account. Three answers,
  in order of honesty — the child knows their own handle; the **certificate and
  the results sheet an organiser produces carry the real name**, and those are
  the artefacts that actually go home; and a province that weighs it the other
  way sets `NAME_DISCLOSURE=authenticated`, which is why that rung exists rather
  than being argued away.
- **An unaffiliated researcher or scripted consumer.** Loses real names, keeps
  every identifier and every number. Rating history, standings and statistics
  are all intact.
- **Nobody with standing loses anything.** Every screen in this product that
  renders a person is reached by a reader with standing: the admin lookup is an
  admin, the roster and team pickers are org staff, the progress grid is
  owner-or-admin, the exports are contest staff, and your own pages are you.

**The honest limit of the claim**, in D188's own words said again: this is a
bound on strangers, not impossibility. An organization with `joinPolicy: open`
lets a determined party affiliate themselves — attributably, revocably — and
that is accepted, exactly as D191 accepted it for the meter.

---

## 4. The export paths specifically

The brief said these matter most, and D62 is this project's own precedent: a
booklet once leaked a private statement because an export path had its own idea
of what it might print.

**Every export prints real names at every rung — and reaches that answer by
ASKING the predicate rather than skipping it.** `authority` is an *input* to
`nameAudience(db, policy, actor, { authority })`, passed by a surface that has
already refused everybody who is not staff over exactly these people:

| Export | The check that makes it authority | Rendered by |
| --- | --- | --- |
| `results.csv` | `canRunContest` in `buildResults` | `contests/results-csv.ts` |
| `results.pdf` | the same | `statements/results.ts` |
| `certificates.pdf` | the same | `statements/results.ts` |
| `seats.pdf` (D129) | the same | `statements/seats.ts` |
| progress grid + `.csv` | `orgs.loadForEdit` — owner or admin of THIS organization | `problem-set.access.ts` |

A certificate bearing a handle is not a certificate, and a seat slip bearing a
handle defeats the reason D129 prints one — an invigilator handing a *named*
child a seat.

**Two structural properties keep this honest rather than exempt.**

1. The four renderers take an already-projected DTO and **never touch the
   column**. `ResultsService.loadDisplayNames` is the single place the name is
   read for all four artefacts, so an export cannot disagree with the policy
   because it has nothing of its own to disagree with.
2. The projection reuses the fallback the export already had.
   `buildResults` has always written `displayNames.get(row.participant) ??
   row.participant` for a ranking row whose account was deleted — so a redacted
   map and a missing row produce the same, already-tested column. **The
   substitution needed no new shape anywhere downstream.**

The result: if a later slot tightens the ladder, or widens who may pull a file,
the exports are already correct, and `name-disclosure-guard.spec.ts` reds if a
new one grows its own answer.

---

## 5. One switch, and the F-40 trap it walks straight into

`NAME_DISCLOSURE` is read in **one** module, `apps/api/src/authz/name-disclosure.ts`,
and D198's scan is what makes that a fact rather than an intention.

- **`unsetWhenBlank`, and this is not decoration.** Compose cannot omit a
  variable conditionally: `NAME_DISCLOSURE: ${NAME_DISCLOSURE:-}` hands the
  process the **empty string** on a stack whose `.env` says nothing, and a bare
  `z.enum([...]).default('affiliated')` reads `''` as a value outside the enum
  and refuses to boot. **A policy whose safe default cannot survive being left
  unset is not a safe default.** Asserted three ways (absent, `''`, `'   '`),
  and a rung the enum does not have is still a refusal, not a silent fallback.
- **`.env.example`** documents the three rungs, names the default, and states
  what `authenticated` costs with B-35's number attached.
- **`docker-compose.yml`** passes it to the `api` service. F-40 exists because
  the API read a full `SMTP_*` set that compose never passed; a spec now asserts
  the pass-through and the `.env.example` line, in `mail-wiring.spec.ts`'s shape.
- **The admin operations dashboard reports the rung in effect**, beside the mail
  block and for the same reason: an operator set a variable and had no way to
  see whether it reached the process. It reports through the same fail-closed
  `policyOf`, so it cannot report a rung the services are not on.
- **Fail-closed.** The access services take `AppConfig` as an *optional*
  constructor parameter on D80's precedent, so a spec that builds one by hand
  keeps working — and `policyOf(undefined)` is `affiliated`, never `public`.

**And one migration, which is an index and not a schema change.**
`org_members`' primary key leads on `org_id`, so "does this person belong to
any school?" is a **sequential scan**:

```
EXPLAIN (ANALYZE) SELECT 1 FROM org_members WHERE user_id = 487 LIMIT 1;
  Seq Scan on org_members  (actual time=0.012..0.012 rows=0 loops=1)
    Rows Removed by Filter: 122
  Execution Time: 0.034 ms
```

Harmless on 122 rows; a province's table is one row per pupil per school and
grows with every import, and `nameAudience` asks the question once per read for
a signed-in caller who is not already authority — on a contest day, every
profile a pupil opens. `0049_f55_org_members_user_id` is a plain b-tree on
`user_id`, and it pays for a path that **predates** D197: `roleIn` in
`org.access.ts` has always had the same shape. **The live database is one
migration behind until the next deploy, which this slot may not perform.**

---

## 6. The hole that would have made it theatre

D185's `q` matches a word prefix of `users.search_fold` — the stored generated
column `username || ' ' || display_name`, folded (migration 0047). A reader who
is shown handles but may still search the display names has a **name-recovery
oracle**: `q=ng`, `q=ngu`, `q=nguye`, each answer confirming another letter of
the name the projection just took away.

D191 closed exactly this prefix-iteration hole for an *anonymous* roster reader.
Leaving it open for a *signed-in* one with no standing would have been the same
mistake with a cookie on it.

So the policy is **one predicate in two forms**, the discipline this project
already applies to visibility:

- `presentName` / `presentAbout` — the **projection**, what a row says;
- `nameSearchColumn` — the **haystack**, what `q` may match. A redacted reader
  searches the folded **username alone**.

That is deliberately the *un-indexed* path (0047 measured 172 ms against 4.2 ms
on a 25 000-account copy), and it is the right trade twice over: the only caller
who takes it has no standing in the province and no screen in this product that
needs it, and paying for a second stored column would be paying to make an
oracle fast. The residual is named rather than hidden — a redacted reader
searching many prefixes pays 172 ms each, attributably, under an account.

---

## 7. Demonstrated red

Every rung and every load-bearing choice was reverted and measured, not asserted.

| Change | Red |
| --- | --- |
| the true pre-D197 shape — the default at `public` | **8 of 16** |
| **no substitution** — `presentName` always returns the display name | **6 of 16** |
| **`affiliated` collapsed into `authenticated`** — the thirty-second account gets the names | **5 of 16** |
| the search haystack left on `search_fold` | **2 of 16** — the oracle, exactly |
| `authority` ignored — the export path redacted with everything else | **1 of 16** |
| `about` substituted rather than withheld | **1 of 16** |
| self not exempt — you cannot see your own name | **1 of 16** |
| **D198**: a `schema.users.displayName` read added to `contest.monitor.ts::feed` | **1 of 5**, naming the file, the function and the line |
| the web notice removed — the trimmed state not said (D187) | **1 of 14** (web) |

---

## 8. B-35's two leftovers

### 8a. `scripts/cleanup-test-data.ts` did not know about `b35-`

The loop renamed its bug-hunt slots from `bh<n>` to `b<n>` partway through and
nothing here noticed, so `b35-probe-1788313721` matched **no** pattern in the
cleaner.

**What the new pattern claims, in D153's terms.** `^b[0-9]+-` — `b`, one or
more digits, then a **hyphen** — added for `user`, `contest`, `problem` and
`org`, **beside** the existing `^bh[0-9]+` entries rather than replacing them
(`bh…` rows are still on the instance).

**The hyphen is load-bearing and is the difference from the `bh` neighbour.**
`^b[0-9]+` with no separator would also claim `b1nh`, an ordinary
Vietnamese-looking username a province could plausibly hold, and D153's posture
is that a rule which can eat a real school is worse than litter left behind.
`^bh[0-9]+` is dashless only because the live rows `bh10probe1`, `bh30probe`
and `bh34admin` prove that loop wrote names that way; no such evidence exists
for the `b<n>` slots, so the new one is tighter. Verified in psql:
`b35-probe-1788313721` → true; `b1nh`, `b12x`, `binh-minh`, `b-probe`,
`bh14-s1-1` → false.

**What it deliberately does not claim**: dashless `b<digits>`; digitless `b-`;
and `f<n>-`. No F slot has ever minted a live row under its own name — the ones
that wrote (F-42's `fe42-truong`, `fe42-a1`, `fe42-monitor-*`) used the FE
convention, already claimed by `^fe[0-9]+-`. That follows **D153's own `j*-`
precedent**: record it, do not pattern it, because a pattern guarding rows
nobody has ever minted is a deletion rule with no audit trail behind it.

**Live survey, read-only.** After the change, every `users.username`,
`organizations.slug`, `contests.key` and `problems.code` that matches no
pattern is **exactly the DENY set** — `system`, `duckadmin`, `hocsinh1`,
`thu-nghiem-1`, the five Vietnamese problems, `aplusb`, `hello` — and nothing
else. Before it, `b35-probe-1788313721` was the one row in that gap.

**The 22 `rate_events` rows are still not modelled, deliberately, and the
reason is now in the file.** `rate_events` has **no foreign key to `users`** —
`key` is free text (`user:487`) — so a leftover row blocks nothing, joins to
nothing and discloses nothing, and `authn/expired-rows.sweeper.ts` already
deletes the table by `created_at` alone.

**The rows remain.** This brief forbids writing to the live database, so the
widened pattern is the *sanctioned* fix and could not be *run*. `packages/db/test/cleanup-test-data-script.spec.ts`
— **`Tests 14 passed (14)`** — and the full `@duckoj/db` suite are in the
verification below.

### 8b. Does the NUL class have other members the fuzzer cannot express?

**No.** Zero 5xx across roughly 170 probes, each measured in vitest rather than
reasoned about.

| Hypothesis | Verdict | Measured |
| --- | --- | --- |
| **Query-parser shape confusion** (`?q[a]=b`, `?q[]=x`, `?q[__proto__]=x`) | **no gap** | `express.get('query parser')` is **`simple`** — nothing in this app or in Nest sets it. Bracket notation is therefore an inert literal key: **200** everywhere, never an object where a string was assumed. |
| **Repeated keys** (`?q=a&q=b`) | **no gap, and now covered** | These *do* arrive as arrays, and every schema refuses them: **422** on `/users`, `/problems`, `/submissions`' three filters, `/contests?org=`, `/users/me/teams?contest=`, `cursor` and `limit`. |
| **Lone surrogates** (`\uD800`) in a body or a query | **no gap** | Node replaces an unpaired code unit with **U+FFFD** when it encodes the string for the wire, so Postgres never sees one. `POST /auth/register` with `displayName: 'a\uD800b'` answers **201** and the row is written. |
| **Overlong NUL `%C0%80`**, CESU-8 `%ED%A0%80`, invalid `%zz` | **no gap** | In a **path** segment express refuses all three with **400 `bad_request`** in `application/problem+json`, before any handler — so none of them can smuggle a NUL past `NulByteInterceptor`'s literal `%00` check. In a **query** value the utf8 decoder yields U+FFFD, which binds fine (**200**). |

**Two passes added to `route-fuzz.spec.ts`**, both green: *repeated filter keys,
not just paging* — which closes the shape half of the same "`q` was never fuzzed
at all" hole D196 records for the NUL byte — and *undecodable percent-escapes
and lone surrogates*. **No second interceptor was built**, as the brief required.

**One boundary found and deliberately NOT added as a pass, reported instead.** A
URL of roughly 20 KB answers **431** raw from node's HTTP parser — no body, no
`application/problem+json`, before express runs at all. Adding it would red
`route-fuzz` on *two* assertions at once (431 is in neither `AMBIENT` nor any
OpenAPI document, and the response is not problem+json), and it is arguably
correct behaviour from an HTTP server with Caddy in front of it. **Widening
`AMBIENT` or documenting 431 is a ruling for a human, not something a fuzzer
pass should force**, so it is recorded here and **D199 was not spent on it**:
this is correct behaviour left alone, not a disclosure left open, and the
decisions this campaign spends on "measured and deliberately unchanged" (D192,
D195) were both about disclosure.

---

## Verification

| Package | Result |
| --- | --- |
| `@duckoj/api` | **`Test Files 156 passed (156)` / `Tests 1309 passed (1309)`** |
| `@duckoj/web` | **`Test Files 75 passed (75)` / `Tests 794 passed (794)`** |
| `@duckoj/db` | **`Test Files 20 passed (20)` / `Tests 99 passed (99)`** |
| `@duckoj/contracts` | **`Test Files 9 passed (9)` / `Tests 39 passed (39)`** |
| `@duckoj/sdk` | **`Test Files 1 passed (1)` / `Tests 2 passed (2)`** |

`@duckoj/db` **was** run this time and had to be: 0049 is a real migration, and
`migration-journal.spec.ts` applies every entry to a Postgres started from
nothing. `@duckoj/judged` was not run — nothing in it was touched.

`typecheck` and `lint` clean for all five, **run separately** — a passing `tsc`
is not a passing `eslint` — plus `typecheck:scripts` and `lint:scripts` for the
cleaner, and `@duckoj/mcp` and `@duckoj/oj` typechecked because they consume the
regenerated SDK.

**The full api suite ran three times, and the FIRST run is the finding.** It
came back `Test Files 2 failed | 154 passed (156)` / `Tests 4 failed | 1305
passed (1309)`, naming the two collateral files this ruling breaks by design —
`user-search-diacritics.spec.ts` (3) and `user-list-enumeration.spec.ts` (1),
whose "teacher" fixtures were bare registrations rather than readers with
standing. **That is `CLAUDE.md`'s lesson doing its job**: eight targeted spec
runs were green while the blast radius was two files none of them touched, and
neither was reachable by grepping the diff. The second run was green after the
fixtures were given standing; the third — quoted above — is over the final tree
with the D191 comment repairs in it.

Cross-cutting guards `CLAUDE.md` names, run rather than reasoned about:

- `apps/api/test/dockerfile-manifest.spec.ts` — inside the api suite. **No
  workspace dependency was added**: `name-disclosure.ts` lives in `apps/api`
  beside the code that already imports `@duckoj/db/guarded`, and `git diff HEAD
  -- '*package.json'` is empty.
- `scripts/verify-csp-hash.ts` — **`verify:csp OK`**.
- `route-marker-coverage.spec.ts` and `authz-default.spec.ts` — green, inside
  the suite. **No route marker changed.** D197 does not gate a route: it changes
  what a route ANSWERS, which is why the 401/403/404 shape of the whole product
  is untouched and why B-35's chain still resolves — to handles.
- `packages/db/test/migration-journal.spec.ts` — inside the db suite above.

`openapi.json` and `packages/sdk/src/generated.ts` were regenerated and
committed, then **regenerated once more and `git diff --exit-code` confirmed
byte-identical** to what is committed.

**No Playwright, and the reason is structural — F-53's, unchanged.** The edge
serves `apps/web/dist` built at `fe4ec8d` and this slot may neither write that
directory nor run `vite build`, so a browser walk would exercise the OLD bundle
and prove nothing about the profile notice. More to the point, **no live
"after" is claimable at all**: the deployed API is `fe4ec8d`, which predates
D197, and this slot may not deploy or restart a container. The anonymous curls
in §1 — 159 contests, 142 usernames, 141 profiles, 133 real names — are the
**before**, measured against the real host. Vitest is the **after**.

---

## Housekeeping

- **No live writes.** Every live figure is an anonymous `GET` through the edge
  or a read-only `SELECT`. No D153-named rows were created by this slot.
- **B-35's probe account remains.** `b35-probe-1788313721` (id 487) and its 22
  `rate_events` are still live: this brief forbids writing to the live database,
  so the cleaner's widened pattern is the *sanctioned* fix and cannot be *run*
  from here. §8a says what the pattern now claims.
- **The live edge is not on this ruling.** `duckoj_api_1` keeps serving
  `fe4ec8d`, so every "before" figure in §1 is still reproducible against
  `http://localhost:8080` right now. It stays that way until the next deploy —
  B-33's and B-35's precedent, said again — and the live database is one
  migration (0049) behind for the same reason.
- **Three ledger comments were repaired rather than left to mislead.** D191
  argued in three places that trimming a roster's `displayName` would close
  nothing "because `GET /users/{username}` serves `displayName` to anyone".
  D197 made that false at the default rung, in one of the very files that said
  it. This codebase treats comments as rulings, so a comment that has quietly
  become false is a defect; they now say what D191 argued (about bulk, still
  correct) and what D197 answered.
- No process left running and no leaked Testcontainers. `podman ps` shows the
  **six** long-lived DuckOJ stack containers (postgres, redis, caddy, api,
  judge, judged); no container was started, stopped or restarted, and the only
  podman commands issued were `ps`, `exec … psql` (SELECT/EXPLAIN only) and
  `inspect`.
- **The same observation F-52 and F-53 reported, reported again rather than
  buried**: `duckoj_api_1` shows a much shorter uptime than its neighbours
  (about an hour, against 2 days for postgres, redis and caddy). It was **not**
  restarted here — the podman commands issued in this slot were `ps`, `inspect`
  and read-only `exec … psql`, never `start`, `stop`, `restart`, `compose` or a
  deploy script. Something outside these slots cycles it.
- `graphify update .` run after the code settled: 9 863 nodes, 16 977 edges,
  721 communities. `graphify-out/` is gitignored, so nothing from it is staged.
- **A subagent ran the two B-35 leftovers in §8** on `scripts/cleanup-test-data.ts`
  and `apps/api/test/route-fuzz.spec.ts` — disjoint files, reviewed here before
  being committed as `c287a25`.
- `docs/DECISIONS.md` gained **D197** and **D198**. **D199 was not needed and is
  not used** — §8b says what it was considered for and why it was not spent.
