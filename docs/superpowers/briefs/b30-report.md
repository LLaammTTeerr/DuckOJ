# B-30 report — hunting F-39 and F-40

**Status: complete.** Three defects found, each fixed with a test demonstrated
red against the unfixed code first. Four commits on `main`, **not pushed**,
**not deployed**. Two decisions spent (D157, D158); D159 unused.

Nothing was deployed, `podman-compose`/`compose-up.sh`/`deploy.sh` were never
run, `apps/web/dist` was never written, `.secrets/` was never read, and the
live database was read with `SELECT` only. Live rows **were** created by
probing over HTTP — see "Live artefacts" at the end.

---

## Defect 1 — a failing SMTP relay turns `POST /auth/password/forgot` back into D26's membership oracle

**Severity: high (privacy).** Not a wrong verdict, but it is the property this
codebase has spent two decisions defending, and F-40 is the commit that armed
it.

### What is wrong

D155's argument is that the 503 refusal is *structural*: it depends on
`mailer.kind` and `NODE_ENV`, never on the address, so it cannot answer "does
this person have an account here". That argument is sound **for the case where
there is no transport at all**. F-40's other half — `f63370c`, the six
`SMTP_*` variables finally reaching the `api` container — makes `SmtpMailer`
reachable in production for the first time, and opens the case D155 does not
cover: a transport that **exists and fails**.

`AccountRecoveryService.requestPasswordReset` returns at `if (!user) return`
for an address nobody here has, and reaches `await this.mailer.send(...)` only
for one somebody does. `AuthController.forgotPassword` does not catch, and
neither does anything between. So against a relay that is refusing — an
expired certificate, a rejected credential, `ECONNREFUSED`, every string D156
quotes as the reason its own test button exists — the endpoint answers:

| address | outcome before the fix |
| --- | --- |
| not registered here | `202 Accepted` |
| registered here | `500 Internal Server Error` |

No timing measurement is needed; the status line is the answer. And even when
nothing fails, only the address that exists pays an SMTP round trip, which is
the same oracle on the clock — the half D155 is explicitly careful about for
its own refusal.

### Reproduction

`apps/api/test/mail-failure-oracle.spec.ts`: production config, a mailer with
`kind: 'smtp'` whose `send` rejects, a database double that answers the one
lookup. Red against `cc23eb5`'s parent:

```
 ❯ test/mail-failure-oracle.spec.ts (4 tests | 3 failed) 130ms
   × ... > answers the same way for an address that exists as for one that does not 9ms
     → promise rejected "Error: 535 5.7.8 Authentication credentia…" instead of resolving
   × ... > does not make the caller wait for the relay, so the CLOCK says nothing either 107ms
     → expected 'still waiting on the relay' to be 'returned'
   × ... > records the failure where an operator can find it 2ms
     → 535 5.7.8 Authentication credentials invalid
```

### Fix — D157

The send is **dispatched and not awaited**, and its failure logged as `ERROR`
rather than raised. Both halves, because awaiting at all leaves the timing
oracle open even when nothing fails.

This is not a return to the 202-that-means-nothing D155 removed: D155's target
is a deployment that structurally cannot deliver, which is knowable *before*
the request touches an address and is therefore sayable to everyone. A single
failed delivery is knowable only *after* the lookup, so saying it is the same
act as answering the membership question. The failure goes to the log and,
through the transport, to D156's dashboard — the two places that can carry it
without also answering a stranger.

`POST /auth/email/verify/send` is deliberately **not** changed: its caller is
signed in and the address is their own account's, so there is no third party
to leak to and a truthful 500 is better than a silent 202.

Green:

