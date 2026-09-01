# F-41 report — the language limits become editable, safely, and a stuck submission says so

**Status: complete, not deployed, not pushed.** All three parts are in, on
`main` in this clone, six commits on top of `322681c`. Two decisions spent
(**D159**, **D160**); **D161 is unused**. Nothing was deployed,
`podman-compose`/`compose-up.sh`/`deploy.sh` were never run, `apps/web/dist`
was never written, `.secrets/` was never read, and the live database was read
with `SELECT` only — **no live rows were created at all**, so there are no
D153 test artefacts to clean up.

## Commits

| | |
| --- | --- |
| `f0b17d9` | `feat(db)` — bound a limit adjustment, and put the arithmetic where the form can reach it |
| `05290fc` | `feat(contracts)` — the override has a shape a form can edit, and a queue has a reason a pupil can read |
| `e6dcb8f` | `feat(api)` — a setter can write a language override, and a blocked queue says so |
| `83d807b` | `feat(web)` — a form for the language overrides, and a queue that says what it waits for |
| `9c510e0` | `docs(D159,D160)` |
| *(HEAD)* | `docs(f41)` — this report |

## What the brief got right, checked rather than assumed

Every factual claim in the brief held.

- **`problem_language_limits` had no `CHECK`.** Read off the live database:
  `select conname from pg_constraint where conname like '%multiplier%'` →
  0 rows. `pct 0` really does yield `timeMs: 0`.
- **`blocked_reason` really is admin-only.** `dashboard.access.ts:502` was
  the only reader in `apps/api`.
- **0043 really is next.** The journal's last entry is `idx: 42`,
  `0042_language_multipliers`.
- **The live data survives the new bounds.** Checked read-only *before*
  writing the migration: `languages` is five rows at 100–300 % and
  0–32768 KB; `problem_language_limits` is **empty (0 rows)**. Every value
  satisfies every bound, and a fresh install runs 0042's seed immediately
  before 0043.

## 1. The bounds (D159)

**One rule gives both floors: an adjustment may never take away from what the
setter authored.** In the multiplier's unit that is **100 %**; in the addend's
it is **0 KB**. Not a small positive number — the identity. Below either, a
correct program is failed by policy while being told it was failed by speed or
by size, which is D154's forbidden outcome; 1 % is as broken as 0 and 99 % is
the same lie in miniature. Making a punitive limit *unrepresentable* is what
stops a refusal from ever being expressed as a wrong verdict. "This problem
cannot be solved in this language" has `allowed = false`, which is a 404.

**The ceilings are about the province, not the pupil.** **1000 %** is D154's
own denial-of-service arithmetic: a 350-test problem authored at 1 s costs
350 s of judge wall clock per submission at 100 %, and D154 rejected the
measured 110× interpreter factor *by name* for exactly this reason. At the
ceiling that problem costs 3500 s — just under an hour — for one submission;
past it one pupil holds the fleet for a lesson. It is 3.3× the largest
multiplier this deployment uses. **1 GiB** is what an addend *means*: a
runtime floor. CPython 3.11's is 15044 KB on this judge's own image, a JVM's
is tens of megabytes. Nothing that is a floor is a gigabyte wide, so a larger
value is a different memory limit smuggled in — and that belongs on the
revision. The judge box is the other half: a limit above its RAM turns one
MLE into the kernel choosing a victim.

**NULL is exempt on the override, and that exemption is the point** — the
ordinary row pins the time and keeps the memory floor, and a CHECK without
`IS NULL OR` would have forbidden exactly the row D154 names.

**Idempotent.** Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so each is a
`DO $$ … EXCEPTION WHEN duplicate_object THEN NULL`. Only that error is
swallowed: a row that genuinely violates a bound still fails the deploy,
because silently clamping a limit somebody typed would change a verdict
without telling anyone. A test re-executes the file statement by statement
against an already-migrated database and asserts there are still exactly four
constraints, not eight.

**Three layers.** The zod bounds on `PUT /problems/{code}/language-limits`,
the form's own validation with the message in both languages, and the CHECK.
All three read the same four exported constants, and a db spec reads the
constraint definitions back out of `pg_constraint` and fails if the SQL and
the constants ever disagree.

### `@duckoj/language-limits`, and D154 narrowed by one clause

