# F-57 — The walks under a closed judge

**Status**: done. The browser suite is green whole: **`78 passed (8.0m)`**,
against the live edge at `01e59f2`, `--workers=1`. The four blocked walks are
unblocked, the fourteen that never ran now run, and journey 1 covers both rungs
of D200 — one for real, one behind a stub of its own probe, with the third
thing it cannot reach named rather than simulated (**D203**).

No container was started, stopped or restarted; `podman-compose`,
`scripts/compose-up.sh` and `scripts/deploy.sh` were never run. The live `.env`
was never opened for writing. `apps/web/dist` was never written and no
`vite build` ran — the edge carried the bundle every walk drove, which is what
makes the run an honest instrument. Nothing under `.secrets/` was read, printed
or committed by me; `credentials.ts` parses it at run time, as it always has.
**The live database was read only** — no cleanup was run, because unlike F-56
this brief authorised none.

---

## Commits

`HEAD` before the slot was `01e59f2`. Nothing pushed.

| | |
| --- | --- |
| `6309fe2` | `test(e2e)` — the last three self-registering walks mint their pupils as the admin |
| `41ea77e` | `test(e2e,D203)` — journey 1 walks both rungs: one for real, one behind its own probe |
| `a1808c7` | `docs(ops)` — gap 4 said a green walk was red on purpose, and it is not |
| *(this commit)* | `docs(f57)` — this report |

---

## 1. The suite, whole

```
78 passed (8.0m)
```

Every file, `--workers=1`, `nice -n 19`, against `http://localhost:8080`. The
before picture from the brief was `4 failed · 14 did not run · 59 passed`; the
fourteen were journey 2–8 and the rest of `authoring`/`features` behind a
serial failure, and they collapse to zero the moment journey 1 passes, exactly
as expected. The count goes 59 → 78 rather than 59 → 77 because journey 1 is
now two walks.

**An exit code is not evidence and this campaign has been burned twice**, so
two specific things were checked rather than assumed:

- **`a11y-axe.spec.ts` really swept.** Re-run alone: `8 passed (43.3s)`, five
  public screens (`/`, `/register`, `/problems`, `/help`, `/contests`) plus the
  authenticated screens, a submission page and the admin dashboard. It cannot
  silently no-op: the source comes from `require.resolve('axe-core/axe.min.js')`
  (a missing package throws at collection), it is injected through
  `page.evaluate` and never `addScriptTag` because CSP blocks inline scripts
  (D120), and if `window.axe` were absent the `axe.run` inside the next
  `evaluate` would reject rather than return an empty violation list.
  `/register` is in that sweep and now renders the refusal notice, which passed.
- **Journey 1b really talks to the server.** See §3's reds.

Also run, because `apps/web` was touched: **`Test Files 75 passed (75)` /
`Tests 798 passed (798)`** (vitest, `--no-file-parallelism`),
`corepack pnpm --filter @duckoj/web typecheck` clean, and
`corepack pnpm --filter @duckoj/web lint` clean — which covers `src`, `test`
**and** `e2e`. No other package's source was touched; `docs/` carries no suite.

---

## 2. Accounts arrive the way a school makes them

Four files still self-registered. All four now mint through a global admin's
own API context — the one caller a closed judge admits — in the shape
`organiser.spec.ts` established at `91a8402`.

| file | what changed |
| --- | --- |
| `authoring.spec.ts` | journey 3's `bh16-pupil-…` |
| `features.spec.ts` | `register()`, feeding scenarios 1 and 2 (`bh14-*`) |
| `smoke.spec.ts` | the submissions test's `e2esub…` |
| `journey.spec.ts` | `register()`, feeding journeys 2, 3, 4, 5, 7, 8r, 8s (`e2e*`) |

**This is not only expedient, it is the more faithful rehearsal**, and that is
the argument that decided it: on a school judge no pupil ever signs themselves
up, so a suite that minted pupils that way was walking a path its users do not
take.

**Three details were carried over from the worked example rather than
reinvented**, because each is a bug someone would otherwise reintroduce:

- **The mint runs on its own context, never `page.request`.** That one shares
  the page's cookie jar, so a mint through it either speaks as whoever the page
  is signed in as, or leaves the page signed in as the admin behind its own
  back — the bug F-56 surfaced in `contest-day` journey 2.
- **A fresh `request.newContext` does not inherit `playwright.config.ts`'s
  `extraHTTPHeaders`**, so `Origin` is named explicitly on every admin context
  or D82's `CsrfOriginGuard` refuses every write it makes 403.
