# Provenance — `ioi16/11-missing-batch-vs-zero-batch`

A batch absent from a submission versus a batch present and scoring zero, plus a loose (unbatched) case.

## What this scenario pins down

- A batch with NO test-case rows in a submission is simply absent from that submission's contribution; it does not pull the running max down to zero. A batch present with zero points contributes a zero that max() discards. The two states are distinguishable only across submissions.
- Cases with batch NULL are folded into batch 0 and compete with each other by min(), so all unbatched cases behave as a single implicit batch.
- alice reaches 100 while no single submission of hers scored more than 40.

## How it was produced

| | |
|---|---|
| Source of truth | `online-judge` @ `87383c7b8e98c52d0846ac6f5544a481dcef1a2c` (`feat: add virtual judge problem picker`) |
| Harness image | `3ccb797d66acdafcf4c1996f0a2bc665fc2aea922d0c42558948aa489a4a7ec8` |
| Database | MariaDB 10.11 (see below) |
| Command | `fixtures/contest-goldens/_generator/run.sh --only ioi16/11-missing-batch-vs-zero-batch` |
| Verified with | `fixtures/contest-goldens/_generator/run.sh --verify --only ioi16/11-missing-batch-vs-zero-batch` |
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

Perturbation: alice's batch 1 in her first submission flips to zero; since no other submission of hers scores that batch, her total drops by 30.

3 field(s) changed:

| field | golden | perturbed |
|---|---|---|
| `problems[0].total_ac` | `1` | `0` |
| `ranking[0].format_data.a.points` | `100.0` | `70.0` |
| `ranking[0].score` | `100.0` | `70.0` |
