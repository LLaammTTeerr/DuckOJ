# Provenance — `ioi16/09-partial-subtasks-multiple-submissions`

THE scenario. Partial subtasks spread across two submissions; identical inputs to legacy_ioi/09-best-submission-not-best-batch.

## What this scenario pins down

- ioi16 scores the best result PER BATCH across all submissions, summed. alice takes batch 1 from her first submission and batch 2 from her second and scores 100, where legacy_ioi gives her 60.
- Within one submission a batch scores min(points) over its cases; across submissions a batch scores max. ContestSubmission.points is ignored entirely — get_best_subtask_point reads SubmissionTestCase rows directly.
- ioi16 pins format_data time to 0 and cumtime and tiebreaker to 0 for everyone, so score ties are never broken.

## How it was produced

| | |
|---|---|
| Source of truth | `online-judge` @ `87383c7b8e98c52d0846ac6f5544a481dcef1a2c` (`feat: add virtual judge problem picker`) |
| Harness image | `3ccb797d66acdafcf4c1996f0a2bc665fc2aea922d0c42558948aa489a4a7ec8` |
| Database | MariaDB 10.11 (see below) |
| Command | `fixtures/contest-goldens/_generator/run.sh --only ioi16/09-partial-subtasks-multiple-submissions` |
| Verified with | `fixtures/contest-goldens/_generator/run.sh --verify --only ioi16/09-partial-subtasks-multiple-submissions` |
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

Perturbation: alice's first submission loses batch 1. No other submission of hers scores that batch, so her total drops from 100 to 60 — exactly the score legacy_ioi gives her from the unperturbed input.

8 field(s) changed:

| field | golden | perturbed |
|---|---|---|
| `problems[0].total_ac` | `2` | `1` |
| `ranking[0].participant` | `alice` | `bob` |
| `ranking[0].submission_count` | `2` | `1` |
| `ranking[1].format_data.a.points` | `100.0` | `60.0` |
| `ranking[1].participant` | `bob` | `alice` |
| `ranking[1].rank` | `1` | `2` |
| `ranking[1].score` | `100.0` | `60.0` |
| `ranking[1].submission_count` | `1` | `2` |

### Null probe (a change that provably does nothing)

the second submission moves 15 minutes earlier, before the first. The scoreboard is byte-identical, because ioi16 records no time at all — format_data.time, cumtime and the tiebreaker are hard-coded to 0 — so submission order and timing cannot affect an ioi16 scoreboard.
