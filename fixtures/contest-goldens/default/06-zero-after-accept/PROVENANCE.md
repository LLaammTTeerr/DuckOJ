# Provenance — `default/06-zero-after-accept`

A worthless submission sent AFTER an accept, on the same problem.

## What this scenario pins down

- default's `Max('submission__date')` and `Max('points')` are INDEPENDENT aggregates. The recorded time is the last submission on the problem, not the time of the best one — so a zero-point resubmission after an accept raises your cumtime and can cost you the contest.
- legacy_ioi/06-zero-after-accept has identical inputs and does not do this: it takes Min(date) among the best-scoring submissions.

## How it was produced

| | |
|---|---|
| Source of truth | `online-judge` @ `87383c7b8e98c52d0846ac6f5544a481dcef1a2c` (`feat: add virtual judge problem picker`) |
| Harness image | `3ccb797d66acdafcf4c1996f0a2bc665fc2aea922d0c42558948aa489a4a7ec8` |
| Database | MariaDB 10.11 (see below) |
| Command | `fixtures/contest-goldens/_generator/run.sh --only default/06-zero-after-accept` |
| Verified with | `fixtures/contest-goldens/_generator/run.sh --verify --only default/06-zero-after-accept` |
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

Perturbation: alice's post-accept junk moves 25 minutes earlier, dropping her cumtime below bob and flipping the ranking.

9 field(s) changed:

| field | golden | perturbed |
|---|---|---|
| `problems[0].first_solve` | `bob` | `alice` |
| `ranking[0].cumtime` | `5400` | `4500` |
| `ranking[0].format_data.a.time` | `5400.0` | `4500.0` |
| `ranking[0].participant` | `bob` | `alice` |
| `ranking[0].submission_count` | `1` | `2` |
| `ranking[1].cumtime` | `6000` | `5400` |
| `ranking[1].format_data.a.time` | `6000.0` | `5400.0` |
| `ranking[1].participant` | `alice` | `bob` |
| `ranking[1].submission_count` | `2` | `1` |