```
 ✓ test/mail-failure-oracle.spec.ts (4 tests) 31ms
 Test Files  5 passed (5)   Tests  40 passed (40)
```
(with `mail-unavailable`, `account-recovery`, `mail-smtp-delivery`,
`register-verification` — D155's own specs still pass unchanged.)

---

## Defect 2 — the submit picker preselects C11, and which language it preselects depends on how the pupil got to the page

**Severity: high (contest day).** This is the closest thing in the hunt to a
wrong verdict: it makes a *correct C++ program* compile as C.

### What is wrong

Two bugs in one place.

**(a) The API's menu order is an accident.** `loadLanguageLimits` ended
`.orderBy(asc(schema.languages.key))`, and the first entry of
`ProblemDetail.languageLimits` is what the submit picker preselects. `c` sorts
before `cpp`. Read off the **live stack** at `e7d782f`:

```
$ curl -s http://localhost:8080/api/v1/problems/aplusb | jq '[.languageLimits[].languageKey]'
["c11","cpp14","cpp17","cpp20","python3"]
```

The preselected language also decides the editor's starter template, the draft
key, and what `POST /submissions` is sent. A pupil who paged in and pressed
Submit was offered **C11 with a C starter template on every problem on this
site**. Paste a C++ program into it and the verdict is Compile Error.

**(b) The selection is captured, not derived.** `SubmitPage` reads the
catalogue through TanStack Query under `['problem', code]` — **the same key
`apps/web/src/routes/problem.tsx:40` uses**. So `SubmitForm` has two different
first renders:

* *cold* (a direct link to `/submit`): the query has not answered, the form
  mounts against `FALLBACK_LANGUAGES` and `useState(firstLanguage)` locks in
  `cpp17`;
* *warm* (read the statement, press Submit — the ordinary path): the cache
  answers synchronously, the form mounts against the real catalogue and locks
  in `c11`.

`useState` never revisits its initialiser, so the default depended on how the
pupil arrived. Worse, on a problem with `allowed = false` for the fallback
language, the state kept pointing at a language the picker no longer listed:
the select showed **Python 3** while the button posted **`cpp17`**, and D154's
404 `language_not_found` refused a submission the pupil made correctly.

### Reproduction

`apps/web/test/submit-language-default.spec.tsx`, red against `d779b02`'s
parent:

```
 ❯ test/submit-language-default.spec.tsx (2 tests | 2 failed) 264ms
   × ... > is the same whether the pupil arrived by link or from the statement page 68ms
     → expected 'c11' to be 'cpp17' // Object.is equality
   × ... > is always a language the picker actually lists 195ms
     → expected 'cpp17' to be 'python3' // Object.is equality
```

The second is the sharper one: it clicks the button and reads what was
*posted*, which is the thing the DOM's `select.value` hides.

`apps/api/test/problem-language-limits.spec.ts`, red against the same parent:

```
 × GET /problems/:code — the limits each language really gets > shows C++ the authored limits and Python the adjusted ones
   → expected [ 'c11', 'cpp14', 'cpp17', …(2) ] to deeply equal [ 'cpp17', 'cpp20', 'cpp14', …(2) ]
```

### Fix — D158

* `.orderBy(asc(schema.languages.id))` — the order an operator **added** them.
  `cpp17` is id 1: the only language this judge had for its first fortnight,
  the language every authored `time_ms` on the site is written against, and
  what the picker offered before F-39. The rest follow migration 0042's own
  order. Stated in `ProblemDetail`'s contract, because an order a client
  depends on is part of the contract.
* `SubmitForm` holds the pupil's **own** choice (`null` until they make one)
  and derives the key: `chosen`-if-offered, else the first on offer. Cold and
  warm now agree, and a choice that is no longer offered cannot be posted into
  a 404.

`GET /languages` keeps its own order (by key): it is a catalogue to look a key
up in, not a menu.

Green: `Test Files 66 passed (66)  Tests 742 passed (742)` (`apps/web`,
whole package) and `Test Files 5 passed (5)  Tests 90 passed (90)`
(`apps/api` problem specs).

---

## Defect 3 — the draft you left in the other language is unreachable, and the first keystroke after a switch destroys it

**Severity: medium (lost work).** No verdict is wrong; a pupil loses a
half-written program, which D84 exists to prevent.

### What is wrong

D84 keys drafts per (problem, language) with an explicit reason:

> a pupil who tried C++ and then switched to Python has two different
> half-finished programs, and one key would silently overwrite the first with
> the second.

The half that had never run is the pupil coming **back**. `changeLanguage`
only read the target language's stored draft when `source === ''` — and the
buffer is never empty, because an editor with no draft opens on the first
language's **starter template**. So the gate could not fire. Every draft
except the one the page opened on was unreachable through the picker; the
pupil switched to Python, saw their C++ program, and the first keystroke filed
it over the Python program they had come back for.

F-39's own test ("types C++, switches to Python, types Python, finds both
drafts under their own keys") passes against the bug, because it never puts a
draft in the language being switched to.

### Reproduction

Two tests added to `apps/web/test/editor.spec.tsx`, red against `6d9c256`'s
parent:

```
 ❯ test/editor.spec.tsx (18 tests | 2 failed) 1164ms
   × ... > gives back the draft waiting in the language switched TO (D84) 42ms
     → expected '#include <bits/stdc++.h>\nusing names…' to be 'print(1)'
   × ... > does not file the carried-over buffer over the draft it found there 38ms
     → expected 'int main(){}\n' to be 'print(1)\n'
```

The second is the data loss: the stored `python3` draft came back as the C++
program.

### Fix

A stored draft for the language being switched **to** wins. It costs nothing,
because the buffer it replaces is already filed under its own key — that being
the entire point of a per-language key. `useDraft` gained a `flush()` so a
write still inside the 500 ms debounce window cannot land *after* the read.
With nothing waiting there the code is kept, exactly as before ("a pupil who
opens the dropdown to read the options must not lose a half-written program to
it"), and only an empty editor takes the new starter template.

No decision spent: this restores D84's stated behaviour rather than changing
it.

---

## Surfaces examined and found clean, and how

### F-39

**`effectiveLimits` in two processes.** The brief asked for an input where
`apps/api` and `apps/judged` disagree. There is none, and the reason is
structural rather than lucky: both import the same function from `@duckoj/db`,
and both *select the inputs* rather than computing anything in SQL
(`JobStore.claim` selects `language_time_pct`, `language_memory_extra_kb`,
`override_time_pct`, `override_memory_extra_kb`;
`ProblemAccessService.loadLanguageLimits` selects the same four). I read both
call sites line by line. The two input divergences are real and both are
deliberate:

* a **problem row with no revision**: `judged` falls back to 1000 ms /
  65536 KB (a revision predating the columns), the API returns `[]`. The API's
  is a display of nothing; `judged`'s is a job that must still grade.
* the API resolves against the **currently published** revision's limits,
  `judged` against the submission's **pinned** revision. That is D9/D92
  behaviour and predates F-39; a republish is the only way to observe it.

Boundaries, evaluated against the built function rather than argued:

```
pct 0    -> {"timeMs":0,"memoryKb":256000}
pct -100 -> {"timeMs":-1000,"memoryKb":256000}
pct 1    -> {"timeMs":10,...}     pct 101 -> {"timeMs":1010,...}   (ceil, integral)
col-by-col: {timeMultiplierPct:150, memoryExtraKb:32768}  (override pins time, floor inherited)
no override: {timeMultiplierPct:300, memoryExtraKb:32768}
```

**Column-by-column inheritance is exactly what D154 claims**, proven above and
by `packages/db/test/language-limits.spec.ts`. A null override column
inherits; `allowed` is never consulted by `effectiveLimits`.

**`allowed = false` answers 404 on every route that can start a submission.**
There are exactly two places in `apps/api` that insert a `grading_jobs` row:
`submission.access.ts:334` and `rejudge.access.ts:222`. The first is the only
one that *creates* a submission — it serves both practice and contest
submissions through the same `contestKey` parameter, and it checks
`isActive && allowed` before anything is written, answering one 404
`language_not_found` for all three of "no such key", "deactivated" and
"refused". The MCP server's `submissions_submit` rides that same route through
the SDK and adds no path of its own. Rejudge re-queues an **existing** job and
deliberately does not re-check `allowed` (`job-store.ts`: "a job that exists
was already accepted, and refusing to grade it now would strand it as a
permanent IE"). I agree with that ruling and did not change it — but it is
worth stating plainly, because the brief guessed the opposite: **a rejudge
does re-run an old Python submission on a problem that has since refused
Python.** It is graded, not refused.

**Live end-to-end Python grading, which F-39 could not prove.** Submitted as a
test account against the deployed stack:

```
POST /api/v1/submissions {"problemCode":"aplusb","languageKey":"python3",...}  -> 201 {"id":818}
GET  /api/v1/submissions/818 -> state done, verdict AC, timeMs 77, memoryKb 15168
grading_jobs for 818: state=done, blocked_reason=NULL
```

15168 KB is CPython's resident floor — the number D154 measured (15044 KB) —
so the interpreter really did run. The live catalogue and mapping agree with
what the judge announces:

```
languages:            cpp17(1) cpp20(4) cpp14(5) c11(6) python3(7, 300%, +32768 KB)
language_driver_keys: cpp17->CPP17 cpp20->CPP20 cpp14->CPP14 c11->C11 python3->PY3
judge_nodes.capabilities: {"executors":["C11","CPP14","CPP17","CPP20","PY3"],
                           "languages":["c11","cpp14","cpp17","cpp20","python3"]}
```

The announced set and `language_driver_keys` are exact inverses on the live
fleet, so D68's `blocked_reason` path is not currently reachable there (queue:
817 done, 0 blocked).

**Language-family classification for the plagiarism report.** All five seeded
keys resolve: `cpp14/17/20 -> cpp`, `c11 -> c` (the `/^(g?cc?|c)\d*$/` arm),
`python3 -> python`. A key F-39 had left unclassified would have silently
dropped pairs out of a contest's similarity run; none is.

### F-40

**D155 over HTTP on the live production stack** — the thing f40-report admits
was never done. Both an address that exists and one that does not:

```
POST /api/v1/auth/password/forgot {"email":"bh30probe@example.invalid"}
  -> HTTP 503 mail_unavailable  time=0.002968
POST /api/v1/auth/password/forgot {"email":"nobody-bh30@example.invalid"}
  -> HTTP 503 mail_unavailable  time=0.002339
```

Byte-identical bodies, both under 3 ms, `NODE_ENV=production` and
`readyz` reporting `"mail":"log"`. **D155 holds as deployed** — it is only the
*configured*-transport case (defect 1) that was open.

**`POST /admin/mail/test` as a relay or a scanner.** The host, port and TLS
mode come from `AppConfig` and cannot be supplied by the caller, so it cannot
be pointed at an arbitrary host — it is not a scanner. `to` is
`z.string().email()` validated by `ZodValidationPipe` before the service is
reached. The controller carries `@SessionOnly()` class-wide and
`DashboardService.requireAdmin` gates every method, and
`route-marker-coverage.spec.ts` passes with the route present. There is no
password field on the panel for a secret to leak into, and the verbatim error
text comes from nodemailer, which does not echo the credential. It *is*
unmetered — an admin can loop it — which D156 states as a deliberate choice on
the same footing as every other button on that dashboard. I did not open a
real SMTP conversation against the live stack: it is on the no-op transport,
and `sendTestMail` refuses with 503 before dialling anything.

---

## Observations, not fixed

**Nothing constrains a multiplier to be sane.** Migration 0042 declares
`time_multiplier_pct integer` with no `CHECK`, and the only way to write a
`problem_language_limits` row today is raw SQL, because F-39 shipped the
column and the read path but not an authoring UI. A setter who types `0`
there gets `timeMs: 0` (evaluated above) — every submission in that language
TLEs, which is *precisely* the outcome D154 forbids: "a zero limit would
present the refusal as a TLE, teaching the pupil that their correct program
was too slow." A negative value gives a negative limit.

I did not fix it. The honest fix is a `CHECK (time_multiplier_pct > 0 AND
memory_extra_kb >= 0)` on both tables, and that is a schema migration this
hunt would be adding to production for a failure that needs an operator typo
to reach. It is safe to add whenever someone does — the live
`problem_language_limits` table is **empty** (0 rows) and every `languages`
row is 100 % or 300 % — and it belongs beside the authoring UI F-39 deferred,
which is the thing that will actually start writing those rows.

**The picker restores a draft on an explicit switch, not on the mount that
corrects an unofferable default.** Defect 2's fix derives the language key, so
on a problem whose `allowed = false` kills the fallback language the key flips
at *mount* without passing through `changeLanguage` — and defect 3's restore
lives in `changeLanguage`. So the surviving language's stored draft comes back
when the pupil switches to it, but not on the page load that lands them there.
Unreachable today: `problem_language_limits` has zero rows on the live stack.
Recorded rather than fixed, because closing it means moving the opening-buffer
decision out of the mount-time `useRef` and that is a larger change than the
case justifies.

**A student whose language no judge can grade is told nothing false, and
nothing at all.** `blocked_reason` is written by `judged` and read in exactly
one place: `dashboard.access.ts:502`, the admin panel. No student-facing
submission read carries it, so a job blocked because the fleet announces no
matching executor sits at `queued` indefinitely and the pupil sees "đang
chờ" — true, but silent. This is D68's design and predates F-39, and it is not
reachable on the live fleet today (the mapping and the announced set are exact
inverses, verified above). F-39 is what makes it reachable *in principle*, by
making it possible for the two to disagree. Worth a slot; not a defect I could
prove against the running system.

---

## Commits

| | |
| --- | --- |
| `cc23eb5` | `fix(auth)` — D157: a relay that fails must not tell a stranger the account exists |
| `d779b02` | `fix(submit)` — D158: the picker preselects C++17, not whatever sorts first |
| `6d9c256` | `fix(submit)` — the draft waiting in the language you switch TO comes back |

`docs/DECISIONS.md` gained **D157** and **D158**. **D159 is unused.**

## Verification

```
apps/web  (whole package)                              Test Files  66 passed (66)   Tests  742 passed (742)
packages/contracts (whole package)                     Test Files   9 passed (9)    Tests   39 passed (39)
apps/api, run by run (the specs touched, no others):
  route-marker-coverage, route-fuzz, route-contract-parity,
  admin-dashboard, mail-wiring, health, config             Test Files 7 passed (7)  Tests 53 passed (53)
  problem, problem-reads, problem-writes,
  problem-visibility, problem-drafts                       Test Files 5 passed (5)  Tests 90 passed (90)
  submissions, account-recovery, mail-unavailable,
  mail-failure-oracle, mail-smtp-delivery                  Test Files 5 passed (5)  Tests 40 passed (40)
  problem-language-limits (container-backed, run alone)    Test Files 1 passed (1)  Tests  5 passed (5)
  mail-failure-oracle, mail-unavailable, account-recovery,
  register-verification                                    Test Files 4 passed (4)  Tests 20 passed (20)
```
(The `apps/api` runs overlap deliberately — each fix was re-verified against
its neighbours as it landed. The totals are per run, not a sum.)

`tsc --noEmit` clean on `@duckoj/api`, `@duckoj/web`, `@duckoj/contracts`;
`eslint` clean on every file touched. `openapi.json` and
`packages/sdk/src/generated.ts` regenerate with **no diff** (the contract
change is a doc comment, not a schema change). The full `apps/api` suite was
not run — the brief's thermal cap says to run the specs touched, and the
container-backed ones were run alone.

## Live artefacts (D153)

Created by probing the deployed stack over HTTP, named so
`scripts/cleanup-test-data.ts` classifies them under its `bh<n>*` pattern:

* user **`bh30probe`** (id 426, `bh30probe@example.invalid`)
* submission **818** on `aplusb`, `python3`, AC

## What I could not finish

* **Nothing is deployed.** All three fixes are local commits on `main`. Until
  the controller deploys `api` and `web`, the live picker still preselects
  C11 and the live `password/forgot` still has defect 1 latent — latent only
  because the stack is on the no-op transport, which means D155's 503 fires
  before the vulnerable code. **Deploying real `SMTP_*` credentials without
  this commit is what arms it.**
* **No `CHECK` on the multipliers**, for the reason argued above.
* **The `blocked_reason` student-facing gap is reported, not closed.**
* **No Playwright run.** Every defect here was provable in a unit or
  container-backed spec plus the live HTTP/psql probes, and the brief's
  thermal cap makes a twelve-suite browser run against the live stack the
  most expensive way to learn the least.
