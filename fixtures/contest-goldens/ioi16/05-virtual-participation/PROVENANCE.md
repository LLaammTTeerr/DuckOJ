# Provenance — `ioi16/05-virtual-participation`

A virtual participation among live ones under ioi16.

## What this scenario pins down

- ioi16 inherits legacy_ioi's first-solve code with config_defaults that contain no `last_score_altering` key and cumtime False, so `show_time` is false and first_solve is NULL for every problem — for live and virtual participants alike. total_ac still counts everyone including virtuals.
- Because cumtime and tiebreaker are always 0, the entire board ties and the displayed order is decided by -submission_count.

## How it was produced

| | |
|---|---|
| Source of truth | `online-judge` @ `87383c7b8e98c52d0846ac6f5544a481dcef1a2c` (`feat: add virtual judge problem picker`) |
| Harness image | `3ccb797d66acdafcf4c1996f0a2bc665fc2aea922d0c42558948aa489a4a7ec8` |
| Database | MariaDB 10.11 (see below) |
| Command | `fixtures/contest-goldens/_generator/run.sh --only ioi16/05-virtual-participation` |
| Verified with | `fixtures/contest-goldens/_generator/run.sh --verify --only ioi16/05-virtual-participation` |
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

Perturbation: bob's second submission gains batch 2, raising his best-per-batch total from 40 to 100 and tying him with the others.

12 field(s) changed:

| field | golden | perturbed |
|---|---|---|
| `problems[0].total_ac` | `2` | `3` |
| `ranking[0].participant` | `mallory` | `bob` |
| `ranking[0].submission_count` | `2` | `3` |
| `ranking[0].virtual` | `1` | `0` |
| `ranking[1].participant` | `alice` | `mallory` |
| `ranking[1].submission_count` | `1` | `2` |
| `ranking[1].virtual` | `0` | `1` |
| `ranking[2].format_data.a.points` | `40.0` | `100.0` |
| `ranking[2].participant` | `bob` | `alice` |
| `ranking[2].rank` | `3` | `1` |
| `ranking[2].score` | `40.0` | `100.0` |
| `ranking[2].submission_count` | `3` | `1` |
