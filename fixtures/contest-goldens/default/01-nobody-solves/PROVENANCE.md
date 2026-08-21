# Provenance — `default/01-nobody-solves`

Three participants, nothing solved. Tests the all-zero board and the order of rows that tie on every ranking key.

## What this scenario pins down

- A zero-point submission still creates a format_data entry, so "has a cell" is not the same as "scored".
- cumtime only accumulates for problems with a non-zero score, so it stays 0.
- Rows tied on (score, cumtime, tiebreaker) are ordered by -submission_count: more submissions ranks higher.

## How it was produced

| | |
|---|---|
| Source of truth | `online-judge` @ `87383c7b8e98c52d0846ac6f5544a481dcef1a2c` (`feat: add virtual judge problem picker`) |
| Harness image | `3ccb797d66acdafcf4c1996f0a2bc665fc2aea922d0c42558948aa489a4a7ec8` |
| Database | MariaDB 10.11 (see below) |
| Command | `fixtures/contest-goldens/_generator/run.sh --only default/01-nobody-solves` |
| Verified with | `fixtures/contest-goldens/_generator/run.sh --verify --only default/01-nobody-solves` |
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

Perturbation: alice's last submission on b moves one minute later, changing format_data['b']['time'] even though no score changes.

1 field(s) changed:

| field | golden | perturbed |
|---|---|---|
| `ranking[0].format_data.b.time` | `1500.0` | `1560.0` |
