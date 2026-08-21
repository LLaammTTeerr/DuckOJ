# Provenance — `legacy_ioi/09-best-submission-not-best-batch`

Partial subtasks spread across two submissions. Identical inputs to ioi16/09-partial-subtasks-multiple-submissions.

## What this scenario pins down

- legacy_ioi takes the best SUBMISSION: alice solves batch 1 in one submission and batch 2 in another and scores 60, not 100.
- ioi16 scores the same inputs 100. This pair of goldens is the whole difference between the two formats.

## How it was produced

| | |
|---|---|
| Source of truth | `online-judge` @ `87383c7b8e98c52d0846ac6f5544a481dcef1a2c` (`feat: add virtual judge problem picker`) |
| Harness image | `3ccb797d66acdafcf4c1996f0a2bc665fc2aea922d0c42558948aa489a4a7ec8` |
| Database | MariaDB 10.11 (see below) |
| Command | `fixtures/contest-goldens/_generator/run.sh --only legacy_ioi/09-best-submission-not-best-batch` |
| Verified with | `fixtures/contest-goldens/_generator/run.sh --verify --only legacy_ioi/09-best-submission-not-best-batch` |
| Date | 2026-08-21 |

The scoreboard is produced by calling the original
`judge/contest_format/legacy_ioi.py` `update_participation()` and
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

Perturbation: alice's better submission moves before her first one, changing the recorded time for her best score.

3 field(s) changed:

| field | golden | perturbed |
|---|---|---|
| `ranking[1].cumtime` | `1200` | `300` |
| `ranking[1].format_data.a.time` | `1200.0` | `300.0` |
| `ranking[1].tiebreaker` | `1200.0` | `300.0` |