D154 says "the web app is never handed a multiplier to apply itself". The
authoring form is handed one, and this is argued rather than slipped in.

The rule D154 was *defending* is that the arithmetic exists once — which is
why it put `effectiveLimits` in `@duckoj/db`, the one package `apps/api` and
`apps/judged` both depended on. The form is a third caller with a requirement
neither of those has: it must show a resulting limit for a value that has been
**typed and not yet saved**, which no server-resolved field can answer. And
`apps/web` cannot depend on a package that imports `drizzle-orm` and
`postgres`. So the alternative to moving the file was re-deriving
`ceil(ms * pct / 100)` in a browser — the second implementation D154 exists to
forbid.

`packages/language-limits` is that module with **zero dependencies**, in the
shape `@duckoj/glicko2` and `@duckoj/api-prefix` already established.
`@duckoj/db` re-exports the whole of it, so **no existing call site changed**
(`apps/api` and `apps/judged` still import from `@duckoj/db`), and a db spec
asserts the re-export hands back the same function objects. The pupil-facing
`ProblemDetail.languageLimits` is untouched.

## 2. The form (D159)

A third tab on the problem edit screen, in both languages (D18). Per active
language: the time multiplier, the memory addend, whether the language is
allowed, and — beside them — what a pupil will actually be given for the
values in the boxes right now.

- **Null is not zero.** The form holds the two numbers as **strings**, because
  an empty box is a real state that no number represents. `parseField` maps
  `''` to `null` and never to `Number('')`, which is 0 — that single coercion
  is the entire hazard. The placeholder is the inherited **value**
  ("kế thừa: 300 %"), not the word "optional".
- **Refusing is not zero.** Clearing "Cho phép" renders "Không cho phép nộp
  bằng ngôn ngữ này" and never a number. `effectiveLimits` deliberately does
  not consult `allowed`, so quoting its answer for a refused language would
  put a limit on screen for a submission that will be answered 404.
- **The preview is the same code.** `resolveLanguageTuning` then
  `effectiveLimits`, imported — the same two calls
  `ProblemAccessService.loadLanguageLimits` makes and the same two
  `JobStore.claim` makes.
- **The existing furniture, reused.** D110's focusable error summary, D146's
  attribution (the dictionary is built from the row order the form is about to
  *send*, so `limits.1.timeMultiplierPct` reaches row 1's own field rather
  than the banner), D147's dirty guard, D148's button. Saving invalidates
  `['problem', code]`, or a setter who saved and pressed Submit would be shown
  the limits they had just replaced.

**The route is the problem's own authorisation, not a new one.**
`GET`/`PUT /problems/{code}/language-limits` both carry
`@RequireScope('problems:write')` — what `PATCH /problems/:code` carries — and
neither carries `@Public()`. Both go through `loadForEdit`, so an invisible
problem 404s before anything else is decided and a visible-but-uneditable one
403s. `route-marker-coverage.spec.ts` and `route-contract-parity.spec.ts` pass
with both present.

`PUT` is a **whole-set replacement** inside one transaction, on
`members`/`orgSlugs`' existing rule. A row that inherits both columns and
allows the language is stored as **no row** — byte-identical in every reader,
and keeping it would grow the table by a row per (problem, language) for every
problem anybody ever opened the form on. The response is re-read rather than
echoed, so those dropped rows are not reported back as stored.

## 3. The blocked queue (D160)

`SubmissionDetail.awaitingCapableJudge`, a **boolean**, never the reason
string. The internal reason (`no connected judge supports language <key>`) is
written by `judged` for an operator and is a sentence about the fleet. The
client renders "Đang đợi một máy chấm chạy được Python 3" from `languageKey`,
which the viewer already has and which is their own choice — nothing about
topology, nothing about anybody else. A spec asserts the response body
contains neither `no connected judge` nor `blockedReason`.

**Masked by the freeze**, with the outcome fields. `state` survives D23's mask
deliberately; *why* it has not finished is a fact about the fleet attached to
somebody else's in-flight submission. It costs the pupil nothing, because D23
never freezes a viewer's own submission — the only reader this field exists
for can never be the one it is hidden from.