- **These expect `201` and nothing else.** `ensureAccount` tolerates 409
  because its usernames are FIXED and it is asking for an account to *exist*;
  every username here carries `RUN`, so a 409 would be a real collision, and
  accepting one would hide it.

**One distinction that mattered**: minting goes through the admin's
`POST /auth/register`, **not** through D61's `org:import`. Import is the other
operator path and would have been defensible, but it sets `must_change_password`
— the server chose those passwords and printed them on one sheet — and while
that flag is set D102 mints no token and honours none, so every walk that then
signs in as the pupil would fail on a forced password change it is not about.
An admin-minted account carries no such flag (F-56 §1 states this deliberately),
so the sign-in each walk chains is an ordinary one. `features.spec.ts` feature 7
still walks the import *and* its forced first-login change, which is where that
path belongs.

**Two obsolete comments were retired rather than left to mislead.** Both
`features.spec.ts` and `authoring.spec.ts` budgeted their pupil *count* against
D26's 30/IP/hour window. A trusted registrar skips that meter entirely (D200 —
what it bounds is the cost of an anonymous argon2id hash), so the count is now
merely what the walks need, and a reader who believed the old comment would
have refused to add a third pupil for a reason that no longer exists.

**One dependency was added and is said out loud**: `smoke.spec.ts` now needs
the operator's credentials for one of its nine tests, where before it needed
none. There is no way around it — a closed judge mints accounts for nobody
else — and the alternative, reusing a pre-seeded pupil, would have given up the
"reproducible against any freshly-migrated stack" property that test was
written for. The other eight tests in the file are still anonymous.

**Litter.** A run mints ~11 new accounts: seven `e2e*` (journey), one `e2esub*`
(smoke), two `bh14-*` (features), one `bh16-*` (authoring). Checked against
`scripts/cleanup-test-data.ts` **before** the run rather than after: `^e2e` and
`^bh[0-9]+` both already claim them, as do `^fe[0-9]+` and `^rehearse-` for the
fixed accounts the other three files reuse. **No pattern needed adding and no
cleanup was run** — this brief's live-database authorisation is read-only.

---

## 3. Journey 1, and the two rungs (D203)

Journey 1 could not be converted, and the brief said why: it exists to test the
**form**. On the rung this province runs there is no form on the screen.

The general problem is not registration. It is: **a browser suite runs against
one live deployment, a policy has N rungs, and the deployment holds exactly
one.** `NAME_DISCLOSURE` (D197) has three rungs and the same question waiting,
so D203 writes the answer down once, as three tiers a walk must declare:

| tier | what is faked | what it proves |
| --- | --- | --- |
| **1 — the held rung** | nothing at all | the deployment's real behaviour, end to end |
| **2 — another rung's CLIENT surface** | the one response the client reads the rung from, and nothing else | the bundle renders and behaves correctly on that rung |
| **3 — another rung's SERVER surface** | — | **not walkable.** Name it; do not simulate it |

### Journey 1a — tier 1, and it fakes nothing

`journey 1a — a judge that takes no sign-ups says so at the door, in Vietnamese
and in English`. An anonymous visitor follows the **nav** to `/register` — the
link is deliberately still there under `closed`, because a link to a page that
explains itself is honest — and meets the refusal:

- the `role="status"` notice, verbatim, because the sentence *is* the feature:
  *"Trang này không nhận đăng ký. Tài khoản ở đây do nhà trường tạo."*
  `status` and not `alert`, asserted by role, because nothing failed;
- the "ask your teacher" sentence;
- **no form at all** — asserted on two separate fields *and* the submit button,
  so a form that merely lost one input is not mistaken for a form that was
  never drawn;
- D145's two next moves: *Đã có tài khoản? Đăng nhập*, and *Quên mật khẩu?* —
  the case most often mistaken for "I must need to sign up again";
- then the EN toggle, and the same notice out of the other catalogue (D18),
  plus the nav's `Problems`/`Contests`/`Sign in`, and the choice surviving a
  navigation to `/problems`.

**This is the walk that did not exist.** The refusal is what a real visitor to
a province's judge now meets, and before this slot the shipped behaviour was
less covered than the behaviour it replaced.

### Journey 1b — tier 2, one field wide

`journey 1b — the sign-up form itself, on the `open` rung, and the refusal that
arrives mid-form`. `page.route` answers `GET /api/v1/auth/registration` with
`{"registration":"open"}`, installed before the first navigation because the
query fires on mount and holds its answer for the life of the page
(`staleTime: Infinity`). **That is the whole fiction.** Everything after it is
the real thing:

