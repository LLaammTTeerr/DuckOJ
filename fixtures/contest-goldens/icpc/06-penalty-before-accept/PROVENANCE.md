# Provenance — `icpc/06-penalty-before-accept`

Wrong answers before an accept, plus a compile error and an internal error that must not be counted.

## What this scenario pins down

- tries counts every graded submission dated at or before the accept, INCLUDING the accept itself; penalty is (tries - 1) * penalty_minutes.
- Compile errors (CE) and internal errors (IE), and submissions with a NULL result, are excluded from tries — so they are free. Most reimplementations charge for compile errors.
- Penalty can invert the standings: alice solved 35 minutes earlier than bob and still loses.

## How it was produced

| | |
|---|---|
| Source of truth | `online-judge` @ `87383c7b8e98c52d0846ac6f5544a481dcef1a2c` (`feat: add virtual judge problem picker`) |
| Harness image | `3ccb797d66acdafcf4c1996f0a2bc665fc2aea922d0c42558948aa489a4a7ec8` |
| Database | MariaDB 10.11 (see below) |
| Command | `fixtures/contest-goldens/_generator/run.sh --only icpc/06-penalty-before-accept` |
| Verified with | `fixtures/contest-goldens/_generator/run.sh --verify --only icpc/06-penalty-before-accept` |
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

Perturbation: alice's second wrong answer moves to 25 minutes, AFTER her accept, so it stops counting: her penalty drops by 20 minutes and she wins.

18 field(s) changed:

| field | golden | perturbed |
|---|---|---|
| `ranking[0].cumtime` | `55` | `40` |
| `ranking[0].format_data.a.frozen_tries` | `1` | `2` |
| `ranking[0].format_data.a.time` | `3300.0` | `1200.0` |
| `ranking[0].format_data.a.tries` | `1` | `2` |
| `ranking[0].frozen_cumtime` | `55` | `40` |
| `ranking[0].frozen_tiebreaker` | `55.0` | `20.0` |
| `ranking[0].participant` | `bob` | `alice` |
| `ranking[0].submission_count` | `1` | `5` |
| `ranking[0].tiebreaker` | `55.0` | `20.0` |
| `ranking[1].cumtime` | `60` | `55` |
| `ranking[1].format_data.a.frozen_tries` | `3` | `1` |
| `ranking[1].format_data.a.time` | `1200.0` | `3300.0` |
| `ranking[1].format_data.a.tries` | `3` | `1` |
| `ranking[1].frozen_cumtime` | `60` | `55` |
| `ranking[1].frozen_tiebreaker` | `20.0` | `55.0` |
| `ranking[1].participant` | `alice` | `bob` |
| `ranking[1].submission_count` | `5` | `1` |
| `ranking[1].tiebreaker` | `20.0` | `55.0` |
