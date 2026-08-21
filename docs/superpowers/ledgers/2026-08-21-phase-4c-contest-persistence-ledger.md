# Phase 4c report — contest persistence and scoreboards

**Status: complete.** `corepack pnpm -r typecheck`, `-r lint`, `-r test` all green:
**584 tests**, 42 spec files in `apps/api` alone. Committed, not pushed.

**23 of 23 goldens replay correctly through Postgres.** They passed on the first
full run of the replay, and every perturbation below reddened exactly the
fixtures that pin the rule it broke.

---

## R1 — the acceptance criterion, and the proof it can fail

`apps/api/test/contest-golden-replay.spec.ts` enumerates
`fixtures/contest-goldens/` (never a hard-coded list), seeds each golden's
`contest.json` into a real Postgres, computes the scoreboard through
`ContestAccessService.getScoreboard(null, key)` — anonymous, against a public
contest, so the visibility predicate is *inside* the loop — and deep-equals
`ranking`, `problems` and `label_by_problem` against that golden's
`scoreboard.json`, normalised with `pyRound(value, 9)` imported from
`@duckoj/contest-formats` rather than re-derived (§7).

Five perturbations of the mapping, each reverted:

    virtual -> 0 (drop the flag)                  3 failed: default/05, icpc/05, ioi16/05
    points <- problem's own dataset total         1 failed: ioi16/10-points-scaling-factor
    dataset synthesis removed                     5 failed: all 4 ioi16 + legacy_ioi/09
    contest_problems.partial ignored (always true) 0 failed  <- see R5
    latest-attempt filter removed                 0 goldens; 2 regrade tests failed

The second line is §7's stated trap, with §7's stated signature: `ioi16/10` is
the only fixture where `contest_problems.points` (200) differs from the
problem's own total (100), and it is the only one that reddens.

The third is per **problem**, not per format — `legacy_ioi/09` carries a dataset
while its three siblings do not, so a format-conditional synthesis would have
been wrong in a way no `ioi16` fixture could show.

The last line is the point of `contest-regrade-attempt.spec.ts`: no golden can
see the attempt filter, so it gets its own test.

Write-time refusals, shown failing against unfixed code (both checks removed):

    refuses a non-zero frozen_last_minutes ...    expected 201 to be 400
    refuses an unknown format ...                 expected 201 to be 400

And the shared visibility predicate short-circuited to `return true`:

    contests + contest-visibility + problem-visibility + leakage   21 failed

— one predicate, both entities, which is exactly the property design §5 asks for.

## R2 — visibility: the existing shape was taken, and made literal

The brief said not to write a second predicate. Rather than write a
*look-alike*, the decision moved out of `problem.visibility.ts` into
`apps/api/src/authz/visibility.ts` as `canViewVisible` + `visibleRowsWhere`, and
**both** problems and contests call it. `canViewProblem` is now four lines that
translate problem membership into it; `canViewContest` is four lines that
translate contest membership (`created_by`) into it. `problem-visibility.spec.ts`
staying green is the regression proof, and `contest-visibility.spec.ts` asserts
the two answer identically on every cell.

The only per-entity code left is the two loaders and the two subqueries, which
name tables that genuinely differ.

## R3 — the seventeenth defect: §3's rationale for `contest_submissions.points`

The column is implemented as specified, but the reason given for it is wrong.
§3 says storing the contest-scaled score "pins what was scored", where deriving
it at read time "means the scoreboard depends on a scaling factor that may since
have changed".

The scoreboard does not read the column. 4b's `lower()` recomputes
`ContestSubmission.points` from `submission_cases` on **every** read, and
`ioi16` ignores it entirely in favour of per-batch aggregation. So the
scoreboard *does* depend on the current `contest_problems.points`, exactly as
the spec wanted to avoid, and the stored column pins nothing today.

Kept anyway — it is a real record for listing screens and for a future writer —
and to stop it drifting from what the formats recompute, `contestSubmissionPoints`
is now exported from `@duckoj/contest-formats` and is what writes it. Note it
currently has **no production writer at all**: routing live submissions into a
contest is out of scope, so only the replay seeder fills it.

## R4 — `contest_orgs` was missing from §3

§5 requires `org` visibility to mirror problems'. §3's table has no sharing
table, without which "shared with an organization" is uninterpretable. Added
`contest_orgs`, mirroring `problem_orgs`, plus `orgSlugs` on `POST /contests`
resolved through the same `loadOrgMembership` check problems use (an unknown
slug and one the actor may not share with are deliberately indistinguishable).

## R5 — two rules no golden can pin, reported rather than papered over

- **`contest_problems.partial` is invisible to the corpus.** Perturbing it to a
  constant `true` reddens nothing. All eight fixtures carrying `partial: false`
  also carry `problem_partial: false`, and none of them has a submission scoring
  strictly between zero and full — so the flag never changes an outcome. Same
  shape as 4b's R3: left as a stated gap for a generator-produced scenario.
- **`problem_partial` has no DuckOJ counterpart.** DMOJ's `Problem.partial` is a
  per-problem switch this schema does not have, and §3's table does not add one.
  The mapping passes a constant `true`, leaving `contest_problems.partial` as the
  only gate — which is what §3 describes, and which no golden can distinguish
  from the faithful form.

## R6 — smaller decisions worth the next reader's time

