# Contest format goldens

Frozen scoreboards produced by the **original** DMOJ/VNOJ code at
`online-judge` commit `87383c7b8e98c52d0846ac6f5544a481dcef1a2c`, for the four
contest formats DuckOJ keeps: `default`, `icpc`, `ioi16`, `legacy_ioi`.

These are **test fixtures, not product code**. Phase 4b implements the formats
against them; if an implementation disagrees with a golden, one of the two is
wrong and both are inspectable.

```
<format>/<scenario>/
  contest.json     the inputs — contest window, problems, participants,
                   submissions with per-test-case points, and the perturbation
                   used to prove the golden is sensitive
  scoreboard.json  the frozen output — per-participant score, cumtime,
                   tiebreaker, format_data, and the ranked order
  PROVENANCE.md    the online-judge commit, the harness image, the command, the
                   date, and this scenario's reproducibility and sensitivity
                   results
```

`legacy_ioi/` holds the format registered under the name **`ioi`**; the
directory is named after the class (`LegacyIOIContestFormat`) to avoid confusion
with `ioi16`.

## Regenerating

```sh
python3 fixtures/contest-goldens/_generator/scenarios.py fixtures/contest-goldens  # inputs
fixtures/contest-goldens/_generator/run.sh                                         # goldens
fixtures/contest-goldens/_generator/run.sh --verify                                # §6 checks
```

Requires podman and a read-only `online-judge` checkout (`OJ_DIR`, default
`~/Projects/online-judge`). Nothing is installed on the host and the checkout is
never written to. See `_generator/` for the details, including why the harness
runs on MariaDB rather than SQLite.

## What the ranking actually is

Every format writes four fields on `ContestParticipation` — `score`, `cumtime`,
`tiebreaker`, `format_data` — and the *view*, not the format, does the ordering
(`judge/views/contests.py:1075`):

```
order_by('is_disqualified', '-score', 'cumtime', 'tiebreaker', '-submission_count')
```

Two consequences a reimplementation will miss:

- **`cumtime` is ascending and `tiebreaker` is ascending**, so both are
  "smaller is better" regardless of what a format puts in them.
- **Among rows equal on all four, more submissions ranks higher** (`-submission_count`).
  Nothing else breaks that tie, so a board where two rows match on score,
  cumtime, tiebreaker *and* submission count has a database-defined order. No
  golden here contains such a pair — that is checked, not assumed.

The displayed rank comes from `judge/utils/ranker.py` keyed on
`(score, cumtime, tiebreaker)` only — **not** on submission count. So two rows
can be printed in a definite order and still share a rank, and after a group of
*k* tied rows the next rank jumps by *k* (see `icpc/03-deadline-boundary`:
1, 1, 1, 4).

## The four formats, in prose

### `default` — 116 lines, pure ORM

**Score**: for each problem, `Max(points)` over the participant's contest
submissions, summed, rounded to `contest.points_precision`.

**cumtime**: for each problem *with a non-zero score*, add
`Max(submission.date) - participation.start`, **in seconds**.

**tiebreaker**: hard-coded `0`. It never separates anyone.

**The surprise.** `Max(points)` and `Max(date)` are **independent aggregates**
over the same rows. The time recorded for a problem is the time of the *last*
submission on it, not the time of the *best* one. A zero-point resubmission
after an accept therefore raises your cumtime and can cost you the contest.
`default/06-zero-after-accept` and its twin `legacy_ioi/06-zero-after-accept`
run identical inputs through both formats and the winner changes.

**first solve**: the live (`virtual == 0`) participation with the smallest
recorded time among those scoring the problem's full points. Virtual
participations are excluded from first-solve but **counted** in `total_ac`.

### `icpc` — 285 lines, one raw-SQL block

Config: `{"penalty": 20}` minutes, default 20, must be `>= 0`.

**Score**: same as `default` — `Max(points)` per problem. (In practice ICPC
problems are non-partial, so that is 0 or full.)

**cumtime**: `sum(solve_minutes) + penalty`, where `solve_minutes` is
`int(seconds // 60)` — **floored to whole minutes** — for each solved problem,
and `penalty = sum((tries - 1) * penalty_minutes)` over solved problems only.

**tiebreaker**: `last` = the **largest** solve time in minutes, not a sum. It
separates two boards with the same cumtime (`icpc/02-score-tie`).

**Penalty, precisely.** `tries` counts every contest submission on that problem
dated **at or before the first submission holding the maximum score**, including
that submission itself; the penalty is `(tries - 1) * 20`.

- Submissions **after** the accept are excluded by the `date__lte` filter — no
  penalty, and no effect on the recorded time, which is `MIN(date)` over the
  submissions holding the maximum points (`icpc/07-no-penalty-after-accept`).
- **Compile errors, internal errors, and submissions with a NULL result are
  free** — `exclude(result__in=['IE', 'CE'])` and `exclude(result__isnull=True)`.
  Most reimplementations charge for compile errors (`icpc/06-penalty-before-accept`).
- Attempts on a problem you **never solve** add **zero** penalty: the penalty
  accumulator only runs inside `if points:` (`icpc/01-nobody-solves`).

**Contradicting the common belief.** Because solve time is floored to minutes, a
submission **one second after the deadline scores an identical cumtime and
tiebreaker** to one exactly at the deadline; only `format_data.time`, which
keeps seconds, differs (`icpc/03-deadline-boundary`). And nothing in
`update_participation` filters by the contest end at all — a post-deadline
submission counts if a `ContestSubmission` row exists. Gating happens when the
submission is created, not when the scoreboard is computed.

