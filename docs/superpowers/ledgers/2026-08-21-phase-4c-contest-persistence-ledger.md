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
