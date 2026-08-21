# Provenance — `icpc/02-score-tie`

Two participants on equal score and equal cumtime, separated by the tiebreaker.

## What this scenario pins down

- cumtime = sum of solve minutes + penalty minutes. The tiebreaker is the LARGEST solve time in minutes (`last`), not a sum — so it separates two boards with the same total.
- Solve time is floored to whole minutes (`int(dt // 60)`) before it enters cumtime, while format_data keeps the exact seconds.

## How it was produced

| | |
|---|---|
| Source of truth | `online-judge` @ `87383c7b8e98c52d0846ac6f5544a481dcef1a2c` (`feat: add virtual judge problem picker`) |
| Harness image | `3ccb797d66acdafcf4c1996f0a2bc665fc2aea922d0c42558948aa489a4a7ec8` |
| Database | MariaDB 10.11 (see below) |
| Command | `fixtures/contest-goldens/_generator/run.sh --only icpc/02-score-tie` |
| Verified with | `fixtures/contest-goldens/_generator/run.sh --verify --only icpc/02-score-tie` |
| Date | 2026-08-21 |

The scoreboard is produced by calling the original
`judge/contest_format/icpc.py` `update_participation()` and
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

Perturbation: bob's second accept moves 20 minutes later, changing both his cumtime and his tiebreaker.

10 field(s) changed:

| field | golden | perturbed |
|---|---|---|
| `problems[1].first_solve` | `bob` | `alice` |
| `ranking[0].format_data.a.time` | `1800.0` | `600.0` |
| `ranking[0].format_data.b.time` | `2400.0` | `3600.0` |
| `ranking[0].frozen_tiebreaker` | `40.0` | `60.0` |
| `ranking[0].participant` | `bob` | `alice` |
| `ranking[0].tiebreaker` | `40.0` | `60.0` |
| `ranking[1].cumtime` | `70` | `90` |
| `ranking[1].format_data.a.time` | `600.0` | `1800.0` |
| `ranking[1].frozen_cumtime` | `70` | `90` |
| `ranking[1].participant` | `alice` | `bob` |
