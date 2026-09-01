# F-48 report — a ruling applied everywhere it holds, and a pin where the connection is made

**Status: complete.** Both halves done. Every new assertion was demonstrated
**red** first and the failure output is here and in the commit that fixed it.
**D175** rules the pin, **D176** rules the scope; **D177 is unspent.** Six
commits on `main` in this clone. **Not pushed, not deployed.**

`podman-compose`, `scripts/compose-up.sh` and `scripts/deploy.sh` were never
run and no container was started, stopped or restarted. **`apps/web/dist` was
never written and no `vite build` ran.** Nothing under `.secrets/` was read,
printed or committed. **The live database was not touched at all** — not even
read — so there is nothing open under D153; see "Why there is no live read".

---

## Commits

| | |
| --- | --- |
| `4eb2995` | `fix(db)` — pin `extra_float_digits` where the connection is made, not per query (D175) |
| `2eac8c8` | `feat(api)` — the other three forms with the shape carry a version too (D176) |
| `adeb842` | `feat(web)` — the other three forms carry the version they were seeded with (D176) |
| `a195f22` | `docs(D175,D176)` — where the digits get pinned, which forms get the token, and why it stays optional |
| `243b595` | `test(db,web)` — make the two new seams typecheck and walk the real path |
| `31d939c` | `docs(f48)` — this report |

HEAD before this slot was `16dd990`, which is the commit the live stack is
deployed at. Nothing in this slot is on the edge.

---

## Part 1 — which forms genuinely have the shape

D161's reasoning is not about problems and contests. It is about **any form
that seeds once from a cached query and saves by replacement**, because that
combination silently overwrites a co-editor's work with a copy the form has
been holding since before they saved.

F-43 named three remaining. The count was checked against the code rather than
inherited, because F-41's language-limits form and F-46's changes had both
landed since. Five forms have the shape; three of them get the token.

### The table

| Form | Route | Seeds once from a query? | Saves by replacement? | Can two people hold it open? | Verdict |
| --- | --- | --- | --- | --- | --- |
| `problem-edit.tsx` | `PATCH /problems/{code}` | yes | yes — every field | **yes** — any number of `problem_members` may author one problem | already has it (D161) |
| `contest-edit.tsx` | `PATCH /contests/{key}` | yes | yes — `problems`, `orgSlugs` | **yes** — the creator and any admin | already has it (D161) |
| `problem-language-limits.tsx` | `PUT /problems/{code}/language-limits` | yes — `seededFrom === code`, and it never reseeded at all | yes — the PUT replaces the whole set, and the tab renders every active language | **yes** — co-authors of one problem, same gate as `problem-edit` | **gets it** |
| `problem-sets.tsx`'s `SetForm` | `PATCH /orgs/{slug}/sets/{setSlug}` | yes — five `useState` **initializers**, which run once and then ignore their input forever | yes — `problems` replaces the whole list, order included | **yes** — `OrgAccessService.loadForEdit` admits an org **owner or admin**, which is the ordinary staffing of a school here | **gets it** |
| `teams.tsx`'s `TeamForm` | `PATCH /orgs/{slug}/teams/{teamSlug}` | **hybrid** — `name ?? loaded?.name`, so untouched fields track the live query | yes — `members` replaces the whole roster | **yes** — same gate as the set | **gets it** |
| `settings.tsx` | `PATCH /users/me` | yes — `seededFrom === user.id` | yes — `displayName`, `locale`, `timezone` | **no** | **does not need it** |
| `contest-new.tsx`'s clone | `POST /contests` | yes, from the source contest | **no** — it creates a new contest | n/a | **does not need it** |