**The job stays `queued`, and this was weighed.** D68 had already argued it: a
blocked job *is* queued, claimable the instant a capable judge connects, so a
terminal state needs a sweeper to undo it and makes every existing query that
reasons about `queued` wrong. The condition is temporary by construction — D68
parks rather than fails over a judge restart that empties the bridge for two
seconds — and the only terminal verdict available is `IE`, which tells a pupil
their program broke the judge. Being told why the wait is happening is the
fix; ending it with a verdict nobody earned is not.

Read as its own indexed lookup on the **newest** job, not a join:
`grading_jobs.submission_id` is not unique (a rejudge normally UPDATEs in
place, but `RejudgeAccessService` inserts a fresh row for a submission whose
job went missing) and a plain join would duplicate the submission. Skipped
entirely unless the submission is `queued` — the only state in which the
answer can be `true`, and this route is polled hardest by the submit page.

## Tests, demonstrated red first

Every new test was run against deliberately broken code before being accepted.

**1. The bounds** (`packages/db/test/language-limits.spec.ts`). Migration 0043
replaced with a comment-only file:

```
     → the given combination of arguments (null and string) is invalid for this assertion...
     → expected null to be 'languages_time_multiplier_pct_ck'
     → expected null to be 'languages_time_multiplier_pct_ck'
     → expected null to be 'problem_language_limits_time_multipli…'
     → expected +0 to be 4
 FAIL  ... > states the exported bounds, on BOTH tables
 FAIL  ... > refuses the typo that made every submission in a language TLE
 FAIL  ... > refuses a multiplier that would hold the province’s one judge for a lesson
 FAIL  ... > leaves NULL alone, because NULL is “inherit” and not zero
 FAIL  ... > re-runs without failing, because a migration nobody dares re-run is D133 again
      Tests  5 failed | 11 passed (16)
```

**2. The route** (`apps/api/test/problem-language-limit-settings.spec.ts`).
Four deliberate breaks at once — resolve the override over the default, keep
the empty row, skip the visibility half of the authorisation, drop the zod
bounds:

```
     → expected { languageKey: 'python3', …(6) } to deeply equal { languageKey: 'python3', …(6) }
     → expected 200 to be 404
     → expected { languageKey: 'python3', …(6) } to match object { timeMultiplierPct: 150, …(1) }
     → expected [ { problemId: 5, …(4) }, …(1) ] to have a length of +0 but got 2
     → expected 500 to be 422
      Tests  5 failed | 1 passed (6)
```

The last line is the third layer proving itself: with the zod bounds gone,
`pct 0` still did not land — the database's CHECK refused it, and the request
answered 500 instead of 422.

**3. The blocked field** (`apps/api/test/submission-awaiting-judge.spec.ts`).
`awaitingCapableJudge` hard-coded to `false`:

```
     → expected false to be true
 FAIL  ... > says so, without saying anything about the fleet
      Tests  1 failed | 1 passed (2)
```

**4. The form and the waiting line** (`apps/web/test/problem-language-limits.spec.tsx`,
`apps/web/test/submit.spec.tsx`). `parseField` made `Number(raw)` (so an empty
box is 0), the local validation short-circuited, and the awaiting line
disabled:

```
     → Unable to find an element with the text: /máy chấm chạy được Python 3/
     → Unable to find an element with the text: /3 giây và 282 MB/
     → Unable to find an element with the text: /1.5 giây và 282 MB/
     → expected { languageKey: 'python3', …(3) } to match object { allowed: false, …(1) }
     → expected "spy" to not be called at all, but actually been called 1 times
      Tests  5 failed | 16 passed (21)
```

`/1.5 giây và 282 MB/` is the load-bearing one: 150 % of 1000 ms with the
interpreter's 32 MB floor **still added**. Under the break it read 250 MB —
which on the live judge is an MRE for every Python submission on that problem.

### Green

