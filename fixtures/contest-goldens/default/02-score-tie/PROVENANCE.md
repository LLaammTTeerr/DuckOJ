# Provenance — `default/02-score-tie`

Two participants tie on score and cumtime; a third ties on score only.

## What this scenario pins down

- default breaks a score tie by cumtime = the sum, over problems with a non-zero score, of the last submission time on that problem.
- tiebreaker is hard-coded to 0, so it never separates anyone.
- A perfect tie falls through to -submission_count.

## How it was produced

| | |
|---|---|
| Source of truth | `online-judge` @ `87383c7b8e98c52d0846ac6f5544a481dcef1a2c` (`feat: add virtual judge problem picker`) |
| Harness image | `3ccb797d66acdafcf4c1996f0a2bc665fc2aea922d0c42558948aa489a4a7ec8` |
| Database | MariaDB 10.11 (see below) |
| Command | `fixtures/contest-goldens/_generator/run.sh --only default/02-score-tie` |
| Verified with | `fixtures/contest-goldens/_generator/run.sh --verify --only default/02-score-tie` |
| Date | 2026-08-21 |

The scoreboard is produced by calling the original
`judge/contest_format/default.py` `update_participation()` and
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

Perturbation: bob's accept on b moves ten minutes later, breaking his tie with carol.

15 field(s) changed:

| field | golden | perturbed |
|---|---|---|
| `problems[1].first_solve` | `bob` | `carol` |
| `ranking[1].format_data.a.time` | `1500.0` | `1200.0` |
| `ranking[1].format_data.b.time` | `1200.0` | `1500.0` |
| `ranking[1].format_data.c.points` | `0.0` | `<absent>` |
| `ranking[1].format_data.c.time` | `3000.0` | `<absent>` |
| `ranking[1].participant` | `bob` | `carol` |
| `ranking[1].submission_count` | `3` | `2` |
| `ranking[2].cumtime` | `2700` | `3300` |
| `ranking[2].format_data.a.time` | `1200.0` | `1500.0` |
| `ranking[2].format_data.b.time` | `1500.0` | `1800.0` |
| `ranking[2].format_data.c.points` | `<absent>` | `0.0` |
| `ranking[2].format_data.c.time` | `<absent>` | `3000.0` |
| `ranking[2].participant` | `carol` | `bob` |
| `ranking[2].rank` | `2` | `3` |
| `ranking[2].submission_count` | `2` | `3` |
