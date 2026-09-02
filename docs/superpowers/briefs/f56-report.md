# F-56 — A school judge decides who may sign up

**Status**: done. The ruling is **D200**: `REGISTRATION`, one switch with two
rungs read in one place, defaulting to the rung that refuses. **D201** is the
D113-shaped source-scan guard over every path that can mint an account.
**D202** is `--only`, the scoped run that made the sanctioned cleanup possible
to obey. **No migration** — the switch changes only who is refused.

**The prize is taken.** On the default rung D26's registration oracle is not
narrowed, it is **gone**: the refusal is a function of the rung and of who is
asking and of *nothing whatsoever about the request body*, and it is raised
before the meter and before the address is looked at. The live `.env` sets no
`REGISTRATION`, so `closed` is what this province runs — **from the next
deploy, which this slot did not perform**. The edge at `2c8617e` still answers
201 to an anonymous registration.

`podman-compose`, `scripts/compose-up.sh` and `scripts/deploy.sh` were never
run and **no container was started, stopped or restarted**. **`apps/web/dist`
was never written and no `vite build` ran.** Nothing under `.secrets/` was
read, printed or committed. The only write to the live database is the
sanctioned cleanup in §7 — 25 rows, shown as a dry run first.

---

## Commits

In order. `HEAD` before the slot was `2c8617e`.

| | |
| --- | --- |
| `0674740` | `feat(api,contracts,sdk)` — a school judge decides who may sign up (D200) |
| `c3b2da0` | `test(api)` — every account this judge can mint asked the policy first (D201) |
| `20aba99` | `fix(web)` — a visitor who may not sign up is told so first, in both languages |
| `91a8402` | `test(e2e)` — the walks seat their pupils as the admin, on their own contexts |
| `d40df42` | `fix(scripts)` — a scoped authorisation needs a scoped run (D202), and two rows |
| `c376c24` | `test(db)` — `--only` has a test, because a destructive flag with none is worse |
| `813006b` | `fix(web)` — the operations dashboard shows which rung each switch is on |
| `e186ea3` | `docs(ops,guide)` — D26's gap is closed on the default rung, and the guides say so |
| `7f8682b` | `fix(web)` — the registration probe's fallback is a sentence, in the reader's language |
| *(this commit)* | `docs(D200,D201,D202,f56)` — the ledger entries, the runbook's bootstrap order, the brief and this report |

Nothing pushed.

---

## 1. The rungs, and what each costs

`REGISTRATION`, read in exactly one module
(`apps/api/src/authz/registration.policy.ts`).

| rung | anonymous | signed-in `user` | `setter` | global `admin` | who this is for |
| --- | --- | --- | --- | --- | --- |
| **`closed`** (default) | **403** | **403** | **403** | 201 | a school district: pupils arrive by D61's import |
| `open` | 201 | 201 | 201 | 201 | a public practice judge whose competitors are adults |

**What each costs.**

- **`closed`** costs a school that wants pupils to enrol themselves. It has to
  import them instead — a spreadsheet and one all-or-nothing call — rather
  than write a code on a whiteboard. For a small school with no roster to hand
  that is a real loss, and today's honest answer to it is `REGISTRATION=open`
  plus D26's meter.
- **`open`** costs exactly what the finding is: anyone on the internet may
  hold an account, submit, consume judge time on a fleet sized for a province,
  and appear wherever accounts appear. It also keeps D26's fake 201 and its
  one-extra-request residual. It is the right setting for a public judge and
  it is the setting you opt *into*.

### Why two rungs and not the brief's three

The brief offered invitation-or-org-code as a middle rung. It was considered
and **deliberately not built**, and the argument is about what a rung *is*.

Every rung of `NAME_DISCLOSURE` is configuration: three values, one predicate,
no new tables, no new screens. An `invite` rung is not that. It is a feature —
a code to store on `organizations` (a migration), a route to mint and rotate
it, an owner-only authorization for that route, a redemption path that joins
the new account to the right school in the same transaction, a revocation
story, a contract field, a form field, and a screen explaining a wrong code.
**A half-built invitation mechanism is worse for a province than none**,
because it is the one an operator will trust.

It stays cheap to add: the switch is a closed enum rather than a boolean, so
`invite` later is one enum member and one migration, with no contract break —
a client asking "is there a form" asks `=== 'open'` and is unaffected.

