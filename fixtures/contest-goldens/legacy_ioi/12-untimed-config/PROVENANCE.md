# Provenance — `legacy_ioi/12-untimed-config`

legacy_ioi with the DEFAULT config: cumtime false, last_score_altering false.

## What this scenario pins down

- With both switches off, cumtime and tiebreaker are pinned to 0 and score ties are simply never broken — the format says so explicitly.
- format_data STILL records the solve time even under this config; only the aggregate fields are pinned. A reimplementation that skips computing times entirely under this config would produce a different format_data.
- SURPRISE: first_solve is null for EVERY problem, because get_first_solves_and_total_ac guards the first-solve update on `show_time`, which is false under this config. total_ac is still counted. A reimplementation that always computes first solves will disagree here.
- Residual row order is decided entirely by -submission_count.

## How it was produced

| | |
|---|---|
| Source of truth | `online-judge` @ `87383c7b8e98c52d0846ac6f5544a481dcef1a2c` (`feat: add virtual judge problem picker`) |
| Harness image | `3ccb797d66acdafcf4c1996f0a2bc665fc2aea922d0c42558948aa489a4a7ec8` |
| Database | MariaDB 10.11 (see below) |
| Command | `fixtures/contest-goldens/_generator/run.sh --only legacy_ioi/12-untimed-config` |
| Verified with | `fixtures/contest-goldens/_generator/run.sh --verify --only legacy_ioi/12-untimed-config` |
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

Perturbation: alice's accept moves two hours later; format_data.time follows it even though cumtime and the tiebreaker stay 0.

1 field(s) changed:

| field | golden | perturbed |
|---|---|---|
| `ranking[1].format_data.a.time` | `600.0` | `7800.0` |