**A misreading the goldens corrected.** For a problem scoring zero, the code
reassigns its local `time` to `Max(date)` — but `dt_second`, the value that
reaches `format_data`, was already computed from the raw SQL's `MIN(date)`. The
reassignment only feeds the frozen-scoreboard flag. So an unsolved problem's
recorded time is the **first** attempt, not the last (`icpc/01-nobody-solves`,
null probe).

**Frozen fields.** `frozen_score`, `frozen_cumtime`, `frozen_tiebreaker` are
maintained in the same pass. Every fixture here sets `frozen_last_minutes = 0`,
which makes `Contest.is_frozen` false and the frozen fields mirror the live
ones. Freezing is deliberately out of scope: `is_frozen` compares
`timezone.now()` to the freeze instant, so any golden covering it would depend
on the wall clock. Phase 4b should treat freezing as unspecified by these
goldens.

### `legacy_ioi` (registered as `ioi`) — 162 lines, pure ORM

Config: `{"cumtime": false, "last_score_altering": false}`.

**Score**: `Max(points)` per problem — the **best submission**, summed.

**Time per problem**: `Min(date)` among the submissions whose points equal that
best score — the *earliest* time you reached your best. A later worthless
submission is invisible, unlike `default`. For a problem scoring **zero** the
recorded time is forced to `0`, not the submission time.

**cumtime / tiebreaker**:

- `tiebreaker` = the largest such time, but only accumulated when
  `last_score_altering` is on; otherwise `0`.
- `cumtime` = the sum of those times if `cumtime` is on, otherwise it is set to
  the tiebreaker value.
- With the **default config both are off**, `cumtime` and `tiebreaker` are both
  `0`, and score ties are never broken.

**The surprise.** `get_first_solves_and_total_ac` guards the first-solve update
on `show_time = cumtime or last_score_altering`. Under the default config
**`first_solve` is `null` for every problem**, even for participants with full
marks. `total_ac` is still counted (`legacy_ioi/12-untimed-config`). Note also
that `format_data` still records the time under that config — only the aggregate
fields are pinned to zero.

### `ioi16` — 52 lines, subclasses `legacy_ioi`

Config: `{"cumtime": false}` — and `update_participation` **ignores it**.
`cumtime` and `tiebreaker` are unconditionally `0`, `format_data[*].time` is
unconditionally `0`. An ioi16 board is score-only; ties fall straight through to
`-submission_count`. Timing an ioi16 submission differently cannot change the
scoreboard at all (`ioi16/09`, null probe).

**Score — the thing that actually matters.** Per problem, the best score **per
batch across all submissions**, summed, then scaled:

1. For each contest submission, read `SubmissionTestCase(points, batch)`
   directly. `batch = NULL` folds into batch `0`.
2. Within a submission, a batch scores **`min(points)`** over its cases — every
   case in a batch carries the batch's point value, so one failed case zeroes
   the batch. (Unbatched cases all land in batch `0` and therefore compete with
   each other by `min` as a single implicit batch.)
3. Across submissions, a batch scores **`max`** of its per-submission values.
   A batch **absent** from a submission contributes nothing — it does not drag
   the running maximum to zero, so "absent" and "scored zero" behave
   differently (`ioi16/11-missing-batch-vs-zero-batch`).
4. Multiply every batch by `ContestProblem.points_scaling_factor` =
   `ContestProblem.points / sum of the dataset's batch point values`, read from
   `ProblemTestCase` rows — **not** from the submission. Then sum, then round
   the **total** to `points_precision`. `format_data` keeps the unrounded
   per-problem value.

`ContestSubmission.points` is **not used at all**. This is why
`ioi16/09-partial-subtasks-multiple-submissions` and
`legacy_ioi/09-best-submission-not-best-batch` run identical inputs and produce
100 versus 60: one participant solved batch 1 in one submission and batch 2 in
another. A reimplementation that takes the maximum *submission* score passes
every other scenario in this directory and fails only that pair.

A problem with no `ProblemTestCase` rows makes `points_scaling_factor` divide by
zero, so every ioi16 problem needs a dataset.

**first solve** is inherited from `legacy_ioi` and, because `show_time` is false
under ioi16's defaults, is `null` for every problem
(`ioi16/05-virtual-participation`).

## Scenario index

| Scenario | Covered by | Spec §4 |
|---|---|---|
| Nobody solves anything | `default`, `icpc`, `legacy_ioi` | 1 |
| A tie on score | `default`, `icpc`, `legacy_ioi` | 2 |
| Submission at and after the deadline | `default`, `icpc` | 3 |
| A participant who joins late | `default`, `icpc` | 4 |
| A virtual participation among live ones | `default`, `icpc`, `ioi16` | 5 |
| Wrong answers before an accept | `icpc` | 6 |
| Wrong answers after an accept | `icpc` | 7 |
| A problem solved by nobody | `icpc` (also `default/02`) | 8 |
| Partial subtasks across submissions | `ioi16` **and** `legacy_ioi` (same inputs) | 9 |
| `points_scaling_factor` other than 1 | `ioi16` | 10 |
| A missing batch vs a batch scoring zero | `ioi16` | 11 |
| A zero-point submission after an accept | `default` **and** `legacy_ioi` (same inputs) | — |
| `legacy_ioi` with its default (untimed) config | `legacy_ioi` | — |

## Not covered

- **Frozen scoreboards** (`frozen_last_minutes > 0`) — wall-clock dependent, see above.
- **Disqualification** — `recompute_results()` overwrites score with `-9999`
  outside the format code; it belongs to the participation, not the format.
- **Spectators** (`virtual == -1`) — excluded from the ranking queryset entirely.
- The other seven formats (`atcoder`, `ecoo`, `final_submission`, `ultimate`,
  `vnoj`, …), dropped by the foundation spec.
