# Phase 2b decision ledger — problems

**What this is.** The running record of every decision made while implementing
Phase 2b, written as the work happened rather than reconstructed afterwards.
The runbook records the user-facing symptoms and how to operate the system;
this records *why* — including why several things were found, judged, and
deliberately left for Phase 3.

**Read this before Phase 3.** The table below is the deferred-work summary;
each row's ruling has the full reasoning inline further down. Git has the list
of what was built. What git does not have, and what this file exists to carry,
is the reasoning behind the decisions that look arbitrary from outside, and the
defects a green test suite could not see.

| Deferred | Ruling |
|---|---|
| The `apps/judged` suite flake — `worker.spec.ts`, `job-store.spec.ts`, `dmoj-driver.spec.ts`, always under full-workspace `pnpm -r test` parallelism, always green in isolation, always on a diff touching nothing in `apps/judged`. **Three sightings across two phases; no fourth this phase** (Task 9's two parallel runs and Task 15's gate were all green). Unreproduced and unexplained. **Do not apply a speculative fix** — a fix that cannot be shown to address a reproduced cause destroys the only evidence there is, because the next non-sighting then proves nothing: you cannot tell a fixed flake from a flake that simply did not fire | Carried from Phase 2a (Task 6 watch item, Task 14 flake watch, 2a Task 15 D3); Task 9 and Task 15 sightings-none recorded below |
| **The `dist/` resolution trap, and the clean-tree recipe that hides it.** Two distinct failures share one root. (a) `apps/api` resolves workspace packages through their built `dist/`, not live `src/`, so a **mid-session mutation check** can pass spuriously against stale output — the moment a spurious pass is most dangerous, because it reads as "this test cannot fail" and the test gets rewritten or deleted. `pretest` hooks cover the test run and not this. (b) Worse, and found during Task 15's own gate: `rm -rf */dist` **without also deleting `tsconfig.tsbuildinfo`** leaves `tsc -b` believing every project is up to date. It prints `Done` for all 12 projects and emits **zero files**. The correct incantation is `rm -rf packages/*/dist apps/*/dist packages/*/tsconfig.tsbuildinfo apps/*/tsconfig.tsbuildinfo` | W1 (fourth sighting, Task 7a); R63 (Task 15) |
| No router library adopted. `@tanstack/react-router` has been a declared, imported-nowhere dependency since Phase 0; `apps/web` hand-rolls `parseRoute` against `window.location.pathname`, with plain `<a href>` links, full page loads between routes, and no History API listener | R52 (not adopted mid-phase, and why); R58 (Task 12's **measured** cost at five routes) |
| Dockerfile COPY manifests are still hand-maintained per workspace package. Now *detected* by `apps/api/test/dockerfile-manifest.spec.ts` rather than discovered by a broken image build — narrowed, not closed | Carried from Phase 2a T13-A; narrowed by this phase's manifest test |
| The org-resolution **timing** side-channel. `resolveOrgIds` fail-fasts on a non-existent slug after one query; a non-membership failure costs every slug's lookup plus the membership query, so existence failures are systematically faster and a multi-slug batch leaks the failing slug's position | R23 |
| A narrow `sizeBytes` drift window: a first upload's store write succeeds but its transaction fails, and a later re-upload skips the write while recording the new length | Carried from Phase 2a Task 9 minor |
| `Materializer.ensure()`'s in-flight-request coalescing is correct (verified by experiment: 3 concurrent calls → 1 fetch) but **unpinned** by the shipped suite, which only calls it sequentially | Carried from Phase 2a Task 10 minor |
| A valid-zstd/truncated-tar archive yields a silently truncated buffer rather than rejecting. Benign downstream today (`JSON.parse` of a prefix throws → 400 `package_invalid`) and proven never to hang; the honest fix is tar checksum verification, which belongs with the archive format | R31 |
| No scheduling policy, priority, or attempt cap — a job that keeps failing to dispatch keeps re-leasing forever | Carried unchanged from Phase 1 |
| No member-management UI. `problemMembers` is written by the API and by seeds; the web app has no screen to add or remove a problem's authors, curators, or testers | Phase 2b scope; spec §4.1 exposes `members` read-only |
| No browser package upload. `POST /packages` is exercised over real HTTP by `scripts/e2e-problem.ts`, but `apps/web` has no upload control — a setter attaches a revision by hash, not by choosing a file | Phase 2b scope |

**A note on how to read it.** The single most valuable pattern this phase
produced is not a feature. It is this: **a test that passes proves nothing
about the test.** Only showing it fail when the property it asserts is false
proves it would notice a regression. Four separate tasks produced evidence of
that shape (R44, R47, and the two false starts recorded under Task 6's fix
round), and in every case the alternative was a green tick nobody would have
questioned. R47 applies it to a *negative* finding, which is the subtle case:
"X is not broken" needs evidence exactly as much as "X is broken" does.

The corollary is the phase's recurring defect shape. **Five bugs across three
phases have now had the form "two components each internally consistent, with
nothing exercising the link between them"** — Task 8's org member who could see
a problem and got 404 on submit, and Task 13's D1, where the Submit button on
every problem page silently graded against `aplusb`. Each had a fully green
suite on both sides. A per-component test suite cannot find this class by
construction; only a test that crosses the seam, or a real run of the real
system, can. Acceptance criterion 4 was written to force exactly such a
crossing test and **is the one criterion this phase did not meet** — see the
Task 15 entry.

Three further rules earned the hard way, stated so they survive their authors:

- **Composition of two normalising folds is not the composition of what each
  fold catches.** `f(g(x)) == f(g(y))` does not follow from `f(x) == f(y)`.
  My "these three Unicode checks simplify to one" was wrong by 60 counterexamples
  (R32), and the coordinator proposing a simplification is the person least
  likely to be pushed back on. Brute-force it first.
- **When you invalidate a claim, grep for it — do not fix the instance you
  tripped over.** Three of Task 14's nine findings were second copies of a claim
  corrected once (R62). Documentation describing a fixed bug as intended
  behaviour is a trap with a signature on it (R60).
- **A correct-looking security check can produce a worse outcome than the hole
  it closes**, and twice this phase the check was right while its *interaction*
  with a neighbouring rule was not (R57, and Task 4's 404-vs-403 ordering).

Format: `Ruling RNN: <decision> — <why> — <what it costs if wrong>`. Entries
below this line are the plan's live progress record, carried forward verbatim
from `.superpowers/sdd/2026-08-20-phase-2b-problems/progress.md` (gitignored,
not committed), plus a final Task 15 entry appended for this acceptance step.

---

# SDD ledger — plan: docs/superpowers/plans/2026-08-20-phase-2b-problems.md

Spec: docs/superpowers/specs/2026-08-20-phase-2b-problems-design.md (reachable — rulings binding)
Branch: phase-2b-problems, branched from main at 1efde2d.
Baseline entering the plan: 268 tests, all gates green, Phase 2a merged and pushed.
Execution mode: subagent-driven, fresh implementer per task, review after each.

## Pre-flight scan

Cross-task rows — every pair sharing a file or an interface:

| Tasks | Produced -> consumed | Result |
|---|---|---|
| 1 -> 2,3,4,5,6 | `problemMembers`, `problemOrgs`, `problems.createdBy`, revision metadata columns | OK — column names agree with every consumer |
| 1 -> 9 | `caseVerdict` gains `'CE'` | OK — enum lands before the mapping that emits it |
| 1 -> 5 | `problem_revisions_version_idx` | OK — index precedes the read-then-insert it protects |
| 2 -> 3,4,5,6 | `canViewProblem`, `canEditProblem`, `ProblemViewContext` | OK after R1 |
| 2 -> 8 | `loadProblemContext` | **CONFLICT** — see R1 |
| 3 -> 7 | `listVisible`/`getVisible` shapes vs `ProblemSummary`/`ProblemDetail` | OK — both match spec 4.1 |
| 5 -> 7 | `attachRevision` | OK |
| 6 -> 7 | `publishRevision`, `listRevisions` | OK |
| 7 -> 11,12 | regenerated `@duckoj/sdk` | OK — Task 11 Step 1 states the ordering |
| 11 -> 12 | `renderStatement` | OK |

Per-task self-consistency:

| Task | Result |
|---|---|
| 1 | OK — tests match the columns the steps add |
| 2 | OK after R1 |
| 3 | OK after R1 |
| 4 | OK |
| 5 | **THREE DEFECTS** — see R2, R3, R4 |
| 6 | OK |
| 7 | OK |
| 8 | OK after R1 |
| 9-15 | OK |

## Rulings before execution

Ruling R1: `loadProblemContext(db, actor, problemId)` is implemented and
exported from `apps/api/src/authz/problem.visibility.ts` in **Task 2**, not
as a private `contextFor` on `ProblemAccessService` in Task 3 — my draft had
Task 8 "promote it or move it", which is a decision left to an implementer who
cannot see Task 3. `SubmissionAccessService` must reach the loader without
depending on `ProblemAccessService`; a service-private helper forces either a
service dependency or a second loader, and the second loader is exactly the
duplication Global Constraint 1 exists to prevent. Task 2's own suite still
covers only the pure predicates; Task 3's database tests exercise the loader.
Cost if wrong: one function moves between two files in the same directory.

Ruling R2: Task 5's `this.store.read(hash)` does not exist. `PackageStore`
exposes `has`, `put`, `get`, `delete`. Corrected to `get`. Caught by reading
the real class rather than trusting my own plan text. Cost if wrong: nil —
this is a fact about existing code.

Ruling R3: Task 5's "unpack the archive in memory" is impossible against the
real API — `unpackArchive(archive, destDir)` writes to disk and returns
`void`. Corrected to two routes: **path collisions read the `package_files`
table** (Phase 2a already stores one row per file per hash, and it is the same
list the hash was computed over), and **the manifest comes from a new narrow
`readArchiveEntry(archive, path)`** added to `@duckoj/package-format`, because
its contents genuinely are not in the database. This is strictly better than
the temp-directory alternative: no disk I/O on the collision path at all.
Cost if wrong: one small function in a package that already has an archive
module and a test suite for it.

Ruling R4: `readArchiveEntry` carries an explicit warning against
`await parse(...).end(bytes)`. That exact bug shipped in `unpackArchive` in
Phase 2a — `end()` returns the stream, not a promise, so the await awaits
nothing — and was caught only in review. The plan now names the shape of the
fix and requires a 500-file test, which is the reproduction that exposed it.
Cost if wrong: nil; it is a warning, not a constraint.

Ruling R5: no git worktree this phase — a plain `phase-2b-problems` branch.
The worktree tool requires an explicit worktree instruction from the user or
project memory, and this session has neither. A branch gives the same
isolation from `main`; the only thing lost is parallel checkouts, which
nothing here needs. Cost if wrong: `git worktree add` at any point.

---

## Progress

### Task 1 — fix round 1 (implementer reported BLOCKED with two plan defects; both verified by me)

Ruling R6 (defect 1 — and it is worse than reported): `packages/contracts/src/submissions.ts:5`
keeps an **independently hardcoded second copy** of the verdict list. That is
the same duplication class Global Constraint 1 exists to eliminate, sitting in
the codebase already. Task 1 owns adding `'CE'` there — no other task touches
the file and leaving the repo red is not an option — but the durable fix is a
drift test. `@duckoj/contracts` deliberately depends on **no** workspace
package and must stay that way: it is bundled into the browser, and drizzle
has no business in a web bundle. `apps/api` depends on both, so the test lives
there: `apps/api/test/verdict-enum-drift.spec.ts`, asserting
`Verdict.options` equals `caseVerdict.enumValues` exactly, order included.
Cost if wrong: one test file.

Ruling R7 (defect 2 — the seed script): `scripts/seed-problem.ts` creates zero
users and now violates `problems.created_by NOT NULL`. It upserts a locked
`system` user and uses it as both `created_by` and the problem's `author`.
**Not** an env var: `packages/db/test/seed-script.spec.ts` and the runbook's
one-off container command both invoke the script with no extra environment,
and breaking two working callers to satisfy a new column is the tail wagging
the dog. The account cannot be logged into by construction — `passwordHash`
is the sentinel `'!'`, which is not a valid argon2 encoding, and
`PasswordService.verify` catches the decode failure and returns `false`
(verified at `apps/api/src/authn/password.service.ts:13-19`), so it fails
closed rather than 500ing. Cost if wrong: one row in a dev database.

Ruling R8 (the metadata backfill the implementer flagged): there is **no
honest backfill** for `time_ms`, `memory_kb`, `test_count`, `total_points`,
`checker_kind` on pre-existing revisions — those values live inside a package
archive that SQL cannot read. The migration raises a clear exception naming
the fix if `problem_revisions` is non-empty, rather than inventing sentinels
that would silently misreport a problem's limits on its own page. This matches
Phase 2a's precedent for the `pgdata` volume: dev data is disposable, and the
production import is a separate deferred project that writes its own importer.
`created_by` is different — a defensible backfill exists — so it keeps the
nullable -> backfill -> NOT NULL path already written. Cost if wrong: an
operator recreates a dev volume, which the runbook already instructs for
Phase 1 volumes.

Ruling R9: the seed script supplies the five metadata columns by reading
`manifest.json` from `PROBLEM_DIR` and running `parseManifest`, never by
hardcoding. Its existing repoint branch (an old revision pointing at a stale
hash) must update the metadata too, or a repointed problem keeps the previous
package's limits. Cost if wrong: seeded problems report limits that do not
match the tests they are graded against.

Task 1: implementer returned DONE_WITH_CONCERNS at 311bcf5 after fix round 1.
All four rulings implemented. Test count verified by me at 272 = 268 baseline
+ 4 new (the implementer's report said 257, which was a miscount; `git diff`
over `*spec.ts` confirms 0 removed `it()` blocks and 4 added, and a per-package
count sums to 272). A third pre-existing defect surfaced and was fixed in the
same round: `apps/judged/test/event-writer.spec.ts` used `'CE'` as a
deliberately-invalid poison verdict to force a database error, which stopped
being invalid the moment `'CE'` became real — switched to `'ZZ'`. That is the
second time this phase that adding one enum member broke a hardcoded copy of
it somewhere else. Task review dispatched.

### Task 1 — review verdict: spec PASS, quality CHANGES REQUESTED

Reviewer verified by running, not by reading: migration 0005 applied to five
distinct database states on a real postgres:16-alpine, including the
stale-volume case where the RAISE EXCEPTION guard must fire before any
`created_by` statement. It does. `ALTER TYPE ... ADD VALUE` executed cleanly
inside drizzle's single migration transaction, so a fired guard rolls back
whole — nothing half-applied.

Ruling R10 (Important finding, accepted): R7 and R9 were implemented but
**asserted nowhere**. `packages/db/test/seed-script.spec.ts` checks judge rows,
package hash and blob path only. Hardcoding `timeMs: 9999` in the seed script
would pass all 272 tests. That is precisely the class Global Constraint 7
exists to forbid, and the fact that no ruling *demanded* the assertions is not
a defence — the rulings demanded the behaviour, and behaviour nothing checks
is behaviour that decays. Fix round 2 adds them against the concrete aplusb
manifest values (1000 ms, 65536 KiB, 3 tests, 3 points, `standard`).
Cost if wrong: five lines in a spec that already holds an open db handle.

Ruling R11 (Minor finding, accepted): the system-user upsert crashes on a
case-mismatched pre-existing row. `scripts/seed-problem.ts` uses
`onConflictDoNothing()` — which fires against the case-insensitive
`users_username_lower_idx` — then re-selects with an exact-match `eq()`. A
pre-existing `'System'` makes the insert a no-op and the select empty, and the
`[0]!` non-null assertion throws a bare TypeError. The same file already gets
this right for `problems`. Fix now rather than defer: it is a one-line change
to `lower(...) = lower(...)`, and the failure mode is an unreadable crash in a
bootstrap script an operator runs before anything else works.

Ruling R12: the reviewer's three deferrals are accepted as reasoned. Note one
correction it earned: disclosed concern 3 (a database with problems but no
revisions failing with a generic Postgres error) is confirmed real but
near-unreachable, because every historically producible database wrote a
revision alongside its problem, so the guard fires first. Left unfixed and
recorded rather than papered over.

Task 1: complete at 358ccfb. Fix round 2 verified by me directly rather than
by another reviewer — the diff is 32 lines across two files and the claims were
falsifiable. Both fixes correct: the author-row assertion uses `toEqual` on the
whole row (exact, not a partial match that would pass on a wrong role), and the
seed script's re-select now matches the case-insensitive index it upserts
against. I confirmed the five manifest values against
`problems/aplusb/manifest.json` myself rather than trusting either the
implementer or the reviewer, since both quoted the same numbers and a shared
wrong number is exactly what nobody catches: 1000 / 65536 / 3 tests / 3 points
/ standard. Correct. `@duckoj/db` 20/20, workspace 272/272.

BASE for Task 2: 358ccfb.

Task 2: implementer returned DONE at 420af38. 22 new tests (13-cell matrix,
5 canEditProblem, 4 canCreateProblem), workspace green.

Ruling R13 (plan defect, mine, reported by the implementer): Task 2's Step 5
told the implementer to make the org branch `return true` and expect three
named failures. That is wrong — the branch reads
`if (problem.visibility === 'org' && actor)`, so changing only the inner
return leaves anonymous callers excluded and produces two failures, not three.
The implementer noticed the arithmetic did not match, dropped the `&& actor`
guard as well, and got the stated three. That is the right response to a
mutation instruction that does not reproduce: adjust the mutation until it
actually breaks what you claim, rather than relabelling the expectation to
match whatever happened. Plan corrected in place, with a note that seeing two
failures means you have not broken enough. Cost if wrong: nil, the plan text
now matches the code.

Watch item carried into Task 3: `visibleProblemsWhere` — the SQL form of the
predicate — has **no test whatsoever** at the end of this task. Its 13-cell
row-form twin is thoroughly covered, which makes the gap easy to miss. Task 3's
list tests are its first real coverage, and the two forms silently diverging is
the single most damaging thing that could happen in this phase: the list would
show a problem the detail page 404s, or worse, the reverse. Task 2's review was
pointed at exactly this.

### Task 2 — review verdict: spec PASS, quality APPROVED

Reviewer worked all 15 SQL-vs-row cells by hand and found **no divergence**.
Two load-bearing confirmations: `inArray(problems.id, memberOf)` is OR'd with
no visibility filter, so the SQL form grants a member sight of a *private*
problem exactly as the row form's membership-outranks-visibility rule does;
and the org branch's `innerJoin` ties org membership to *this problem's*
shared orgs, so an actor in an unrelated org matches nothing. It also
reproduced the Step 5 mutation independently and got the same three failures
rather than accepting the implementer's word.

Three Minor findings, all documentation, all fixed by me directly at 50ea93a
rather than through a fix round — they are comment edits with no behaviour:

Ruling R14: `actorOrgIds`' docstring said "Organizations the actor belongs to".
It is actually the *intersection* of the actor's orgs with this problem's
shared orgs, because `loadProblemContext` computes it with a join against this
problem's `problem_orgs` rows. Correct for its only current consumer and a
live trap for the next one — Task 8 would have read that sentence and assumed
the wider meaning. Docstring now says so, in both the code and the spec.

Ruling R15: the matrix comment claimed one case per cell of a 15-cell table
while listing 10. The other five reach `true` through an unconditional early
return that an existing case already exercises, so coverage is real — but a
comment that overstates coverage is how the next person decides not to look.
Comment now names the five and says why they are absent.

Ruling R16: Global Constraint 3 named only services as permitted importers of
guarded problem tables, which made `problem.visibility.ts` — where the spec
itself mandates those imports live — read as a violation. Wording corrected in
both plan and spec: the predicate and the loader that feeds it belong in one
file, and splitting them is precisely how the two forms drift apart.

Task 2: complete at 420af38 (+ 50ea93a docs). BASE for Task 3: 50ea93a.

Task 3: implementer returned DONE at 13b9746. 10 new tests, apps/api 152/152,
workspace green. **The phase's biggest single risk is now retired**: the SQL
form of the visibility predicate has been executed against real PostgreSQL and
agrees with its pure-function twin in every matrix case tested — public/anon,
org hidden from a non-member, org shown to a shared-org member, private shown
to its tester, private hidden from a stranger. Task 2's reviewer had verified
this by reading; it is now verified by running.

Concern 1 from the implementer (no zod contracts for the read DTOs, so it used
local TS interfaces): checked and dismissed — Task 7 explicitly produces
`ProblemSummary`, `ProblemDetail`, and `ProblemListQuery`. Nothing owed here.

Concern 2 (`hasPublishedRevision` derived from leftJoin row existence rather
than `state === 'published'`): carried to the reviewer with my own inclination
stated, and an invitation to argue against it. Today the two agree because
`currentRevisionId` only ever points at a published revision — but nothing
enforces that, and the field's name promises the stronger claim.

### Task 3 — review verdict: spec PASS, quality APPROVED

Reviewer independently mutated `nextCursor` to derive from the probe row
instead of the last kept item and confirmed the pagination test fails
(`expected [] to deeply equal ['page-c']`) — so the off-by-one guard is real,
and it is one the implementer's own Step 5 mutation never touched. That is the
second reviewer this phase to falsify a claim rather than accept it.

Ruling R17: `hasPublishedRevision` now requires `state = 'published'` in both
join conditions. The reviewer traced all three write paths that set
`currentRevisionId` — the seed script, and Task 6's planned publish
transaction — and confirmed the invariant holds today under every known path,
then agreed the term is still worth one line: the guarantee rests on
convention across three call sites rather than a constraint, and the field's
*name* promises the stronger claim. The failure mode without it is silent and
nasty — a pointer left on an archived revision reports that revision's stale
time and memory limits as live, on the problem page, with nothing looking
wrong. With it, the same bug degrades to `false`. No test fixture changed,
because all existing data already satisfies it. Cost if wrong: nil.

Ruling R18 (Minor, accepted): `likeEscape`'s backslash branch was correct and
correctly ordered but untested — the four existing cases all pass even with
the ordering reversed. Added the two cases that distinguish them, and verified
by mutation that moving the backslash replace last fails with
`expected 'a\\\\b' to be 'a\\b'`. An escape whose ordering nothing pins is an
escape that silently stops working the next time someone tidies the chain.

Task 3: complete at 13b9746 (+ fix). BASE for Task 4 recorded below.

### Task 4 — review verdict: spec PASS, quality CHANGES REQUESTED (one Critical)

I raised the org-slug resolution as an existence oracle and asked the reviewer
to pressure-test it rather than agree. It came back with something worse, and
proved it: a setter with **no relation to a private organization** created a
problem with that org's slug, and a member of that org then read it. That is
unauthorized content injection into a private org's problem set. The oracle is
the corollary, not the finding.

It also correctly bounded the claim rather than inflating it: the attacker must
already be a setter/admin or an author/curator, because `resolveOrgIds` runs
after those gates, and no HTTP route reaches this yet — the problems controller
does not exist until Task 7. So this is Critical-but-latent, and the real
deadline is "before Task 7 wires the routes", not "before the next commit".

Ruling R19: **membership, not visibility.** My own counterexample — a teacher
sharing with a class they administer but are not enrolled in — dissolves on a
schema fact I should have checked before raising it: `org_role` is
`owner | admin | member`, so administering a class *is* an `org_members` row.
Visibility-only would still let any setter inject into every public org's
catalog, which is the same harm with a larger audience. Cost if wrong: a
legitimate share is refused and someone asks for it.

Ruling R20: the error for an organization the actor may not see must be
**byte-identical** to the error for one that does not exist, or the fix
restores the oracle it was meant to close. A *public* org where the actor is
simply not a member may return a distinct error safely — `GET /orgs` already
lists those, so nothing new leaks.

Ruling R21 (where the fix lives — the reviewer rejected both horns I offered):
neither "reuse OrgAccessService" nor "duplicate the check". This repo already
answered this question once, in this phase: when problem visibility needed a
second consumer it became free functions in `problem.visibility.ts`, precisely
so a later caller could use it without depending on the service. Mirror it —
`org.visibility.ts` holding the visibility condition plus a membership helper,
consumed by both services. One rule, no service-to-service coupling. This is
scope beyond Task 4's brief and I am taking it deliberately, because the
alternative is a Critical finding parked until a task that has not been
written yet.

Ruling R22: case-sensitivity in both resolvers is a real bug but **not** a
security one — the unique indexes are `lower()`-based, so an exact-match lookup
can only fail closed, never resolve the wrong row. Fixed alongside, not
escalated.

### Task 4 — fix round 1 re-review: all six items ADDRESSED

Re-reviewer ran two mutations of its own rather than reusing the
implementer's, each reverted with a byte-identical diff check afterwards. One
reproduced the exact pre-fix 500 — a raw `23505` on
`problem_members_problem_id_user_id_role_pk` — confirming the dedupe test is
load-bearing rather than decorative. It also read the deleted
`visibilityCondition` against the extracted `visibleOrgsWhere` line by line
and confirmed the only change is `this.db` becoming a parameter; a passing
`OrgAccessService` suite would not have proved that on its own.

Ruling R23 (Minor, accepted as a recorded deferral): a **timing** channel
survives. `resolveOrgIds` fail-fasts on a non-existent slug after one query,
while a non-membership failure costs every slug's lookup plus the membership
query — so existence failures are systematically faster, and in a multi-slug
batch the query count before failure scales with the failing slug's position.
Real, and theoretically binary-searchable. Not fixed, for two reasons the
reviewer got right: it needs many precise timing samples to distinguish one
extra indexed query, and it is **no worse than the `problem_not_found` pattern
this codebase already uses everywhere** — that path also costs an existence
query plus `loadProblemContext`. Fixing it here alone would buy nothing while
the same shape stands in three other services. If timing resistance is ever
wanted it is a project-wide decision, not a Task 4 one. Cost if wrong: an
attacker with a very quiet network learns which private org slugs exist.

Task 4: complete at 34c0b3c. 18 tests in problem-writes, apps/api 170/170.
The Critical is closed **before** Task 7 wires any HTTP route to it, which was
the actual deadline.

### Task 5 — implementer DONE at 7d8a68c, five plan defects reported

Ruling R24 (plan defect, mine, and the worst one this phase): the brief's
version-retry loop caught the unique violation and retried. That is wrong
inside a transaction — a constraint violation aborts the whole transaction, so
the retry's own `max(version)` read fails with `25P02 current transaction is
aborted`. The implementer replaced it with `onConflictDoNothing().returning()`
retrying on an empty result, which never raises and therefore works in both
places. Note the shape of this bug carefully: the catch-based version would
have *appeared* to work in production, where each attach is its own
transaction, and failed only under the test harness that wraps each case in
one. A defect visible only under test is still a defect — the harness is where
it has to work too. Plan corrected. Cost if wrong: nil, the replacement is
strictly more general.

Ruling R25 (plan defect): Step 6 told the implementer to build the collision
fixture by uploading a package containing both spellings. Impossible —
`POST /packages` already rejects colliding and manifest-less packages, so
upload cannot produce the state this check exists to catch. Seeding the store
blob and the `packages`/`package_files` rows directly is correct. Plan
corrected.

Ruling R26 (my dispatch was wrong, not the plan): I told the implementer a
`loadForEdit` helper "very likely already exists" in `problem.access.ts`. It
did not — the logic was inline in `update()`. It extracted the helper and
refactored `update()` onto it, which is what I would have asked for had I
checked. Recorded because I asserted a fact about the codebase without reading
it, and the implementer had to spend effort discovering I was wrong.

Ruling R27 (the best thing in this report): the implementer **falsified one of
its own planned mutations**. Deleting the `!entry` guard does not fail the
no-manifest test, because the surrounding try/catch re-wraps the resulting
`TypeError` into an identical 400 `package_invalid` — so the guard improves
the message and nothing else. Rather than record a mutation that "passed", it
found one that genuinely discriminates and used that. This is the second time
this phase an implementer has reported that its own evidence did not hold up;
both times the alternative was a green tick nobody would have questioned.

Also confirmed acyclic: `PackagesModule` imports only `AuthnModule`, so
`AuthzModule -> PackagesModule` needed no `forwardRef`. `PACKAGE_STORE` had no
`exports` entry before this task and now does.

### Task 5 — review verdict: spec PASS, quality APPROVED

Reviewer independently re-ran seven mutations, including two the implementer
never tried: dropping `.normalize('NFC')` fails **only** the NFC test and
dropping `.toLowerCase()` fails **only** the case test, which is strictly
stronger evidence than the implementer's own Step 6 (which removed the whole
call and could not tell the two folds apart). It also raced four corruption
probes against a 10-second timer to prove `readArchiveEntry` cannot hang.

It corrected the implementer on the `!entry` guard, in the useful direction:
deleting it does leave the test green, but it also fails `tsc` with
`TS18047: 'entry' is possibly 'null'`. So the guard is compile-enforced, and
keeping it needs no test-based justification at all.

Ruling R28: **my spec §9 was wrong.** It listed case/NFC path-collision
validation as carried debt this phase fixes. `git log -S` shows
`findPathCollision` landed in Phase 2a at 61d437c, in `POST /packages` — the
Phase 2a ledger's "belongs in upload or the materialiser" was *acted on* in
that phase and I read the ledger entry as an open item. What this phase
actually adds is a second gate at attach time, which is genuinely useful
because a package row can be seeded directly without passing upload.

Ruling R29: two implementations of one security-relevant fold is exactly the
defect this phase exists to eliminate, and I am not shipping it. The upload
version keys three maps (lower, NFC, NFC+lower); the attach version keys one
(NFC+lower). They happen to be equivalent in detection power — NFC-then-lower
is the coarsest fold and subsumes the other two — but "happens to be
equivalent" is not a property anyone will re-derive in a year. One
implementation in `@duckoj/package-format`, consumed by both.

Ruling R30: the same `package_path_collision` code returns 400 at attach and
422 at upload. Align on **422**: the request is syntactically fine and
semantically unprocessable, which is what 422 means, and it avoids changing an
endpoint that already shipped. Spec's error table corrected.

Ruling R31 (Minor, deferred): a valid-zstd/truncated-tar archive yields a
silently truncated buffer rather than rejecting. Benign downstream —
`JSON.parse` of a prefix throws and becomes 400 `package_invalid` — and the
reviewer proved it never hangs. Recorded, not fixed: the honest fix is tar
checksum verification, which belongs with the archive format rather than here.

### Task 5 — fix round 1: my equivalence claim was WRONG, and it is a security hole

I asserted that a single `NFC+lower` fold subsumes the upload version's three
maps, and told the implementer to verify before collapsing. It brute-forced
every assigned code point crossed with the U+0300-U+036F combining-marks block
— about 1.6 million candidates — and found 60 pairs where the combined fold
misses a collision that the case-alone fold catches.

I verified the simplest one myself rather than take it on report:

    'H̱' = U+0048 U+0331   (H + combining macron below)
    'ẖ' = U+0068 U+0331   (h + same mark)

    toLowerCase()            -> U+0068 U+0331  |  U+0068 U+0331   EQUAL
    normalize('NFC').lower() -> U+0068 U+0331  |  U+1E96          NOT EQUAL

Only the lowercase form has a precomposed NFC target (U+1E96); the uppercase
one has none, so normalising first and lowering second changes the code-point
count on one side of the pair and not the other. Two files named `H̱.txt` and
`ẖ.txt` collide on any case-insensitive filesystem, and my "simplification"
would have waved them straight through to a judge.

Ruling R32: the three-map version is canonical and moves verbatim into
`@duckoj/package-format`. Both callers use it; no private copies remain.

The general lesson, recorded because it will apply again: **composition of
two normalising folds is not the composition of what each fold catches.**
`f(g(x)) == f(g(y))` does not follow from `f(x) == f(y)`, and Unicode is
full of cases where it fails. Any future "we can simplify these three checks
into one" needs the same brute-force before it is believed — including when
the person proposing it is me, and especially then, because nobody in this
loop is positioned to push back on the coordinator except by doing the work.

Task 5: complete at 42381b2. apps/api 179/179, package-format 34/34 (6 new).

Task 6: implementer DONE at 70b8cbb. 8 new tests, apps/api 187/187, workspace
348/348 across 12 packages.

Ruling R33 (brief defect, accepted): the brief's Files list named only
`problem.access.ts`, but `listRevisions` needed a permission the existing
predicates could not express — a tester lists drafts, while a plain user 404s
even on a *public* problem, because public visibility governs the published
statement and says nothing about drafts that may contain unreleased tests and
answer keys. The implementer added `canViewRevisions` to
`problem.visibility.ts` rather than inlining the check where it was needed.
That is the correct reading of the rule over the letter of my Files list, and
the right instinct: a permission decision that lives outside the predicate
module is a permission decision nobody will find later.

Ruling R34: Task 6's Step 4 mutation broke **three** tests, not the one I
predicted — the archive assertion, the pinning test's archived premise, and
the rollback case. Better than expected, and recorded because my predictions
of mutation blast radius have now been wrong in both directions this phase
(Task 2 predicted three and produced two; this predicted one and produced
three). The prediction is not the point; running it is.

Carried to review: the implementer disclosed that the submission-pinning test
**cannot fail** against any correct-shaped `publishRevision`, since nothing in
that method touches `submissions`. It reported this rather than letting a green
tick stand — the third such self-falsification this phase. Whether the test
earns its place as a guard against a *future* design change, or should be
deleted, is the reviewer's call.

Ruling R35: Task 7 is split into **7a** (contracts, controller, registry fix —
the problems surface, on the critical path) and **7b** (OpenAPI backfill,
route-coverage drift test, served `/docs` viewer — not on the critical path).
Eight steps in one task is too large a review surface, and this phase's value
has come from small diffs reviewed hard.

### Task 6 — review verdict: spec PASS, quality CHANGES REQUESTED (one Important)

Ruling R36 (Important, accepted — this is a real bug): two concurrent
`publishRevision` calls targeting different not-yet-published revisions of the
same problem race with **no lock contention whatsoever**. Under READ COMMITTED
— confirmed as the effective level, with no override anywhere in
`packages/db/src` — each transaction's archive step (`WHERE state='published'`)
matches only rows already published *at its own snapshot*, and neither sees the
other's uncommitted target. Both commit. Two rows end up `published` for one
problem, with no error raised anywhere.

`currentRevisionId` itself survives — it ends up pointing at whichever
committed last, and that row is published — so Task 3's join does not break
and nothing looks wrong from the outside. That is what makes it worth fixing
now rather than later: the invariant breaks silently and the symptom appears
somewhere else entirely, whenever something first assumes "at most one
published revision per problem".

The fix is **both** halves, not either:

- `SELECT ... FOR UPDATE` on the `problems` row before reading the target,
  which serialises publishes per problem so the race cannot occur in practice;
- a **partial unique index** `ON problem_revisions (problem_id) WHERE state =
  'published'`, which makes the invariant true by construction rather than by
  convention, and catches any future code path that bypasses the lock.

This mirrors Task 1's pattern exactly — the unique index on `(problemId,
version)` plus a retry — and for the same reason: a lock protects the code you
wrote, an index protects the code someone writes next. Cost if wrong: one
migration and one `FOR UPDATE`.

Ruling R37: the submission-pinning test **stays**, with a comment naming what
it guards. The reviewer's judgement, which I accept: it is a genuine regression
guard against a future design change — someone adding a "rewrite
`submissions.revisionId` to follow `currentRevisionId`" step, a cascade delete
of archived revisions, or a submission read that joins through
`problems.currentRevisionId` instead of the pinned column. It cannot fail
today, and that is a fact about the current design rather than a defect in the
test. What was missing is that nothing said so.

Ruling R38 (Minor, accepted): the idempotence test cannot distinguish the
`state !== 'published'` guard from an unconditional archive-then-republish,
because no `updatedAt` or audit column exists to observe the difference. Left
as-is and recorded — adding an audit column to make a test observable is the
tail wagging the dog, and the guard is still correct.

### Task 6 — fix round 1 complete at 40b167f. Two false starts, both reported.

The implementer wrote the concurrency test three times and told me about the
two it threw away. Both failures are worth recording because both *passed*:

1. Two real `publishRevision` calls under a bare `Promise.all` passed **with
   the lock removed** — each transaction's whole lifecycle completed before
   the other's first statement was sent, so no overlap window ever opened on a
   fast local Postgres.
2. A version holding an idle `problems`-row lock on one connection also passed
   without the lock, and this one is sharper: `publishRevision`'s unconditional
   final `currentRevisionId` write contends with the held lock *regardless* of
   the mutation, so the test blocked either way and was never observing the
   thing it claimed to.

Both would have shipped as green ticks. The second is the kind that survives
review, because it blocks, and blocking looks like working.

The kept version replays the transaction's statements by hand, pauses before
commit, and lets a real service call race it — **without the lock it fails
deterministically** with `duplicate key value violates unique constraint
"problem_revisions_one_published_idx"`.

Ruling R39: the timing-dependent test is kept but is **not** the durable
guard. It leans on a 150 ms window, and a slow enough CI machine degenerates
it to a false pass — losing discriminating power silently, which is the
failure mode this phase keeps finding. The durable guard is the separate
deterministic test the implementer added unprompted: two direct `UPDATE`s to
`published` on one problem, asserting `23505`. That one has no timing
dependence and fails immediately if migration 0006 is ever reverted. The
timing test covers the lock; the deterministic test covers the index; the
index is the half that actually holds the invariant, so coverage degrades
gracefully rather than to zero.

Migration 0006 verified by me: a single partial unique index, no table
rewrite, no drop-and-recreate. `problem-publish` 11/11, `@duckoj/db` 20/20.

Task 6: complete at 40b167f. BASE for Task 7a recorded below.

Task 7a: implementer DONE at 024a6c5. 7 new tests, workspace 358/358 across
12 packages. Task review dispatched.

Ruling R40 (brief defect, mine): I told the implementer to assert
`registry.servers[0].url`. `OpenAPIRegistry` has no `servers` property — only
the *generated document* does. It corrected to `openApiDocument().servers[0].url`
and reported it. That is the seventh plan or brief defect this phase, and the
fourth of mine specifically about an API I asserted without reading.

Ruling R41 (real latent bug, found by the implementer as a "worth knowing"
note and escalated by me after checking): `CreateProblemRequest` defaults
`visibility` to `'private'` in zod while `ProblemAccessService.create` fell
back to `'public'`. Over HTTP the two never disagree observably, because the
zod default fills the field before the service is reached — which is exactly
why this survived six tasks and two reviews of the same file. A caller that
bypasses the pipe reaches the fallback: a seed script, a future import tool, a
direct service test. That caller silently created a **world-readable** problem.
Fixed to `'private'` at 0196731, with a test verified by mutation
(`expected 'public' to be 'private'`). Deny-by-default is the direction to be
wrong in, and it is what the rest of this codebase already does. Cost if
wrong: a direct caller has to name the visibility it wants.

Watch item W1 — **the `dist/` trap, fourth sighting across three phases.**
The implementer's first mutation demo passed spuriously because `apps/api`
resolves `@duckoj/contracts` through its built `dist/`, not live `src/`; it
caught this itself and rebuilt before re-running. The user caught the first
instance of this class personally, before Phase 2 began. `pretest` hooks cover
the *test run* but not a mid-session mutation check, which is precisely when
someone is deliberately breaking source to see a test fail — the moment a
stale `dist/` is most dangerous, because a spurious pass there is read as
"the test cannot fail" and the test gets rewritten or deleted. Not fixed here;
the honest fix is a tooling change to the mutation workflow. Recorded for the
phase ledger and for Task 15.

### Task 7a — review verdict: spec PASS, quality APPROVED

Reviewer ran four mutations from a clean tree, rebuilding contracts each time
to avoid the `dist/` trap that had already burned the implementer. All four
failed as claimed. It also checked the `problem_code_immutable` special case
for bypasses I had not thought to ask about — `Code` casing, a nested
`{x:{code}}`, and `__proto__`-style keys — and found none: each either hits
`.strict()`'s `unrecognized_keys` or never reaches the service.

Ruling R42: the bespoke `UpdateProblemBodyPipe` stays. I asked whether it was
machinery built to satisfy one error code, and the answer is no — it is ten
lines intercepting one literal key, falling through to the ordinary 422 for
everything else, and the spec names `problem_code_immutable` as a required
code with a test asserting it.

Ruling R43 (the reviewer filed this as cosmetic; it is not, and I escalated
it): deriving the OpenAPI `servers` entry from `API_PREFIX` produced
`'api/v1'` — a **relative** server URL, where it used to be `'/api/v1'`.
`API_PREFIX` is deliberately bare because `setGlobalPrefix` wants it bare, and
its own docstring says callers add the slash themselves. A relative OpenAPI
server URL resolves against the location the *document* was served from, so a
document at `/docs/openapi.json` would send every "try it" request to
`/docs/api/v1`. Nothing consumes `servers[0].url` today, which is why the
reviewer scored it cosmetic — but **Task 7b serves the document behind a
viewer**, which is precisely the thing that consumes it. Fixed to
`` `/${API_PREFIX}` `` at 49ef010: still one source of truth, now correct
wherever it is hosted. Cost if wrong: nil.

Note the shape: this is my brief's error again — I wrote the assertion
`toBe(API_PREFIX)` into Step 2 without checking what `API_PREFIX` contained,
and the implementer implemented my snippet faithfully. A test asserting the
wrong thing passes just as green as one asserting the right thing. Two
assertions had drifted to the wrong value (contracts and apps/api); the
apps/api one failed the full-workspace run and caught the second copy, which
is the whole reason that duplicate assertion earns its place.

Task 7a: complete at 024a6c5 (+ 0196731, 49ef010). Workspace 359/359.
BASE for Task 8: 49ef010.

### Task 8 — the phase's central constraint, discharged

Implementer DONE at 4e3cde6. apps/api 201/201 across 29 files, workspace green.

The evidence Step 2 was written to produce, verbatim against **unmodified**
code:

    x accepts a submission from a member of an org the problem is shared with
      -> expected 404 to be 201
    x accepts a submission from a tester of a private problem
      -> expected 404 to be 201

That is the bug this Global Constraint was written to prevent, caught in the
act. An org member could see an org problem in the list and got a 404 when
they submitted to it; a tester could read a private problem and could not
submit to it. Neither had any test, in either service, because each service's
own tests were internally consistent — the exact "green suite, broken
integration" shape that has now cost this project five bugs across three
phases.

Ruling R44 (unprompted, and the right instinct): the implementer noticed that
the *other two* tests — the rejection cases — passed **before** the fix as
well, because the old check rejected every non-public problem uniformly. A
test that passes identically on both sides of a behaviour change proves
nothing about that change. Rather than bank two free green ticks, it sabotaged
the new predicate afterwards (`if (false && !canViewProblem(...))`) and
confirmed both then fail with `expected 201 to be 404`. This is the fourth
self-falsification this phase and the most subtle: nothing would have looked
wrong, because the tests were passing for a reason that had simply stopped
being the reason.

Step 5 grep: **no third copy.** The remaining `visibility` hits are org
visibility (a genuinely separate predicate with its own module) and
`problem.access.ts`, the predicate's legitimate consumer. The duplication that
opened this phase is closed.

No existing test expectation was changed, which the reviewer is checking is
good news rather than a coverage gap.

### Task 8 — review verdict: spec PASS, quality APPROVED

Reviewer reproduced **both halves** of the implementer's evidence rather than
accepting either: checked out the pre-fix `submission.access.ts` and got the
same two 404s, then restored HEAD, applied the sabotage, and got the same two
201s. It also confirmed the pre-existing "private problem is not an existence
oracle" test would have caught the sabotage, so that one is not a coverage gap
either.

Its verdict on my item 4 (does reading a submission back leak a problem code
the reader cannot see?): **not a real gap.** `getVisible` gates on
owner-or-admin before returning any row, so the caller is either the
submission's own author — who necessarily knew the code when they submitted —
or an admin who can see every problem anyway. No third party reaches the path.

Ruling R45 (Minor finding, fixed by me at the commit above): the
"unpublished revision is refused" guarantee had a test, but it used a plain
non-member, so it would survive the guard being folded into the visibility
check. Added the role-blind case — an author, the actor most able to see the
problem, must still be refused, or a setter could submit against their own
draft and the judge would be handed an unpublished revision. Verified by a
**role-dependent** mutation (members bypass the published guard) which fails
**only** the new test; the existing one passes straight through it. That is
the proof the new test covers something the old one did not, rather than
restating it.

### Task 9 — CE verdict. Complete at 8c512ba, reviewed by me directly.

The whole source change is one line: `verdict: 'IE'` becomes `verdict: 'CE'`
in `apps/judged/src/event-writer.ts`. I reviewed it myself rather than
dispatching an agent — a one-line diff with a verified pre-fix failure
(`expected 'IE' to be 'CE'`) and a verified discriminating guard does not need
a second reader, and spending one would be process for its own sake.

Ruling R46 (ledger correction, and the implementer was right to check): the
Phase 1 ledger recorded this as "a compile error is reported as verdict `IE`
because `case_verdict` has no `CE` member". True as far as it went, but it
implied more was broken than was. `compileOutput` was **already** populated
with the compile log on that path, and `dmoj-driver.ts` already translated the
DMOJ `compile-error` packet into a `compileError` event correctly. Only the
verdict label was wrong. I told the implementer to confirm the ledger's claim
before acting because ledger entries age badly, and this one had — not by
becoming false, but by being read as broader than it was.

The IE-guard test earns its place: sabotaging `internalError`'s verdict to
`'CE'` fails it with `expected 'CE' to be 'IE'`. Without it, a mapping that
sent *everything* to `CE` would pass a suite that only proved
`compileError -> CE`.

Flake watch: **no sighting.** `worker.spec.ts`, `job-store.spec.ts` and
`dmoj-driver.spec.ts` were green across two full-workspace parallel runs. The
count stands at three sightings across two phases, still unreproduced.

Workspace 367/367. BASE for Task 10: 8c512ba.

Task 10: implementer DONE at 2d030f0. 6 new tests, apps/api 208, workspace
373/373. Review dispatched — this is the only route in the system that can
mint an admin, so it gets an opus reviewer and a privilege-escalation lens.

Ruling R47 (worth recording as method, not just outcome): the implementer was
asked whether a live session caches `globalRole`. It found the answer is no —
`SessionService.resolve` and `TokenService.resolve` both re-join `users` per
request — and then did the thing that makes the answer trustworthy: it
**temporarily injected a simulated role cache** and confirmed the new
integration test caught it (`expected 403 to be 200`), then reverted.

That distinction is the whole point. A test asserting a property that happens
to already hold proves nothing about the test; only showing it fails when the
property is false proves the test would notice a regression. This is the same
reasoning as a mutation, applied to a *negative* finding — "X is not broken"
is a claim that needs evidence exactly as much as "X is broken" does. Four
tasks this phase have now produced evidence of this shape, and it is the
single practice most responsible for the phase's defect count being real
rather than decorative.

Ruling R48: the implementer added a sixth test beyond the brief — case-
insensitive username resolution — on the grounds that it was the one mandated
behaviour with nothing pinning it, and that the identical bug class
(`eq()` against a `lower()`-backed unique index) had already shipped once this
phase in `resolveOrgIds`. Correct call, and exactly the kind of scope
expansion I want an implementer to make without asking.

Carried to the reviewer as an open question I have no strong view on: what
happens when the last admin demotes themselves. The grant route becomes
permanently unreachable and the only way back is SQL. Prevented, documented,
or silently possible — I want to know which before deciding whether it needs
fixing.

### Task 10 — review verdict: spec PASS, quality CHANGES REQUESTED (one Important)

Ruling R49 (Important, accepted — a real privilege escalation): the admin
grant route carries no `SessionOnlyGuard`. The reviewer **demonstrated it**:
an admin minted a token scoped `['submissions:read']` and used it to
`PATCH /admin/users/probe-victim {globalRole:'admin'}`, and got a 200.

Two things make this worse than it first looks. `Actor.scopes` is dead data —
the reviewer grepped and found no enforcement anywhere outside
`session-only.guard.ts` itself, so a token's declared scopes constrain nothing.
And `TokensController` already applies this guard class-wide, with a docstring
naming exactly this threat: "a machine credential must not rewrite the
credentials that govern it." The only admin-minting route in the system is a
strictly stronger case than the token-management routes that are already
protected.

The consequence is durable in the bad way: a leaked admin token becomes a
permanent admin-minting capability that **survives its own revocation**,
because it can mint a fresh admin before anyone notices.

Ruling R50 (item 2, my open question, now answered): a sole admin demoting
themselves is **silently possible** — the reviewer probed it and confirmed 0
admins remaining, with both the existing session and a pre-existing token then
403ing on every grant. Decision: refuse **self-demotion out of admin**, and
document the SQL recovery.

I chose that over counting remaining admins deliberately. A count is racy —
two admins demoting each other concurrently both read "2 admins" and both
succeed — and fixing the race properly means a lock and a transaction for a
scenario that requires two administrators actively racing. "You cannot demote
yourself" is race-free without counting, blocks the realistic accident
completely, and leaves the exotic case to the documented SQL. Cost if wrong:
an admin stepping down asks another admin to do it.

Ruling R51 (Minor, accepted): `app.smoke.spec.ts` asserts nothing about
`/api/v1/admin/users/x` behind the real prefix. That file exists precisely
because a route once worked in tests and 404'd behind the real prefix, and its
internal-packages assertion was added for that exact gap class. A new route
that skips it is the gap reopening.

### Task 10 — complete at 41c5235. All four fixes verified.

Token-vs-session test without the guard, verbatim:

    x a scoped access token gets 403 session_required on the grant route;
      the same admin's session gets 200
      -> expected 200 to be 403

I verified the two security-relevant fixes myself rather than by report:
`@UseGuards(SessionOnlyGuard)` is class-wide on `AdminUsersController`, and
the self-demotion check compares `actor.userId === target.id` — by id, not by
username string, so a `MixedCase` request cannot slip past a `mixedcase`
session.

The smoke-test fix is the one I want noted for Task 15: it asserts the route
answers **401, not 404**, behind the real `/api/v1` prefix, and was
demonstrated failing by pulling `AdminModule` out of `AppModule`. A 404 there
would mean the route does not exist in production while every controller test
passes — which has happened twice in this project and is the single failure
shape this phase has spent the most effort guarding against.

apps/api 211, workspace 376/376. BASE for Task 11: 41c5235.

Note for Task 11: it consumes the generated SDK, so `packages/sdk`'s
`generate` script must run against a freshly emitted `openapi.json` before the
web work starts, or the web app will be typed against a document that predates
Tasks 7a and 10.

### Task 11 — complete at d0e30d2 (+ 9525af2, 806ccf5). Web list and detail.

Sanitizer trio without `DOMPurify.sanitize`, verbatim — all three fail:

    x strips a script tag       -> expected '<script>alert(1)</script>' not to contain '<script'
    x strips an onerror handler -> expected '<img src=x onerror="alert(1)">' not to contain 'onerror'
    x strips a javascript: href -> expected '<a href="javascript:alert(1)">x</a...' not to contain 'javascript:'

I verified the ordering myself, because it is the one thing about this file
that cannot be caught by a passing test: `renderStatement` is
`markdown.parse(...)` then `DOMPurify.sanitize(...)`. Sanitize is last.
Reversing them would strip nothing — Markdown source rarely contains literal
`<script>` in a form DOMPurify's HTML parser recognises — and then hand the
unsanitized rendered HTML to the DOM. The three XSS tests would still pass.

SDK regeneration: **zero diff.** `generated.ts` was already current and all
four problem routes were present, so Task 7a's registrations did reach the
document. Worth knowing rather than assuming.

Ruling R52: **`@tanstack/react-router` is a declared dependency that is
imported nowhere.** It has been unused since Phase 0. The implementer did not
adopt it and documented why; it hand-rolled a `parseRoute` matching
`window.location.pathname` against two shapes, with plain `<a href>` links and
no History API listener.

I am not adopting a router mid-phase — that is a structural decision that
deserves its own design, and taking it while five tasks are in flight trades a
known-small inconsistency for an unknown-large one. But it does not survive
Phase 3: Task 12 adds three more routes, taking this to five hand-matched
paths with full page loads between them, and that is the point where the
absence starts costing real behaviour rather than elegance.

Instruction carried to Task 12: **extend `parseRoute`, do not invent a second
mechanism.** Two half-routers is worse than one hand-rolled one.

**Correction owed to the user:** when they asked about the tech stack, I
listed "React 19 with TanStack Router and TanStack Query". That was wrong.
TanStack Query is used throughout; TanStack Router is declared in
`apps/web/package.json` and imported by no file. I read the manifest and
reported the dependency list as though it were the architecture.

### Caddy findings while Task 12 runs

Ruling R53: **Task 11's deep-link concern is already satisfied** — I read the
`Caddyfile` rather than carrying the worry forward. The catch-all is
`try_files {path} /index.html`, so `/problems/aplusb` already serves the SPA
on a cold load. No work needed; Task 13 verifies it rather than fixing it.

Ruling R54 (prevents a bug rather than finding one): **Task 7b must serve the
OpenAPI document and viewer under `/api/v1/`, not at the root.** The Caddyfile
proxies `/api/*`, `/ws` and the two probes; everything else falls through to
the SPA catch-all. A document at root `/openapi.json` would therefore answer
**200 with index.html** — not a 404.

That is strictly worse than the `/ws` bug this project already paid for. A 404
is obvious and gets fixed in a minute; a 200 carrying the wrong body looks
like success, and the first symptom is a docs viewer that renders nothing with
no error anywhere. Serving under the existing prefix means `handle /api/*`
already routes both and the Caddyfile needs no edit — one less place for two
configs to disagree. Brief updated before the task is dispatched, which is
cheaper than finding it in Task 13.

### Task 12 — BLOCKED, correctly. A spec requirement was silently dropped.

The implementer stopped rather than shipping a placeholder panel, and it was
right to. But the defect is larger than it reported: spec §4.1's
`GET /problems/:code` response body lists **both** `members` and `orgSlugs`.
`ProblemDetail` has neither.

Ruling R55 (process, and the important one): **Task 7a's review passed this on
spec compliance because it reviewed against my brief, and my brief was
narrower than the spec.** The brief said "Produces: ... `ProblemDetail`"
without restating the response shape, so neither the implementer nor the
reviewer had the field list in front of them. Global Constraint says the spec
is the binding authority and the plan merely argues from it — but a reviewer
can only enforce what it is handed.

Every remaining brief must carry the spec's response shapes verbatim, not a
type name. A type name is a promise that someone else already checked the
fields, and here nobody had. This is the first defect this phase that four
separate readers looked straight past, and it survived because the thing that
would have caught it was never in the room.

Ruling R56: add both fields to `ProblemDetail` and populate them in
`getVisible`, before Task 12 resumes. `members` is credit and the spec makes
it public to anyone who can see the problem. `orgSlugs` is not symmetric with
it and must **not** be — Task 4's reviewer already flagged that returning the
full list to any viewer discloses the names of private organizations a problem
is shared with, which is the same leak class as the injection bug that task
fixed.

So: editors (author, curator, admin) get the **full** set, because a
whole-set PATCH replacement is unsafe against a list you cannot fully read —
submit a filtered list back and you silently unshare the orgs you could not
see. Everyone else gets the set filtered to organizations they may see. That
asymmetry is deliberate and needs saying out loud in the code, because it
looks like a bug to anyone who finds it later.

### Task 12 — complete at d52f63e + c07f801, and it found a bug I created

Ruling R57 (a bug **introduced by R56**, found by the implementer, confirmed
by me): `update()` passes the whole `orgSlugs` set to `resolveOrgIds`, which
requires the actor to be a member of **every** org named — including ones
already attached to the problem.

R56 gave editors the full `orgSlugs` set precisely so a whole-set PATCH could
round-trip safely. It cannot. Concretely: an admin shares problem P with
private org X; author A, not a member of X, now correctly sees `['x']`. If A
wants to add org Y, A must send `['x','y']` — rejected, because A is not in X.

And the failure mode is the worst available shape. A is not merely blocked:
the **only** request A can get accepted is `['y']`, which succeeds and
silently unshares X. Every safe path is refused and the destructive one goes
through. A UI that "helpfully" retries without the rejected slug would do
exactly this.

The fix separates two rules that were wrongly fused. *You may not share a
problem with a group you do not belong to* is a security rule and stays.
*You may not silently destroy an existing share* is a safety rule and is new.
Both hold if membership is required only for orgs being **added** — orgs
already attached may be retained by any editor. `create` is unaffected, since
every org there is an addition.

Recorded as a ruling rather than a quiet fix because it is the second time
this phase that a correct-looking security check produced a worse outcome than
the hole it closed. The first was the 404-vs-403 ordering in Task 4. Both
share a shape: the check was right, and its **interaction** with a neighbouring
rule was not.

Ruling R58 (Phase 3 evidence, answered honestly as asked): `parseRoute` at
five routes is "not broken, but no longer free". It needed explicit
static-before-dynamic ordering — `/problems/new` must be matched before the
generic `/problems/:code` capture — plus three hand-written regexes.
Correctness now depends on a human reading the file top to bottom in the right
order, rather than a router resolving specificity structurally. That is the
concrete cost, measured rather than predicted, and it is the argument for
adopting `@tanstack/react-router` in Phase 3.

### Task 12 — complete at d52f63e + c07f801 + ac7f66a

Pre-fix failure for the retention bug, verbatim:

    x an editor who is not a member of an already-attached private org can
      PATCH while retaining it
      AppError: No such organization.
        at ProblemAccessService.resolveOrgIds (problem.access.ts:736)
        at ProblemAccessService.update (problem.access.ts:296)

I verified the shape myself: `create` calls `resolveOrgIds` with no retained
set, so every org there is still an addition and its behaviour is unchanged;
`update` passes `new Set(ctx.sharedOrgIds)`, the problem's full attached set,
not the viewer-filtered one. The error stays identical for a non-existent org
and an unauthorised addition, preserving Task 4's indistinguishability.

Ruling R59: removal does **not** require membership, and the implementer
supplied the argument I had not: gating removal on membership means a
departed member's stale share becomes **permanently stuck**, with no route to
fix it short of admin intervention. Editing rights on the problem, not
membership in the org, govern what an editor may do to that problem's sharing
state. The security property that actually matters — you cannot newly share
into a group you do not belong to — is untouched.

Web side needed no change: `problem-edit.tsx` pre-fills from the editor's full
`getVisible` read and resends that exact string when untouched, so it was
already sending the safe full set rather than a partial one. Checked rather
than assumed.

### Task 13 — the live stack. Complete at 00c72f4. Three defects, all invisible to 391 green tests.

The full path works: register -> bootstrap admin -> grant setter -> create ->
upload package over HTTP -> attach -> publish -> make public -> submit -> AC
10/10. Then uncompilable source -> **CE from a real judge**, twice: once
against the seeded package and once against a package uploaded over HTTP in
the same run. Task 9's one-line fix is now proven against `judge-server`
rather than a fake driver. Stack came up from **zero volumes**, all four
images built clean, migrations ran through 0006, and the Phase-1-era `aplusb`
problem still grades after every migration this phase added.

**D1 — the worst one, and the exact shape this task exists to catch.**
`problem.tsx` links to `/submit?problem=<code>`, and `SubmitPage` hardcoded
`aplusb` and never read the URL. So pressing Submit on *any* problem page
silently graded the submission **against a different problem**. No 404, no
error — a plausible verdict for the wrong tests. Every web test passed,
because each page's tests were internally consistent and nothing exercised the
link between them. This is the fifth instance of that shape across three
phases and by far the most damaging.

**D2** — `VerdictPanel`'s compile-error branch keyed on `verdict === 'IE'`,
which Task 9 made unreachable, so a compile error rendered as a bare `CE` with
no explanation. The branch had **no test at all**, which is why fixing the
verdict in Task 9 silently broke its only consumer.

**D3 — stale documentation actively defending the bug that was just fixed.**
The runbook described the IE-for-compile-error behaviour as "expected, not a
bug to chase", and `e2e-submit.ts` carried a comment saying "do not assert
CE". Both were true when written and became false at Task 9. Left alone, they
would have licensed a future reader to revert the fix as a mistake — worse
than no documentation, because they carried the authority of a deliberate
decision. Rewritten, and the assertion added.

Ruling R60: D3 is the item I want carried into Task 14 as a rule, not an
anecdote. **Every ledger and runbook entry this phase invalidates must be
rewritten, not merely superseded.** Phase 2b has now falsified at least four
recorded claims — this one, the "path-collision validation is outstanding"
entry, the "compile output is missing" implication, and Task 11's
`@tanstack/react-router` line in my own tech-stack answer. Documentation that
describes a fixed bug as intended behaviour is a trap with a signature on it.

Caddy: all six SPA routes deep-link correctly, `/ws` still answers from the
API rather than the catch-all, and the reviewer executed the real
Caddy-served bundle in jsdom against the live stack — the problem list, the
problem page with three KaTeX nodes, and all three authoring screens rendered
real data. Not verified: how a browser actually paints it. There is no browser
on this machine and I did not install one.

### Task 7b — complete at 412ffe4, plus my compose fix at f0c72e5

The docs viewer is live and I verified it through Caddy myself:
`/api/v1/docs` 200 text/html, `/api/v1/openapi.json` 200 application/json with
**23 paths**, `/api/v1/docs/scalar-standalone.js` 200 — vendored, no CDN.

Nine routes were missing when measured, not the eleven my brief claimed; Tasks
7a, 10 and 12 had registered the rest in the interim, and the remaining two of
my count were the health probes. The implementer re-measured rather than
trusting the number I gave it, which is what I asked for and what kept the
report honest.

Health probes deliberately excluded from the document: they sit at root,
outside `setGlobalPrefix`, so documenting them under a `/api/v1` server entry
would assert a path that does not exist. A document that lies about a route is
worse than one that omits it.

Ruling R61 (the most consequential finding of the task, and it is not the
viewer): **`scripts/compose-up.sh` reported a healthy stack while serving
stale images.** `podman-compose up -d --no-deps` starts a *stopped* container
but does not recreate a *running* one whose image has changed, so after a
rebuild `wait_healthy` polled the **old** container's healthcheck and found it
green.

The script did not fail — it lied, and every check performed after it was
against code nobody had just written. That is the worst failure mode available
to a verification tool, and it is the same class as Phase 2a's stale-image
silent reseed, now living in the bring-up script that exists to prevent
exactly this. Fixed with `--force-recreate` and proved: the `api` container's
age went from one hour to 22 seconds across a re-run, all services healthy, 23
routes still served. Cost: a few seconds per bring-up.

Task 13's own verification was sound — it came up from zero volumes, so every
container was fresh. But any *later* run of that script could have verified
nothing at all, silently.

### Acceptance criteria — static checks done early

AC9 (`servers` derives from `API_PREFIX`), AC10 (Dockerfile manifest test) and
AC9b (route-coverage drift test) all pass by inspection.

AC3 needs a correction to its own wording, and I would rather fix the criterion
than fudge the result. As written — "no problem-visibility comparison outside
`problem.visibility.ts`" — it is literally violated by two lines in
`problem.access.ts`: `visibility === 'org'` guarding the "an org-visible
problem needs at least one org" validation, and `patch.visibility !== undefined`
building an update set. Neither is an access-control decision. The criterion
means **no access-control comparison** outside the predicate, and by that
reading it passes: `git grep` finds no `=== 'public'`-style authorization test
anywhere outside the module. Recorded rather than quietly reinterpreted.

### Task 14 — docs. Complete at d07c966. Nine falsified claims rewritten.

Ruling R62 (the finding that generalises): **Task 13 fixed the CE claim in the
runbook's dedicated section and missed the same claim in the summary
paragraph above it.** Task 14 caught the copy. A claim stated twice gets
corrected once, because whoever fixes it searches for the symptom they hit,
not for every restatement.

Two more of the same shape: the runbook's "warts" list still said the judge
bridge key was unchecked, contradicting its own later "Judges now
authenticate" text — closed in *Phase 2a*, and the contradiction survived a
whole phase; and the `SessionOnlyGuard` paragraph enumerated two controllers,
omitting the `AdminUsersController` that R49's privilege-escalation fix had
just added to that exact list.

The rule for Phase 3, stated so it survives me: **when you invalidate a claim,
grep for it, do not fix the instance you tripped over.** Three of the nine
findings here were second copies.

Correct treatment differed per item and the implementer got the distinction
right: a *closed* item (the OpenAPI servers URL) is deleted, because leaving a
solved problem in a known-issues list makes the list untrustworthy; a
*narrowed* item (Dockerfile COPY manifests — now detected by a test, still
hand-maintained) is rewritten rather than deleted; and *historical run logs*
showing pre-fix behaviour are annotated, not edited, because they are a record
of what happened rather than a claim about what is true.

The "environment anomaly" it reported — Caddy recreated mid-session without
TLS — was me, changing `SITE_ADDRESS` to serve the stack over the tailnet. It
reported the observation without asserting it as a bug, which is the right
call for a state change it could not explain.

---

### Task 15 — acceptance. One criterion failed, and the gate recipe itself was defective.

**The clean-tree gate, run twice, and the first run is the finding.**

Run 1 used the recipe this phase had been prescribing all along —
`rm -rf packages/*/dist apps/*/dist`, then install, typecheck, lint, test. It
**failed**: `typecheck` exit 2, `lint` exit 0, `test` exit 1.

    apps/web typecheck: src/api.ts(1,28): error TS2307:
      Cannot find module '@duckoj/api-prefix' or its corresponding type declarations.
    packages/db test: Error [ERR_MODULE_NOT_FOUND]:
      Cannot find module '.../node_modules/@duckoj/db/dist/schema/guarded.js'

Ruling R63: **neither failure was a defect in this phase's code. Both were the
recipe.** `tsc -b` decides up-to-dateness from `tsconfig.tsbuildinfo`, and
deleting `dist/` does not delete that file. Every one of the twelve projects
printed `Done` and emitted nothing; `ls -d packages/*/dist` afterwards showed
no `dist` anywhere. `apps/web`'s typecheck is `tsc --noEmit` and never builds
its dependencies, so it was the first to notice; `packages/db`'s
`seed-script.spec.ts` spawns a real `tsx scripts/seed-problem.ts` that resolves
through `node_modules/@duckoj/db/dist/`, so it was the second.

This is the same class as W1 and it is strictly worse. W1's stale `dist/` at
least contains *something*, and the danger is that it is old. Here the build
tool reports success having produced nothing at all — the verification step
that exists to guarantee a clean build **lies about having run one**. That is
the identical failure shape as R61 (`compose-up.sh` reporting a healthy stack
while serving stale images) and Phase 2a's stale-image silent reseed: a tool
whose entire job is to catch staleness, itself defeated by staleness, and
reporting green.

The recipe for Phase 3, and it must be both halves:

    rm -rf packages/*/dist apps/*/dist \
           packages/*/tsconfig.tsbuildinfo apps/*/tsconfig.tsbuildinfo

Run 2, with that recipe: **typecheck 0, lint 0, test 0. 408 tests passing
across 12 projects**, all `dist/` directories confirmed re-emitted afterwards.
`apps/api` 223, `apps/judged` 59, `apps/web` 34, `packages/package-format` 34,
`packages/db` 20, `packages/judge-protocol` 18, `packages/contracts` 7,
`apps/judge-agent` 5, `packages/observability` 4, `packages/sdk` 2,
`packages/api-prefix` 1, `packages/realtime` 1.

**Flake watch: no sighting.** `apps/judged` 59/59 under full-workspace
parallelism. The count stands at three across two phases, still unreproduced,
still unfixed on purpose.

**Acceptance: 11 of 12 met, 1 not met.**

AC1 and AC2 were re-verified live rather than taken from Task 13's report:
`scripts/e2e-problem.ts` against the running stack, all 14 steps ok, exit 0 —
create → upload over HTTP → attach → publish → make public → `AC 10/10`, then
uncompilable source → `CE` from a real judge. The stack's images were built
before HEAD, but `git diff --name-only` across that span shows the only
non-documentation change is `scripts/compose-up.sh`, a host-side script baked
into no image, so the running application code is identical to HEAD. (The run
needed `E2E_BASE_URL=http://localhost:8080`: TLS on 8443 is gone because
`SITE_ADDRESS` was changed to `:80` to serve the stack over the tailnet — the
environment change R62's implementer observed and correctly declined to call a
bug.)

AC3 passes **under the corrected reading recorded earlier in this ledger** — no
*access-control* comparison outside the predicate. The two surviving
`visibility` comparisons in `problem.access.ts` are `visibility === 'org'`
guarding the org-required validation (line 239) and `patch.visibility !==
undefined` building an update set (line 334); neither decides who may see
anything. The remaining hits are `org.visibility.ts`, a genuinely separate
predicate with its own module, as Task 8's Step 5 grep already established.

AC9b's number has aged: the criterion says "18 of 18", and the document now
carries **23 paths / 27 operations**. The count is not the guarantee — the
drift test asserts set equality in *both* directions, and removing the
`PATCH /admin/users/{username}` registration made it name that exact route.
AC10 likewise verified by mutation: deleting line 11 of `apps/api/Dockerfile`
produced `missing COPY <dir>/package.json for: [ 'packages/package-format' ]`.
Both mutations reverted, `git status` clean.

Ruling R64: **AC4 is NOT met, and it is not being fixed here.** The criterion
requires that "an org member can both *see* and *submit to* an org-visible
problem — **the same actor, both paths, in one test**." What exists is two
tests, in two files, with two separately-built fixtures:
`problem-reads.spec.ts:110` ("shows an org problem to a member of a shared
org") and `submission-problem-visibility.spec.ts:63` ("accepts a submission
from a member of an org the problem is shared with"). I swept every `it` block
in `apps/api/test` three ways for one containing both a problem read and a
submission create; none exists.

The intent is *substantially* covered — R43's shared predicate means both paths
now call `canViewProblem`, so divergence is structurally prevented rather than
merely tested — but that cannot upgrade this to a pass, because **two
separately-consistent tests is precisely the shape AC4 was written to forbid**.
It is the same shape as the bug Task 8 found and as D1. Recording it as met on
a structural argument would be the exact move this phase spent fifteen tasks
refusing to make.

Not fixed under acceptance for two reasons. Task 15 is acceptance, not
implementation; and a test written now would itself owe AC12's
demonstrated-failure evidence, which acceptance is not the place to produce.

Note *why* it was missed, because the cause is already named in this ledger:
**no task's brief carried AC4's single-test requirement.** Task 8's brief asked
for the submission path and Task 3's for the read path, and each was satisfied
in its own file. That is R55 exactly — the brief was narrower than the binding
document, and a reviewer can only enforce what it is handed. The remedy R55
already states applies unchanged.

AC12 is assessed from the task reports rather than re-verified, as instructed —
re-running roughly 400 mutations at acceptance is not a good use of the
evidence. **Every task that added a test recorded pre-fix failure output.**
Tasks 1, 2, 3, 4, 5, 6, 7a, 7b, 8, 9, 10, 11, 12 and 13 all carry verbatim
failure text in their reports, and this ledger quotes it for 5, 6, 8, 10, 11
and 12. Task 14 is documentation and added no tests, so it owes none. No task
that added a test failed to document a demonstrated failure. The caveat worth
stating plainly: this establishes that each task demonstrated failures, not
that *every individual test* in the phase was individually mutated — several
reports demonstrate a representative mutation per behaviour rather than one
per `it` block, and R44 and R47 are the cases where an implementer went
looking for the tests that a single mutation would *not* have discriminated.

Task 15: complete. **408/408, all gates green from a genuinely clean tree.
11 of 12 acceptance criteria met, 1 not met (AC4), 0 unverifiable.**
`task-15-report.md` (gitignored, not committed) carries the full verbatim gate,
mutation and e2e output.

**PHASE 2B COMPLETE — 15 tasks, 408 tests.** One acceptance criterion failed
and is reported as failed. Eleven items are carried forward as deferred work in
the table at the top of this file, none of them patched under acceptance
pressure. Awaiting the human's integration decision, same as Phases 1 and 2a:
merge, PR, or leave the branch.