- the real bundle draws the real form;
- the mismatched confirmation (valid on every other rule, so the `else` behind
  the length check is the rule being proved) is refused by the real client-side
  validator, with **no request leaving the browser** — the watchdog allows
  exactly one 403 on `/auth/register` and nothing else, so a form that posted
  anyway fails here rather than passing quietly;
- the corrected submit goes to the **real API**, which refuses it 403 — and
  that refusal is itself a shipped path worth walking: the rung changing under
  a tab that already had the form open, where `register.tsx` writes the rung
  into its cache and **flips to the notice** instead of raising an error. The
  walk asserts the notice, and that the form is gone with it.

### What is not walked, named rather than faked

**The `open` rung's SERVER surface**: an anonymous `201`, and the sign-in the
page chains onto it. Reaching it needs the deployment on `REGISTRATION=open`,
and this brief forbids editing the live `.env` and restarting a container. So
it is a gap with a name.

**Stubbing the POST as well was considered and refused**, and it is the
alternative worth stating because it is the tempting one: the walk would assert
the page against a fiction of its own writing — the response shape, the cookie,
the chained login — and would go on passing after the server stopped producing
any of it. A test whose oracle is itself tests nothing. Signing the browser in
as an admin and letting the form 201 was refused too: the probe answers the rung
regardless of who asks, so an admin visiting `/register` *also* sees the notice,
and that walk would have had to stub the probe **anyway** and would then drive
a page state the product never renders, with an actor no visitor is, under a
name claiming a visitor registers. Two fictions instead of one.

One assertion genuinely died with the old walk: the English `Sign out` in the
nav, which needed a session a self-registration used to hand over. The signed-in
nav is asserted in Vietnamese by every `signIn` in the suite, and the English
nav is asserted in 1a and in `features.spec.ts` feature 1; the English
`Sign out` string specifically is now unasserted, and it is one string.

### Demonstrated red

Each walk's premise was removed and measured, not asserted.

| Change | Red |
| --- | --- |
| journey 1b's `403` allowance removed from the watchdog | **fails**: `page reported: 403 http://localhost:8080/api/v1/auth/register` — evidence a real request reached the real API and was really refused |
| journey 1b's stub answers `closed` instead of `open` | **fails** at the form's own submit button — evidence the stub is what puts the form on screen |
| journey 1a's probe stubbed `open` | **fails** at the notice — evidence 1a reads the deployment's actual rung and is not vacuously green |

---

## 4. One thing the run found

`PROVINCE-READINESS.md` gap 4 said two F-42 web fixes were "committed and **not
deployed**", and ended: *"Until the edge ships them, `e2e/organiser.spec.ts`
journey 2b is red on purpose."* Journey 2b passed, and its final assertion **is**
the stale-roster bug; `editor.spec.ts`'s draft walk, the other half, passed too.
`organiser.spec.ts`'s own docstring had already recorded the fix reaching the
edge — the readiness item had not caught up.

Struck with the evidence named (`a1808c7`) rather than quietly edited, because a
readiness doc telling the next reader that a green walk is an expected failure
is precisely how a real failure gets waved through — and this suite is the
campaign's verification instrument, which is the whole premise of this slot.

---

## 5. What I could not finish, and what is deliberately left

- **The `open` rung's server surface has no walk**, as above. It needs a
  deployment on that rung. The honest ways to close it, in order of cost: run
  the suite once against a stack whose `.env` sets `REGISTRATION=open` (a
  deployment decision, not a test one); or give the browser suite a second,
  scoped target the way `E2E_BASE_URL` already allows, which needs a stack to
  point it at.
- **Seven copies of the admin-mint helper now exist** across the e2e files
  (three from F-56, four from this slot). They are deliberately the same shape
  rather than one shared module: extracting it would have meant rewriting three
  green files against a live stack for a refactor this slot was not asked for.
  It is the obvious next tidy, and the shapes are identical enough that one
  `e2e/accounts.ts` would be a mechanical change.
- **No live rows were cleaned.** ~11 accounts per run, all under prefixes the
  cleaner already claims (§2). This brief's authorisation is read-only, so the
  scoped `--only` run F-56 built is there for whoever holds the authorisation.
- **The English `Sign out` nav string is unasserted**, §3.
- **`smoke.spec.ts` gained a credentials dependency** for one test, §2 —
  unavoidable, but a real reduction in what that file can prove on a bare stack.
- **D204 was not needed** and is unused, as the brief allows.
