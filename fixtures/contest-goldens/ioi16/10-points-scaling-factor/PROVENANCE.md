# Provenance — `ioi16/10-points-scaling-factor`

Two problems whose ContestProblem.points differ from their dataset totals, one scaling to an integer factor and one to a repeating decimal.

## What this scenario pins down

- points_scaling_factor = ContestProblem.points / sum of the dataset batch points, computed from ProblemTestCase rows — NOT from the submission. Every batch score is multiplied by it before summing.
- Problem b scales 100/3, so the per-batch products are non-terminating and the total is rounded by contest.points_precision. Getting the rounding point wrong (per batch instead of per total) shows up here.
- If a problem has no dataset rows the factor divides by zero; every ioi16 problem must have ProblemTestCase rows.

## How it was produced

| | |
|---|---|
| Source of truth | `online-judge` @ `87383c7b8e98c52d0846ac6f5544a481dcef1a2c` (`feat: add virtual judge problem picker`) |
| Harness image | `3ccb797d66acdafcf4c1996f0a2bc665fc2aea922d0c42558948aa489a4a7ec8` |
| Database | MariaDB 10.11 (see below) |
| Command | `fixtures/contest-goldens/_generator/run.sh --only ioi16/10-points-scaling-factor` |
| Verified with | `fixtures/contest-goldens/_generator/run.sh --verify --only ioi16/10-points-scaling-factor` |
| Date | 2026-08-21 |

The scoreboard is produced by calling the original
`judge/contest_format/ioi.py` `update_participation()` and
`get_first_solves_and_total_ac()` against a database built from `contest.json`,
then reproducing the ranking query and `judge.utils.ranker` from
`judge/views/contests.py`. Nothing in the `online-judge` checkout is modified.

MariaDB rather than SQLite: four `judge` migrations (0085, 0089, 0189, 0198)
contain MySQL-only `UPDATE ... INNER JOIN`, so `migrate` cannot even run on
SQLite, and the ICPC format's raw SQL is MySQL-flavoured. The resolved Python
dependencies are pinned in `_generator/requirements.lock.txt`.

## Reproducibility (§6.1)

Generated twice and compared with the committed `scoreboard.json`: all three byte-identical.

Normalised to get there: `format_data` and `first_solve` are re-keyed from database primary keys to the fixture problem codes and participant names; floats are rounded to 9 places; JSON is emitted with `sort_keys`, two-space indent and a trailing newline; `frozen_last_minutes` is 0 in every fixture so nothing depends on the wall clock.

## Sensitivity (§6.2)

Perturbation: alice's third batch on b flips from 0 to 1, adding one scaled batch (100/3) to her score.

3 field(s) changed:

| field | golden | perturbed |
|---|---|---|
| `problems[1].total_ac` | `1` | `2` |
| `ranking[0].format_data.b.points` | `66.666666667` | `100.0` |
| `ranking[0].score` | `266.667` | `300.0` |
