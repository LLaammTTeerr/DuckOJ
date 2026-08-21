# Provenance — `legacy_ioi/02-score-tie`

Partial scores tying on total, separated by cumtime and then by tiebreaker.

## What this scenario pins down

- cumtime = sum over non-zero problems of the time of the EARLIEST submission achieving that problem's best score.
- tiebreaker = the largest such time. With cumtime enabled, participation.cumtime is the sum and the tiebreaker is the max, so both are used.
- Partial credit is real here: 60 + 40 ties with 50 + 50.

## How it was produced

| | |
|---|---|
| Source of truth | `online-judge` @ `87383c7b8e98c52d0846ac6f5544a481dcef1a2c` (`feat: add virtual judge problem picker`) |
| Harness image | `3ccb797d66acdafcf4c1996f0a2bc665fc2aea922d0c42558948aa489a4a7ec8` |
| Database | MariaDB 10.11 (see below) |
| Command | `fixtures/contest-goldens/_generator/run.sh --only legacy_ioi/02-score-tie` |
| Verified with | `fixtures/contest-goldens/_generator/run.sh --verify --only legacy_ioi/02-score-tie` |
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

Perturbation: bob's first submission moves ten minutes later, raising his cumtime and tiebreaker past alice.

13 field(s) changed:

| field | golden | perturbed |
|---|---|---|
| `ranking[1].format_data.a.points` | `50.0` | `60.0` |
| `ranking[1].format_data.a.time` | `900.0` | `600.0` |
| `ranking[1].format_data.b.points` | `50.0` | `40.0` |
| `ranking[1].format_data.b.time` | `1500.0` | `1800.0` |
| `ranking[1].participant` | `bob` | `alice` |
| `ranking[1].tiebreaker` | `1500.0` | `1800.0` |
| `ranking[2].cumtime` | `2400` | `3000` |
| `ranking[2].format_data.a.points` | `60.0` | `50.0` |
| `ranking[2].format_data.a.time` | `600.0` | `1500.0` |
| `ranking[2].format_data.b.points` | `40.0` | `50.0` |
| `ranking[2].format_data.b.time` | `1800.0` | `1500.0` |
| `ranking[2].participant` | `alice` | `bob` |
| `ranking[2].tiebreaker` | `1800.0` | `1500.0` |