Four forms were examined and found **not to have the shape at all**, recorded
so the next person does not re-derive them: `problem-testdata.tsx` (a wizard
that starts from defaults and writes into a draft the actor themself created,
never a seeded replacement of a stored record), `orgs.tsx`'s member-role PATCH,
`contests.tsx`'s clarification answer and participant PATCH, and
`problem.tsx`'s comment edit — all four write **one field** the caller just
chose, so there is no held copy to overwrite with. `PATCH /orgs/{slug}` (an
organization's own settings) has no web form at all today; when it gets one, it
will belong in the table above.

### The two verdicts worth arguing

**`TeamForm`'s hybrid seeding does not exempt it.** "Untouched fields track the
live query" reads like a safety property, and it is genuinely better than a
frozen initializer — but it is clause A implemented implicitly, and D161 has
already ruled that clause A alone is not a guarantee, because the person who
loses work is the one who *has* typed. It is in fact weaker than clause A:
there is no `!dirty` condition in it anywhere, and a save still sends the
roster the query last delivered, which may be minutes old with no refetch in
between. It also could not carry a token without being rewritten, because a
form whose untouched fields follow the cache has no single moment it was
"seeded at" to declare. It was rewritten.

**`settings.tsx` does not need the token, and the reason is not that the form
is small.** It is that its field list has exactly one writer. `PATCH /users/me`
is the account's own owner. The only other route in the API that writes a user
row from outside is `PATCH /admin/users/{username}`, which writes `globalRole`
and nothing else — not a field this form can send, so an administrator granting
somebody `setter` must not refuse the display name they happen to be saving in
the same minute. Two people cannot hold this form open over the same three
fields, so there is no second version for a token to protect.

**What would make that stop being true**, stated so it does not have to be
re-derived: any screen that lets a *second* person write a display name, locale
or timezone. An admin "manage this account" form; an org teacher correcting a
pupil's name after a roster import; an SSO or LDAP sync writing preferences on
sign-in. On the day one of those lands, this row becomes a "gets it", and the
machinery is already here — it is one field on the request, one on the
response, and one `for update` in the service.

The same-person-in-two-tabs case is real and is deliberately not covered. What
it can cost is one person's own two edits to their own three fields, with both
screens in front of them. That is not the class this exists for, and paying a
query on every account read to close it would be the wrong trade.

**`contest-new`'s clone overwrites nothing.** A stale clone source produces a
*new* contest seeded from a slightly old copy, on a form the organiser is
looking at before they press create. The residual is honest and it is not data
loss.

### What each token is over — and what it deliberately is not

D161's rule applied rather than restated: over exactly what the request can
write, computed from the **stored** row, taking no actor. The exclusions are
the part that took judgement.

| Token | Over | Deliberately NOT over, and why |
| --- | --- | --- |
| language limits | the stored override rows, keyed by language `key` | `base` (the published revision's authored limits) and the per-language defaults. Both are on the response; neither is writable here. Publishing a corrected revision, or retuning Python deployment-wide as **D169 did**, changes what the screen *previews* without changing anything it can *save* — a token over them would lock a co-author out over a write they do not own |
| problem set | slug, name, description, deadline (epoch ms), items with points and order | `solvedCount`, `visible`, and every `me` cell. They move when a pupil submits and they differ between two teachers who may both edit the set — exactly the viewer-dependence D161 rejected a DTO hash for |
| team | slug, name, roster by username | `contests`. A team entering a round is not an edit to the team, and refusing a rename made in the same minute as a join would fire on contest morning, which is when both happen |

A row that inherits both columns and allows the language is stored as **no
row**, so the language-limits token is over the stored set rather than over the
request that produced it: two requests that store the same set are the same
state, and neither refuses the other.

### One thing that is not the pattern: the lock is on the parent

Every other D161 check locks the row it is about. The language-limits check
cannot, and this is worth stating because it looks like a mistake:

> The set being replaced may be **empty**. There is no row in
> `problem_language_limits` to lock when a setter is adding the first override,
> so two setters each adding a first override would find nothing to wait on and
> both would pass the check.

So it takes `select id from problems where id = … for update`. That is the one
row that is always there — and it is the row `ProblemAccessService.update`'s
own check already locks, so the statement writer and the limits writer
serialise against each other as well, which is a small bonus rather than the
reason.

### `expectedVersion` stays optional, argued from deploy ordering

The brief asks whether it should become required now that most forms carry it.
It should not, and the decisive argument is not the one D161 gave.

`UpdateProblemRequest` and `UpdateContestRequest` are `.strict()`. That is what
makes **old bundle → new API** safe: an old bundle sends no token and is simply
unchecked, which is the pre-D161 behaviour. It is also what makes **new bundle
→ old API** fatal: a field the contract has not learned is a 422 on every save.

Making `expectedVersion` required would break the direction that currently
works. An old bundle — served from a cache, or a browser nobody has reloaded —
would have **every** save refused, on routes the operator did not touch, during
a window they cannot control. That is a worse outcome than the one it would
prevent, which is a client that forgets the token being exactly as exposed as
it was before D161 existed.

The weaker arguments still hold and are recorded in D176: this is a documented
API with personal access tokens behind it, and an import script writes
problems. The honest cost is unchanged from D161 and is now five times as wide:
**a client that forgets is silently unprotected**, and nothing on the server can
tell it apart from a script that never had the problem. What makes it tolerable
is that the *forms* are required to send it, and each has a test asserting that
they do.

### Deploy ordering — what the controller needs to know

**API first, or both together. Never web first.** Same as F-43's rule, now over
five routes, and with one route that behaves differently:

| Route | Schema | New bundle against an OLD API |
| --- | --- | --- |
| `PATCH /problems/{code}` | `.strict()` | **422 on every save.** The form cannot save at all until the API catches up |
| `PATCH /contests/{key}` | `.strict()` | same |
| `PATCH /orgs/{slug}/sets/{setSlug}` | `.strict()` | same |
| `PATCH /orgs/{slug}/teams/{teamSlug}` | `.strict()` | same |
| `PUT /problems/{code}/language-limits` | **not** `.strict()` | zod **strips** the unknown key, so the save lands **unchecked** — the pre-slot behaviour, not a broken form |

`UpdateProblemLanguageLimitsRequest` was already not strict and this slot
deliberately did **not** make it so: that is a separate breaking change to a
documented route, and making it under cover of a concurrency fix is how a
"small" deploy takes a province's import script down. The difference is
recorded rather than smoothed over.

**Old bundle against a NEW API is safe on all five** — no token sent, no check
run, exactly what happens today.

Nothing here needs a migration. Both D175 and D176 are additive and reversible
without one.

### The conflict message was reused, not reinvented

D161 shipped the shape and this slot did not touch it: D110's summary, D146's
attribution where the server offers any, D148's button that is live unless busy
and says what it is doing, the **announced** reseed, and an explicit "load the
newer version" button that is **never** automatic — because a conflict is by
definition a form holding work, and a page that silently replaced it with
somebody else's copy would be the loss the whole feature forbids.

The three new sentences (vi and en, D18) each name the field actually at risk,
because on these forms the answer to "can I retype my way out of this?" is
**no**. What the save would have replaced is a list the person at the keyboard
never wrote:

- the language-limits tab PUTs every active language, so a co-setter's "Python
  is refused on this problem" becomes the `allowed: true` this tab has been
  holding — and the pupil it was meant to stop submits anyway;
- the set's `problems` replaces the list, so next week's problem disappears
  again from a save meant to fix a deadline;
- the team's `members` replaces the roster. **On contest morning that is a
  pupil who cannot compete.**

None of it shows on screen, because the form is displaying exactly what it was
given. That is the whole reason the refusal has to come from the server.

### Two forms had to stop seeding the way they did

This is the part of the web diff that is more than plumbing.

`SetForm` seeded with five `useState` **initializers**. An initializer runs
once and then ignores its input forever — the seed-once half of the defect,
implemented as literally as it can be. It is now an effect carrying clause A's
guard.

`TeamForm`'s `x ?? loaded?.x` fallbacks are discussed above. Both forms now
hold explicit state, one `dirty` computed once, and one `seededVersion`.

`problem-language-limits.tsx` already had the seed fingerprint and D147's leave
guard; it gains clause A's condition, and its `dirty` is now computed once and
read by the leave guard and the reseed alike — `contest-edit.tsx`'s rule, for
its reason: "there is unsaved work here" has to mean one thing to both, or one
of them is wrong.

### Red first — API

Six cases added to `apps/api/test/edit-version-conflict.spec.ts`, over HTTP
against the whole chain, because three of the five request schemas are
`.strict()` and a field the contract has not learned is a 422 a service-level
test cannot see. Red with the four source files and the two regenerated
artefacts stashed:

```
 × refuses the second save, writes nothing, and leaves the first setter's refusal standing
   → expected 'undefined' to be 'string'
 × hands back a token the same tab can save with again, and leaves a PUT that sends none unchecked
   → expected 'undefined' to be 'string'
 × refuses the second save and leaves the problem the first teacher added
   → expected 'undefined' to be 'string'
 × serves no token to a pupil reading their homework, and does not move on a write the form does not own
   → expected undefined to be null
 × refuses the roster save that would drop the pupil the other admin just added
   → expected 'undefined' to be 'string'
 × serves no token to somebody who may read the roster but not edit it
   → expected undefined to be null
 Tests  6 failed | 6 skipped (12)
```

**Two of those reds were earned rather than found, and both are worth
recording.**

The second case reddened at a *later* assertion on its first run, because every
`toBe(opened.body.version)` in it was `undefined === undefined` — F-43's own
footnote, hit again in the same file. The `expect(typeof opened.body.version)
.toBe('string')` at the top of that case is what makes it red for the right
reason, and it says so where it stands.

The **first** case passed against the *fixed* code, and that is the more
interesting one. It mapped over `lang.languageKey !== 'py3'` — and migration
0042 seeds Python under `python3`. A map over a key no language has stores no
row, leaves the token exactly where it was, and would have made the whole case
vacuous in both directions. The key is now asserted before it is used.

**Green: `Test Files 1 passed (1)`, `Tests 12 passed (12)`** for that file.

### Red first — web

Four cases added to `apps/web/test/edit-form-conflict.spec.tsx`, in the shape
the brief names: **one real `QueryClient` across each walk, real keys, two
mounts**, and `invalidateQueries` for the refetch — which is what a window
refocus, a poll or any sibling mutation does in a real browser. Red with only
the three route files reverted, so the strings stayed put and the failure is
about behaviour:

```
 × takes the newer overrides when nothing has been typed, and says that it did
   → expect(element).toHaveValue(150)
 × sends the version it was seeded with, and offers the newer one when the save is refused
   → expected undefined to be 'v1'
 × refuses to send the stale problem list back, and keeps it on screen until the teacher chooses
   → expected undefined to be 'v1'
 × refuses to send the stale roster back, and keeps what was typed on screen
   → expected undefined to be 'v1'
 Tests  4 failed | 4 skipped (8)
```

---

## Part 2 — the pin, and proving it survives a recycled connection

### Where it went

`packages/db/src/client.ts`:

```
postgres(url, { max: 10, connection: { extra_float_digits: '3' } })
```

`options.connection` is merged into postgres.js's `StartupMessage`
(`src/connection.js`, read rather than assumed), so the value rides the
connection's own startup packet.

**That is the whole point, and it is what makes it a pin rather than a
statement.** Three properties, each asserted:

| Property | Why a post-connect `SET` does not have it | How it is proved |
| --- | --- | --- |
| every **physical** connection carries it, including a replacement for one the server dropped | an `onconnect` hook covers only connections opened while the hook is installed and the pool is behaving; a session setting a pool resets is a pin that is not there | the test records `pg_backend_pid()`, calls `pg_terminate_backend(pg_backend_pid())`, retries until a statement succeeds, asserts the **pid changed**, and asserts `current_setting` is still `3` |
| it is the session's **RESET value** | `DISCARD ALL` — what a connection pooler issues between clients — drops a post-connect `SET` back to the cluster default silently | `set extra_float_digits = 0`, then `discard all`, then `reset all`; both return to `3` |
| **no round trip** | a statement per connection costs one; a statement per query costs one per query, forever, to answer a rendering question | by construction |

### The hostile province is built, not imagined

Every case runs against a database created on the test container with

```
create database province_zero;
alter database province_zero set extra_float_digits = 0;
```

which is the thing a provincial administrator can actually do. The spec asserts
that the bare connection really does report `0` before it asserts anything
else, because every claim below is only interesting if it does.

That also settles by **measurement** a precedence question that would otherwise
be settled by reading the manual: **a startup-packet parameter wins over `ALTER
DATABASE … SET`.**

And it pins the property rather than the spelling: over the same database, a
bare connection renders `1::float8/3` as `0.333333333333333` — which parses back
to a *different* double — and the pinned one renders the value that
`JSON.parse`s back to exactly `1/3`, both directly and through
`to_jsonb(float8)`, which is the seam D165 actually crosses.

### What was deliberately left alone

**`runMigrations`' pool is not pinned.** This is the one judgement in D175
rather than a measurement. A migration that renders a float server-side has to
say so itself, as 0045 does; pinning the migrator would make that `SET LOCAL`
look like a line somebody could delete, and would change how every future
migration renders a `float8` with nobody having reviewed the change. It is
D161's own objection to a `version` column: a guarantee that depends on nobody
noticing is a discipline, not a constraint.

What closes that gap instead is O3, below.

`scripts/integrity-check.ts` already opens its sessions with the setting
(B-32's D168), and `contest-scoreboard-fold-plan.spec.ts` sets it explicitly on
its own connection before running 0045's backfill statements. Neither needed
changing; both are now belt-and-braces.

### O3 — 0045's own `SET LOCAL`, asserted rather than read out of a dependency

B-32 recorded that 0045's guard holds **only** because drizzle wraps a
migration's statements in one transaction (`pg-core/dialect.js`) — true by
reading a dependency, and something a drizzle upgrade can change silently.
Outside a transaction block `SET LOCAL` is a no-op that Postgres merely
*warns* about, so the failure would be a backfill written quietly at the
cluster default.

The spec builds a scratch migrations folder whose middle statement is 0045's
**own** `SET LOCAL` line, read out of the migration file — so deleting that line
from 0045 reds this test rather than quietly removing what it is about — and
runs it through the real `migrate()` on a plain pool with no pin of its own,
which is exactly what `runMigrations` builds.

**It carries a negative control**, and that is what stops it going vacuous: the
identical statements issued one by one outside a transaction, asserted to store
the truncated value *and* to raise Postgres's own
`SET LOCAL can only be used in transaction blocks`. Without it the assertion
would pass on any cluster whose default is already above 0 — which is every
cluster we have.

### Red first — the pin

With the option removed from `createDb`:

```
 × pins the digits the connection renders a float8 with, over the database own default
   → expected '0' to be '3'
 × survives a connection the server dropped, because it rides the startup packet
   → expected '0' to be '3'
 × is the session RESET value, so DISCARD ALL returns to it rather than to the cluster default
   → expected '0' to be '3'
 × is the difference between a double that round-trips and one that does not
   → expected 0.333333333333333 to be 0.3333333333333333
 Tests  4 failed | 2 passed (6)
```

The two that passed are the O3 pair, which assert a mechanism that already
holds — so they were checked for vacuity separately. Neutering the `SET LOCAL`
in the synthetic migration reds the first of them:

```
 × holds across the statement below it, because drizzle runs a migration in one transaction
   → expected 0.333333333333333 to be 0.3333333333333333
```

**Green: `Test Files 1 passed (1)`, `Tests 6 passed (6)`.**

One incidental bug was caught by writing the assertion carefully: the first
draft read the setting with `show extra_float_digits` and a fixed column alias.
`SHOW` names its column after the *setting* and takes no alias, so every read
was `undefined` — red for the wrong reason, and it would have been green for
the wrong reason had anybody later written `not.toBe`. It uses
`current_setting(...)` and the reason is a comment.

---

## Verification

Every new assertion demonstrated **red** first; the output is above and in the
commit that fixed it. The **full suite of every package touched** was run, per
`CLAUDE.md`, not only the spec files edited.

| Suite | Result |
| --- | --- |
| `@duckoj/api` — all 145 files, `--no-file-parallelism` | **`Test Files 145 passed (145)` / `Tests 1246 passed (1246)`**, 791.61 s |
| `@duckoj/web` — all 71 files | **`Test Files 71 passed (71)` / `Tests 768 passed (768)`** |
| `@duckoj/db` — all 20 files | **`Test Files 20 passed (20)` / `Tests 99 passed (99)`** |
| `@duckoj/judged` — all 19 files | **`Test Files 19 passed (19)` / `Tests 148 passed (148)`** |
| `@duckoj/contracts` | **`Test Files 9 passed (9)` / `Tests 39 passed (39)`** |
| `@duckoj/sdk` | **`Test Files 1 passed (1)` / `Tests 2 passed (2)`** |

**2 302 passed, 0 failed.**

**F-43's inherited red is gone.** That report left
`apps/api/test/dockerfile-manifest.spec.ts` failing on both images' missing
`COPY packages/language-limits/package.json`. It was fixed before this slot, by
`6089829` and `1530fbe`, and the 145-file run above is fully green — so this
slot inherits nothing and leaves nothing.

`@duckoj/judged` was run although this slot changed no line in it: `EventWriter`
reads `submission_cases.points` as `float8` over a `createDb` connection, which
is precisely the seam D175 pins, and asserting that its 148 cases still hold
over a pinned connection is the point.

**`typecheck` and `lint` clean** on `@duckoj/api`, `@duckoj/web`, `@duckoj/db`,
`@duckoj/contracts`, `@duckoj/sdk` and `@duckoj/judged`, plus
`typecheck:scripts` and `lint:scripts`.

Each package's **own** `typecheck` script was run rather than a hand-rolled
`tsc --noEmit`, and that caught something: `packages/db`'s script is `tsc -b &&
tsc --noEmit -p tsconfig.test.json`, and only the second half covers `test/` —
where two `sql.unsafe` casts in the new spec did not typecheck. CI runs the
script. Fixed in the last commit, with the reason in its message.

`openapi.json` and `packages/sdk/src/generated.ts` were regenerated with the
repository's own two commands and `git diff --exit-code` over both is clean —
the check the root `verify` ritual makes.

**Not run, and it is the one gate CI has that this slot could not:**
`vite build` followed by `verify:csp`. The brief forbids the web build.
`apps/web/index.html` was not touched, and `verify:csp` hashes the inline
`<script>` in the **built** `index.html` against the Caddyfile — so nothing in
this diff can move that hash. Stated rather than assumed.

**Thermal and hygiene.** Every command under `nice -n 19`; every vitest run
with `--no-file-parallelism`; one container-backed suite at a time; no load
test. **No process and no test container is left running** — checked with `ps`
and `podman ps` at the end. The three live-stack containers are up and
untouched, exactly as they were found.

---

## Why there is no live read and no browser walk

**The live database was not read at all this slot**, which is a stronger claim
than the brief requires and it is deliberate: neither half of this work has a
question a live row could answer. Part 1 is about two sessions racing, which
needs two committed transactions on a database it is safe to write to. Part 2 is
about a cluster whose `extra_float_digits` is **0**, and the live cluster's is
**1** — the one setting it is impossible to observe there. So the hostile
province was built on a scratch container instead, which is the only place the
assertion means anything.

**No live rows were created. Nothing is open under D153.**

A browser walk would show these red and could not show them green: the edge is
deployed at `16dd990` and every fix here is a local commit it does not carry.
It would also prove less than the specs do at the layer the defect lives in —
the API cases go over HTTP through the real contract, the real validation pipe
and the real transaction and assert on the **stored** rows that nothing was
written; the web cases drive a real `QueryClient` with real keys across a real
refetch, which is the one thing a mocked unit test structurally cannot do and
the reason this class survived hundreds of tests. Paying a production contest,
an organization, a team and a homework set to see a red we can produce
deterministically would be theatre.

---

## What I could not finish

* **Nothing is deployed.** All six commits are local on `main`; the live stack
  is at `16dd990`. Until the controller ships `api` and `web`, three more forms
  still race and the second save still wins silently, and every `createDb`
  session still inherits the cluster's `extra_float_digits`. **The ordering
  matters and it is not symmetric** — see the table in Part 1: API first, or
  both together, never web first. On four of the five routes a new bundle
  against an old API is a 422 on every save; on the language-limits route it is
  a save that lands unchecked. Old bundle against a new API is safe on all
  five.

* **`expectedVersion` is optional, so a client that omits it is exactly as
  exposed as before — now across five forms rather than two.** Deliberate,
  argued in D176 from deploy ordering rather than from automation, and pinned
  by a test. It means the guarantee is a guarantee for *these five forms*, not
  for the routes.

* **The conflict is still coarse and there is still no merge.** Inherited from
  D161 and unchanged: a teacher who changed only a team's name is refused
  because somebody else changed its roster, and the remedy is to load the newer
  version and retype the name. The refusal also cannot say *what* changed — the
  token is a hash, and the pre-image would be history these tables do not keep.

* **`settings.tsx` is uncovered by design, including the case where it is one
  person in two tabs.** Argued in Part 1 and in D176, together with the three
  concrete changes that would make it need a token. If any of them lands, that
  row moves and the machinery is already here.

* **`PATCH /orgs/{slug}` has no web form today**, so an organization's own
  settings were left out of the table's body. The route replaces `slug`, `name`,
  `about`, `visibility` and `joinPolicy` by patch, and the moment somebody
  builds the form for it, it will have the shape and two owners who can hold it
  open. Recorded so it is not rediscovered.

* **The language-limits request schema is still not `.strict()`.** Making it
  strict would be the right long-term shape — it turns an API typo into a
  refusal instead of a silent drop — but it is a breaking change to a
  documented route, and making it under cover of a concurrency fix is how a
  "small" deploy takes a province's import script down. Its deploy consequence
  is written into the table rather than smoothed over. **Worth its own slot.**

* **`runMigrations`' pool is deliberately unpinned**, so a *future* migration
  that renders a `float8` server-side and forgets its own `SET LOCAL` would
  still inherit a hostile cluster's default. The argument for leaving it is in
  D175; what stands in its place is the O3 test, which now asserts that a
  migration's `SET LOCAL` reaches the statement below it. That is a guard on
  the mechanism, not on a future author's memory, and the gap is real.

* **D177 is unspent.** B-31's precedent: a decision is spent when a stated
  behaviour changes. D175 changes one (a connection now declares its float
  rendering) and D176 changes one (three more saves can now be refused).
  Nothing else in this slot does.

* **The out-of-scope list was not started**, as instructed:
  `contestWindowOpenWhere` (D49's anti-join), registration's account-existence
  oracle (D26), and syntax highlighting.