- **The dataset.** `points_scaling_factor` divides by the sum of the dataset's
  batch points. DuckOJ has no `ProblemTestCase` table, but `renderInitYml` gives
  a batch `points = sum of its member tests' points`, so that sum *is*
  `problem_revisions.total_points`. The mapping synthesises one loose case
  carrying that total — `pointsScalingFactor` only ever sums it — and takes it
  from the **published** revision, so a problem with none has no dataset and a
  null factor, which is how the goldens' datasetless problems are reproduced.
- **`ioi16` with no published revision** would divide by zero, so it is a named
  409 (`contest_problem_missing_dataset`) rather than a 500 from inside 4b.
- **One user, two participations** (live + virtual) is representable in the
  schema but not in 4b's input shape, which keys participants by name. The
  mapping refuses it loudly (409 `contest_duplicate_participant`) rather than
  silently merging submissions into the wrong row. Unreachable today — joining
  does not exist — and squarely the job of the phase that adds it.
- **`contest_problems.label` is not what a scoreboard shows.** The format owns
  scoreboard labels (`icpc`: A, B, C; the others: 1, 2, 3) and the goldens pin
  the format's answer. The column is the setter's display label, documented as
  such where it is declared.
- **The scoreboard is served in snake_case**, mirroring the goldens field for
  field. A camelCase DTO would be a translation layer between the goldens and
  the code they pin — wrong in one direction and invisible to a test that only
  goes the other way. The contract's hand-written zod (contracts must not import
  workspace packages) is parsed against a real scoreboard in `contests.spec.ts`,
  which is what stops the two drifting.
- **Postgres truncates** `contest_submissions_participation_id_contest_participations_id_fk`
  to 63 characters and says so as a NOTICE. Cosmetic: drizzle-kit diffs against
  its own snapshot, not the live catalog.

## The migration

`packages/db/migrations/0008_contests.sql`, read by hand before being trusted:
one new enum, five tables, `"order"` correctly quoted, `lower("key")` as an
expression index, and all four uniques §3 asks for
(`contests(lower(key))`, `contest_problems(contest_id, problem_id)`,
`contest_participations(contest_id, user_id, virtual)`,
`contest_submissions(submission_id)`). No enum was altered, so the shape
drizzle-kit has got wrong here before was never in play.

## Scopes

`contests:read` and `contests:write` typed in by hand in **two** files —
`packages/contracts/src/scopes.ts` and the literal pin in
`packages/contracts/test/scopes.spec.ts` — with matching rows added to
`apps/api/test/scope-matrix.spec.ts`. Nothing was regenerated from a snapshot.
`openapi.json` and `packages/sdk/src/generated.ts` **were** regenerated and are
committed.

---

## Coordinator rulings

**C1 — the replay works, and its perturbations are precise.** 23/23 goldens
reproduce through Postgres. Four mapping perturbations each reddened exactly
the goldens that pin that rule:

    virtual -> 0                        3 failed  (default/05, icpc/05, ioi16/05)
    points from the problem's own total 1 failed  (ioi16/10-points-scaling-factor)
    dataset synthesis removed           5 failed  (all ioi16 + legacy_ioi/09)
    contest_problems.partial ignored    0 failed  <- reported, not hidden

The third line corrected my mental model: the dataset rule is per **problem**,
not per format — `legacy_ioi/09` carries one — so a format-conditional
synthesis would have been wrong invisibly.

**C2 — a perturbation that found nothing was reported as a gap.** Ignoring
`contest_problems.partial` reddens no golden. The honest reading is that the
corpus does not cover it, and it was reported rather than left as an implied
pass. Same shape as 4b-R3, and the same correct instinct: a perturbation with
no effect is information about the *corpus*, not a licence.

**C3 — the implementer generalised my instruction, correctly.** I wrote "reuse
the existing visibility shape; if it does not fit, say why". It went further and
made the decision literal: `apps/api/src/authz/visibility.ts` now holds
`canViewVisible` and `visibleRowsWhere`, consumed by both
`problem.visibility.ts` and `contest.visibility.ts`. Verified — those are the
only two importers.

"Same shape" is a convention that drifts. One function cannot. Short-circuiting
it to `true` reddens 21 tests across both entities, which is the proof the
sharing is real rather than cosmetic.

**C4 — spec defect #17, mine, and it is a contradiction rather than an
omission.** §3 justified denormalising `contest_submissions.points` as
"pinning what was scored". 4b's own implementation contradicts that: it
recomputes points from `submission_cases` on every read, and `ioi16` ignores
the stored value entirely. So the column's stated rationale was false when I
wrote it — I justified a schema decision against behaviour I had already
specified elsewhere and not re-read.

Column kept (submission routing will need a writer), but the rationale is
withdrawn. Recorded because it is a new failure shape for me: not describing a
file I had not opened, but contradicting a file I had *written*.

**C5 — spec defect #18: §3 omitted `contest_orgs`.** Without it §5's `org`
visibility has nothing to resolve against, so the spec was internally
unsatisfiable. Added mirroring `problem_orgs`.

**C6 — the implementer caught its own vacuous test.** Its first regrade test
asserted on an *identical* second attempt, which is ratio-invariant and
therefore passed against a mapping with no attempt filter at all. It found this
by perturbing the filter away, saw nothing redden, and rewrote the test to
halve the second attempt so all three readings separate.

That is the fifth self-falsification in this project and the most subtle: the
test was not merely weak, it was *structurally incapable* of failing, and only
a perturbation revealed it.
