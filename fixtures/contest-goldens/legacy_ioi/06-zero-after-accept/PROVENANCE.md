# Provenance — `legacy_ioi/06-zero-after-accept`

The same inputs as default/06-zero-after-accept, for contrast.

## What this scenario pins down

- legacy_ioi selects `Min(date)` among the submissions whose points equal the participant's best on that problem, so a later worthless submission is invisible. default records the last submission time instead and would punish alice. Two formats, one input, opposite outcomes.

## How it was produced

| | |
|---|---|
| Source of truth | `online-judge` @ `87383c7b8e98c52d0846ac6f5544a481dcef1a2c` (`feat: add virtual judge problem picker`) |
| Harness image | `3ccb797d66acdafcf4c1996f0a2bc665fc2aea922d0c42558948aa489a4a7ec8` |
| Database | MariaDB 10.11 (see below) |
| Command | `fixtures/contest-goldens/_generator/run.sh --only legacy_ioi/06-zero-after-accept` |
| Verified with | `fixtures/contest-goldens/_generator/run.sh --verify --only legacy_ioi/06-zero-after-accept` |
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

Perturbation: alice's accept moves past bob's, so her recorded time — and the first solve — change hands.

11 field(s) changed:

| field | golden | perturbed |
|---|---|---|
| `problems[0].first_solve` | `alice` | `bob` |
| `ranking[0].cumtime` | `600` | `5400` |
| `ranking[0].format_data.a.time` | `600.0` | `5400.0` |
| `ranking[0].participant` | `alice` | `bob` |
| `ranking[0].submission_count` | `2` | `1` |
| `ranking[0].tiebreaker` | `600.0` | `5400.0` |
| `ranking[1].cumtime` | `5400` | `5500` |
| `ranking[1].format_data.a.time` | `5400.0` | `5500.0` |
| `ranking[1].participant` | `bob` | `alice` |
| `ranking[1].submission_count` | `1` | `2` |
| `ranking[1].tiebreaker` | `5400.0` | `5500.0` |