| Alternative | Why not |
| --- | --- |
| **`open` as the default** (today's behaviour) | It is the measured gap. Kept as a rung. |
| **`invite` in this slot** | Above. Additive later at one enum member. |
| **A deployment-wide `REGISTRATION_CODE`** — the cheap `invite` | Rejected outright: one secret shared by a whole province, revocable only by rotating it for everybody, unattributable to any teacher or school, and leaked by one photograph of a whiteboard. It would also be a *second* switch, which is the shape D198 exists to prevent. |
| **Delete the endpoint** | A route that exists on some hosts and not others is a fork of the contract, not a policy. |
| **A role gate with no rung** | That is `closed` with no way back for a public judge, and it would have made the e2e walks the argument for weakening it. |

### The one caller who is not refused

**A global admin**, and deliberately not a setter. Minting an account is
*speaking for the school*, which is D61's own test for who may run a roster
import (owner or global admin, never an organization `admin`); with no
organization in the request there is no owner to be. D197 admits setters to
`authority` because a fresh province has no organizations yet and its own
staff must be able to read a name — a different question from who may create
people.

Two consequences hang off `isTrustedRegistrar`, separately from "may they
register":

- **D26's meter is skipped.** What it bounds is the cost of an *anonymous*
  argon2id hash, 30 per IP per hour. An admin seating a late arrival is not
  that caller — they already hold `org:import` and its two thousand rows — and
  metering them on the classroom's own NAT address would refuse the operator.
- **A taken address is answered honestly**, `409 email_taken` rather than
  D26's fake 201, on the pre-check *and* on the racing INSERT so the two
  cannot disagree.

**One thing the bypass deliberately does not do**, named so it does not read
as an oversight: an account created this way does **not** carry
`mustChangePassword`. D61 sets it because a class's passwords were generated
by the server and printed on one sheet of paper; here an admin chose the
password and hands it over themselves, and a whole class still goes through
the import, which still sets it.

---

## 2. The verdict on D26's oracle, per rung

D26 has answered a fake `201` for a taken address since 29 August, and
recorded honestly that the compromise is *narrowed, not closed*: after the
fake 201 the account still does not exist, so a chained login or
`GET /users/{username}` tells the two outcomes apart at one extra request
each, and only the meter makes that expensive rather than free. That has been
an open gap in `PROVINCE-READINESS.md` for four days.

| rung / caller | what happens to the oracle |
| --- | --- |
| **`closed`, anonymous** | **Gone, not narrowed.** The refusal is a function of the rung and of who is asking, and of nothing whatsoever about the request body. Every anonymous caller gets the identical 403 for every address, including addresses that have never existed — and gets it *before* the meter and *before* the address is looked at, so there is no timing shadow either. There is no longer an experiment to run: the endpoint's answer does not depend on any account, so it cannot report on one. |
| **`closed`, signed-in `user` or `setter`** | The same 403, the same way. |
| **`closed` or `open`, global admin** | Told the truth (`409 email_taken`). This *narrows* D26 in exactly one place, on D61's argument: the caller is session-authenticated and authorized, so this is not the anonymous oracle D26 closed, and an operator handed a phantom account with no way to find out is the worse outcome. |
| **`open`, anonymous** | **Unchanged.** D26 stands byte for byte, and `registration-policy.spec.ts` asserts it: a second registration on a taken address answers 201, echoes the submitted username, and writes no row. Full closure there still needs verify-before-create, exactly as D26 says. |

That is D155's structural argument said again on the other endpoint: what D26
forbids is a response that DIFFERS by account; this one differs by
deployment. The ordering is not a comment —
`registration-policy.spec.ts` pins it with a database handle and a rate
limiter that throw on *any* property access (`mail-unavailable.spec.ts`'s
shape), so the test cannot pass unless nothing else ran, and **thirty-five
refusals from one address leave zero rows in `rate_events`**, so a stranger
knocking cannot lock a school's NAT out of a window it never consumed.

`PROVINCE-READINESS.md`'s gap 2 is struck through with the residual named and
scoped to the `open` rung.

---

## 3. How the operator-driven account paths keep working

| Path | How it survives `closed` | Verified |
| --- | --- | --- |
| **D61 bulk import / `org:import`** | Never touches this endpoint. It mints rows directly, authorized by the caller's standing in a *named school* — a thing `REGISTRATION` does not speak about. This is the path a province is told to use *instead* of signing up, and it is an audited entry in D201's census. | `orgs.spec.ts`, unchanged and green |
| **D19 `bootstrap:admin`** | A CLI against `DATABASE_URL`, not a route — which is why an HTTP endpoint that mints admins does not exist. It also has to work on a stack with no admin yet, the one situation in which the bypass has nobody to be. | `packages/db/test/bootstrap-admin.spec.ts` (4), green |
| **D155/D157 password reset** | About an account that already exists; untouched. Its own uniformity argument (503 by deployment, dispatch-not-await) is unaffected. | `mail-unavailable.spec.ts`, `account-recovery.spec.ts`, green |
| **The e2e walks** | Below. | typecheck + lint over `apps/web/e2e` |
| **The API suite** | `TEST_ENV` sets `REGISTRATION=open` **explicitly**, with the reason in the file. Forty specs register to get an account; making each acquire an admin cookie would test the harness and delete the coverage of the register endpoint those specs are actually about. The other rung — the one production is on — is exercised through `configOverrides` in `registration-policy.spec.ts`. | 158 files green |
| **`apps/oj`, `apps/mcp`** | Checked rather than assumed: neither calls `POST /auth/register`. Both authenticate with tokens, which the route refuses anyway — it carries no scope marker, so `ScopeGuard`'s deny-by-default answers 403 `scope_required` before the handler, unchanged since before this slot. | `git grep` over both apps |

### The walks specifically, since the brief asked

`ensureAccount` registered **anonymously**, which a judge on the default rung
refuses. The walks keep working by using the one caller a closed judge admits
— **a global admin**, which is exactly what a rehearsal harness seating fixed
accounts on somebody's judge *is*. Every call site already had an admin
context in scope. **The alternative was weakening the default so the tests
kept passing, which would have made the policy a decoration**, and it was
refused.

The change also fixed a real bug it surfaced. The login probe ran on the very
context it registered through, so **the second call of a loop was made by
pupil one rather than by the admin** — `contest-day` journey 2 papered over it
by re-authenticating after the loop, and it was invisible only because the
anonymous path happened to work. The probe now runs on a throwaway context, so
the admin context stays the admin and that re-authentication is gone.

**The walks were not run, deliberately.** They register accounts on the live
judge, and this brief's live-database authorisation covers the cleanup only
(F-55 set the same precedent). The change is safe against *both* the deployed
edge and the new code: admin-context registration is a 201 under `open` (what
the edge runs today) and under `closed` (what it runs next deploy). Verified
by `tsc -b` and `eslint e2e`.

---

## 4. What the visitor is told

A sign-up form that 403s once five fields have been typed is worse than no
form: the visitor cannot tell whether they did something wrong, and the next
thing they try is another spelling of their address. D145's rule is the one
that applies.

- **`GET /auth/registration`** is `@Public()` and carries the rung and nothing
  else — no count, no roster, no address. Disclosing "this site does not take
  sign-ups" *is* the message; it is not a leak. It returns the rung name
  rather than a boolean, so a later `invite` needs no client change.
- **`/register` asks before it draws the form.** On `closed` it renders, in
  the active locale (D18, both catalogues, Vietnamese by default):

  > **Trang này không nhận đăng ký. Tài khoản ở đây do nhà trường tạo.**
  > Hãy hỏi thầy cô hoặc người quản trị hệ thống để được cấp tài khoản. Nếu
  > bạn đã có tài khoản nhưng không đăng nhập được, hãy đặt lại mật khẩu.

  and two links: sign in, and **Quên mật khẩu?** — the case most often
  mistaken for "I must need to sign up again". `role="status"`, not
  `role="alert"`: nothing failed and the visitor did nothing wrong.
- **The form still renders while the query is in flight.** The answer is one
  field off a boot-time variable on the same origin; a spinner over a sign-up
  form is a worse first impression than a form that appears a frame later.
- **The race is handled as a page, not as an error.** A `registration_closed`
  at submit — the rung changed under an open tab — writes `closed` into the
  cache and flips the page to the notice, which is the page that visitor
  should have seen. An unreachable endpoint is `LoadError`'s case and is shown
  rather than swallowed (B-8's swallow, D145's rule).
- **The nav and sign-in links to `/register` are deliberately left alone.** A
  link to a page that explains itself is honest; hiding it would need this
  query in the shell nav on every page of the app, and a visitor who got the
  URL from an out-of-date printout would then land on a 404 instead of an
  explanation.
- **The runbook's own walkthrough was corrected.** Its "author a problem end
  to end" recipe opens by registering a setter anonymously, which now answers
  403 on a default stack; the note says to run `bootstrap:admin` first and
  register with the admin's cookie jar, or to set `REGISTRATION=open` for the
  sequence exactly as transcribed. The bring-up transcript's "register through
  Caddy returned 201" line is annotated the same way — a 403 through Caddy
  proves the same three things a 201 did, and `GET /auth/registration` is the
  200 that needs no account. And "Bootstrapping the first admin" now says that
  since D200 the CLI is the only way onto a default stack at all, which is
  exactly why the closed rung has no bootstrapping problem (D19 made it a CLI
  rather than a route for an unrelated reason and paid for this one too).
- **The guides say it too.** `docs/guide/hoc-sinh.md`'s "1. Đăng ký" now opens
  by saying most schools do not take sign-ups and that the notice is the
  design rather than a fault;
  `docs/guide/truoc-khi-trien-khai.md`'s go-live checklist says a 403 at step
  8.2 is the **correct** result on the default rung, and how to make a test
  account without one.
- **The operator can see the rung.** Both `NAME_DISCLOSURE` and
  `REGISTRATION` were reported in `GET /admin/dashboard` and rendered nowhere
  — reading them meant a curl. They are now two stats on the operations
  dashboard, with the variable name and what empty means in the tooltip. The
  value is the rung's own identifier, untranslated, because it is the string
  an operator types into `.env`.

---

## 5. One switch, and the guard (D201)

`registration-guard.spec.ts` scans `apps/api/src`, `packages/` **and
`scripts/`** for two claims.

1. **The mint.** Every `INSERT` into `users` outside the sanctioned module
   must call the predicate in its own function or hold an audited entry
   naming the operator whose authority stands in for the policy. Four paths
   mint today:

   | path | verdict |
   | --- | --- |
   | `auth.service.ts::register` | **routed** — asserts the policy in its own body |
   | `org-import.core.ts::runImport` | audited — D61, standing in a named school |
   | `scripts/bootstrap-admin.ts::bootstrapAdmin` | audited — D19, possession of the database |
   | `scripts/seed-problem.ts::(top-level)` | audited — the locked `system` row, `passwordHash: '!'`, not a person |

2. **One switch, read in one place.** `config.registration` may be branched on
   in one module. The dashboard *reports* it through `registrationOf`, so it
   never names the field and never appears.

**`scripts/` is in the walk, and that is load-bearing rather than thorough.**
Two of the four mints are CLIs, and it is the CLIs a reader is most likely to
forget exist. A floor of four hits with at least one routed keeps a rename
from making the scan vacuously green, and a removed mint fails as a stale
entry.

**This is why `AuthService.register` asserts the policy a second time.** The
controller must refuse first — before the meter and before the address is
looked at, or the ordering leaks — and the second call is what lets the guard
establish the property by *reading the source* rather than by trusting a
caller. Two calls to one pure predicate are one policy.

### The scanner became one implementation, and that found two bugs

D113 and D198 each carried a hand copy of the same scan machinery; this would
have been the third. It is now `apps/api/test/source-scan.ts`, and extracting
it found two bugs **both existing copies shared**:

- **A one-line call statement matches the declaration regex.** So the very
  predicate a guard scans *for* became the "enclosing function" of every hit
  below it — D201's first run reported
  `auth.service.ts::assertRegistrationOpen` as the thing that mints an
  account. A declaration header never ends in a semicolon; a statement always
  does, and that is now the test.
- **The upward search walked past the end of a function.** A one-file CLI is
  mostly module-level statements (`seed-problem.ts` does its whole job inside
  a top-level `try {`), so its work was attributed to the last function it
  happened to *define* — the census would have sent a reader to
  `seed-problem.ts::readProblemMeta`. A closing brace in column 1 now ends the
  search.

Both fixes apply to D198's guard as well, which is the point of there being
one copy. `team-participation-invariant.spec.ts` (D113) is deliberately not
migrated: its scan has no notion of a routed body, so moving it would widen
the module for one caller and re-prove a guard this slot is not touching.

---

## 6. Demonstrated red

Every load-bearing choice was reverted and measured, not asserted.

| Change | Red |
| --- | --- |
| the true pre-D200 shape — the default at `open` (schema **and** `registrationOf`) | **2 of 18** |
| a **setter** counted as a trusted registrar | **2 of 18** |
| the refusal moved **after the meter** — the 429 a stranger could inflict on a school's address | **1 of 18** |
| the honest 409 removed — a trusted registrar back on D26's fake 201 | **1 of 18** |
| **D201**: the service's own assertion removed, so the mint is unrouted | **3 of 5**, naming the file and the function |
| **D201**: a plausible new mint — an admin "create user" route in `admin-users.controller.ts` | **1 of 5**, with the two legal moves in the message |
| the web notice removed — the closed state not said | **2 of 22** (web) |
| **D202**: `onlyPredicate` returning `true` unconditionally | **1 of 17** (db) — see below |

The last row is the one worth reading twice. Before the test was written,
that revert — precisely the bug that turns an authorised two-row run into a
467-account one — left the **entire cleanup spec green**, because every
assertion in it read a plan built *without* the flag. The spec now builds the
plan both ways. A destructive flag with no test is worse than no flag.

---

## 7. The cleanup: the dry-run inventory beside what it removed

The unscoped dry run is the reason `--only` exists (D202). It is what the
cleaner would have done if run as the brief's sentence literally reads:

```
Would delete, in foreign-key order:
  …
  submission_cases               8548
  submissions                    933
  contests                       205
  problems                       80
  organizations                  32
  users                          467

15047 rows in 32 tables.
```

That is a hundred and eighty times the authorisation, and every row of it is
litter the patterns legitimately claim — the point is not that the cleaner is
wrong, it is that "run the cleaner for these two accounts" and "run the
cleaner" were the same command. The cleaner had no way
to express "these two accounts", so **`--only` was added** — it intersects an
explicit list of natural keys with the allow-list, *after* the deny-list, so
it narrows and can never widen (`--only duckadmin` deletes nothing) and the
blockers still run unchanged over the narrowed set.

**The dry run, scoped** (`--only f56probe1,b35-probe-1788313721`, read-only
transaction, rolled back):

```
DRY RUN — read-only transaction, rolled back. Nothing was changed.

Matched the allow-list: 2 users, <NULL> contests, <NULL> problems, <NULL> orgs,
                        <NULL> teams, <NULL> problem sets.

REFUSED — a kept row depends on these (0):     (none)
DISCLOSED — kept accounts lose these anyway (0): (none)

Would delete, in foreign-key order:
  rate_events                    22
  sessions                       1
  users                          2

25 rows in 3 tables.
```

**What it actually removed** (`CONFIRM=yes … --only … --apply`, one
transaction, committed):

```
APPLIED — one transaction, committed.

Matched the allow-list: 2 users, <NULL> contests, <NULL> problems, <NULL> orgs,
                        <NULL> teams, <NULL> problem sets.

REFUSED (0): (none)     DISCLOSED (0): (none)

Deleted, in foreign-key order:
  rate_events                    22
  sessions                       1
  users                          2

25 rows in 3 tables.
```

**Identical, line for line.** Verified afterwards by read-only `SELECT`:

```
select count(*) from users where username in ('f56probe1','b35-probe-1788313721');  → 0
select count(*) from rate_events where key in ('user:487','user:503');              → 0
select count(*) from users;                                                          → 496   (was 498)
```

`scripts/integrity-check.ts --live`: **27 checks, 0 with violations (high 0,
medium 0, low 0)**.

### The two pattern changes behind it

- **`^f[0-9]+probe`.** F-55 said to add a pattern the day an F slot minted a
  live row under its own name, and guessed the shape would be `^f[0-9]+-`. It
  is not: the row is `f56probe1`, no separator, written the way `probe1` was.
  The pattern is `f`, digits, the literal word `probe` — it claims what
  exists, and not `^f[0-9]+`, which would claim every future name beginning
  with a letter and a digit.
- **`rate_events` is now modelled, narrowly, and F-55's stated reason is what
  changed.** F-55 left the table alone because the classification "cannot
  actually prove" a `user:<id>` row belongs to the account being deleted.
  Measured, that is true of **exactly one purpose**: `login` keys on the
  SUBMITTED identifier so an unknown username still has a window (D16), and a
  username may be three digits. Every other purpose builds the key from
  `users.id`. So the step is `purpose <> 'login'`, that exclusion is the whole
  correctness argument, and it has its own assertion. The 22 rows under
  `user:487` were 20 `user_walk` and 2 `refused:user_walk`, with no `login`
  row among them.

  It remains **tidiness rather than a fix**: `rate_events` has no foreign key
  to `users`, a leftover row joins to nothing and discloses nothing, and those
  22 rows (written 01:48–01:55 on 2026-09-02) would have been swept by
  `expired-rows.sweeper.ts` at its 24-hour retention by 02:55 on 2026-09-03
  without anybody doing anything.

**Nothing was widened beyond the two accounts**, and the dry run's suggested
apply command now repeats `--only`, because a hint that is not the command
whose plan is on screen is a trap.

**Re-measured unscoped after the fact**, as the arithmetic check that the run
took the twenty-five rows it said and nothing else:

```
Matched the allow-list: 493 users, 213 contests, 80 problems, 32 orgs, 87 teams, 26 problem sets.
  users                          465        (467 before, minus the two)
  rate_events                    131        (153 before, minus the twenty-two)
15022 rows in 32 tables.                    (15047 before, minus twenty-five)
```

The residual 15 022 rows are the rest of the loop's litter, still there and
still out of this slot's authorisation.

---

## 8. Verification

| Package | Result |
| --- | --- |
| `@duckoj/api` | **`Test Files 158 passed (158)` / `Tests 1332 passed (1332)`** |
| `@duckoj/web` | **`Test Files 75 passed (75)` / `Tests 798 passed (798)`** |
| `@duckoj/db` | **`Test Files 20 passed (20)` / `Tests 102 passed (102)`** |
| `@duckoj/contracts` | **`Test Files 9 passed (9)` / `Tests 39 passed (39)`** |
| `@duckoj/sdk` | **`Test Files 1 passed (1)` / `Tests 2 passed (2)`** |
| `corepack pnpm -r typecheck` | clean in every workspace, plus `typecheck:scripts` |
| `corepack pnpm -r lint` | clean in every workspace (`apps/web`'s covers `src`, `test` **and** `e2e`), plus `lint:scripts` |
| `openapi.json` + `packages/sdk/src/generated.ts` | regenerated, committed, and `git diff --exit-code` clean against a fresh regeneration |
| live | `integrity-check.ts --live` — 27 checks, 0 violations |

`pnpm verify` was **not** run: it ends in `vite build`, which this brief
forbids. Its contract-drift guarantee was obtained separately by regenerating
`openapi.json` and the SDK after the last contract change and diffing.

---

## 9. What I could not finish, and what is deliberately left

- **The default is not live.** `closed` becomes this province's rung at the
  next deploy, which this slot may not perform. Until then the edge answers
  201 to an anonymous registration, and `NAME_DISCLOSURE`'s default and
  migration 0049 are in the same waiting room (F-55). Deploying is one
  decision and it is not this slot's.
- **`open` still carries D26's residual**, and closing it there needs
  verify-before-create — a change to the signup flow (an account that does not
  exist until a mail is confirmed) that would remove the "registering signs
  you in straight away" property D26 protected. Recorded in
  `PROVINCE-READINESS.md` scoped to that rung rather than as a whole-product
  gap.
- **No `invite` rung.** Argued in §1 rather than run out of time on: it is a
  feature, not a rung, and the enum is shaped so adding it is one member and
  one migration.
- **The e2e walks were not executed.** They write to the live judge, which
  this brief does not authorise. Their change is typechecked and linted and is
  correct against both the deployed rung and the new one; the first real
  exercise is whoever next runs a browser walk after a deploy.
- **`team-participation-invariant.spec.ts` still has its own scan copy.** Two
  of the three guards now share `source-scan.ts`; the third has a different
  shape (no routed body) and migrating it would have meant widening the module
  for one caller and re-proving a guard this slot was not otherwise touching.
- **The admin guide (`docs/guide/quan-tri.md`) documents neither rung.** It
  did not document `NAME_DISCLOSURE` after F-55 either; the dashboard now
  shows both, which is where an operator actually looks, and a prose section
  on deployment switches is a doc task rather than a clause of this ruling.