```
packages/language-limits                    Test Files   1 passed (1)    Tests  11 passed (11)
packages/db          (whole package)        Test Files  18 passed (18)   Tests  85 passed (85)
packages/contracts   (whole package)        Test Files   9 passed (9)    Tests  39 passed (39)
packages/sdk                                Test Files   1 passed (1)    Tests   2 passed (2)
apps/web             (whole package)        Test Files  67 passed (67)   Tests 750 passed (750)
apps/mcp             (whole package)        Test Files   8 passed (8)    Tests  90 passed (90)
apps/judged   job-language-routing,
              worker-language               Test Files   2 passed (2)    Tests  20 passed (20)
apps/api      route-marker-coverage, route-contract-parity,
              route-fuzz, scope-guard, authz-default        Test Files 5 passed (5)   Tests 19 passed (19)
apps/api      problem, problem-reads, problem-writes, problem-visibility,
              problems-http, problem-language-limits,
              problem-language-limit-settings,
              submission-awaiting-judge                     Test Files 8 passed (8)   Tests 93 passed (93)
apps/api      submission-freeze, submission-diff, submission-source-visibility,
              submission-source-contest, submission-teammate-visibility,
              submission-problem-visibility, rejudge,
              contest-freeze                                Test Files 8 passed (8)   Tests 61 passed (61)
```

`tsc` clean on every package (`@duckoj/db`, `@duckoj/language-limits`,
`@duckoj/contracts`, `@duckoj/api`, `@duckoj/judged`, `@duckoj/web`,
`@duckoj/mcp`, plus `typecheck:scripts`); `eslint` clean on all of the same
plus `lint:scripts`. `openapi.json` and
`packages/sdk/src/generated.ts` **regenerate with no diff** — verified with
`git diff --exit-code` after a fresh emit.

`verify:csp` passes, but be exact about what it checked: it reads the built
`apps/web/dist`, and **`vite build` was deliberately not run** — the brief
forbids writing to `apps/web/dist`, which Caddy bind-mounts on the live stack.
So the CSP check ran against the pre-F-41 bundle. Nothing in this slot adds an
inline script (the new tab is a normal React module), so the hash set cannot
have moved; the production build is the controller's, on deploy.

One wrinkle in the commit sequence, recorded rather than rewritten:
`pnpm-lock.yaml` is committed whole in `f0b17d9`, and it already carries
`@duckoj/contracts`' dependency on `@duckoj/language-limits`, whose
`package.json` lands one commit later in `05290fc`. A `--frozen-lockfile`
install at `f0b17d9` would refuse. HEAD is consistent, nothing deploys an
intermediate commit, and rewriting five commits to split one generated file
seemed the worse trade.

The full `apps/api` suite was **not** run: the brief's thermal cap says to run
the specs touched, and container-backed specs were run in small batches, never
beside another package's suite.

## Notes for the controller

- **Migration 0043 must run before the new `api` image starts.** D133's
  `MigrationDriftError` is exactly the guard for this and `scripts/deploy.sh`
  already orders it; there is nothing new to do, but the constraint is real:
  an `api` container from this tree against a database that has not applied
  0043 refuses to boot, deliberately.
- **The migration cannot fail on the live data**, checked read-only before it
  was written (0 override rows; every `languages` row inside all four bounds).
- **Nothing is deployed.** The live stack is still `322681c`, six containers
  healthy, and `GET /api/v1/problems/aplusb` answers 200 as before.

## What I could not finish

- **Nothing was exercised against the live judge end to end**, because that
  would need a deploy. The whole blocked-queue path is unreachable on today's
  fleet anyway — the announced executor set and `language_driver_keys` are
  exact inverses (B-30 verified this and it is still true), so
  `awaitingCapableJudge` is proven by a container-backed spec that writes
  `blocked_reason` directly, not by a real blocked job.
- **No Playwright run.** Every behaviour here is covered by a unit or
  container-backed spec, and a browser run against the live stack would be
  testing the *deployed* build, which does not contain any of this.
- **The `500` on a bounds violation that bypasses zod is not prettified.**
  With the contract in place it is unreachable — the deliberate-breakage run
  above is the only way to see it — and it matches how the codebase already
  treats a database CHECK as "the backstop for a writer that never passes
  through here" (`problems_editorial_published_ck`). A `check_violation` →
  422 mapping would be a nicer 500 for a path nothing can reach.
- **B-30's recorded draft-restore gap is untouched** — the picker restores a
  draft on an explicit language switch but not on the mount that corrects an
  unofferable default. It is now *reachable* for the first time, because this
  slot gives setters a way to write `allowed = false` without SQL. It is a
  lost half-written program, not a wrong verdict, and closing it means moving
  the opening-buffer decision out of the mount-time `useRef`, which B-30
  judged larger than the case justified and I agree. Worth a slot.
- **Syntax highlighting on the submission detail page** was out of scope by
  the brief and was not started.
