# Provenance — `default/05-virtual-participation`

A virtual participation running after the contest, alongside two live ones.

## What this scenario pins down

- A virtual participation is ranked with everyone else and can outrank live participants, but is excluded from first_solve (`participation.virtual == 0`).
- It is NOT excluded from total_ac, which counts virtuals.
- A virtual participation measures time from real_start regardless of contest.time_limit, because ContestParticipation.start only special-cases live and spectating rows.

## How it was produced

| | |
|---|---|
| Source of truth | `online-judge` @ `87383c7b8e98c52d0846ac6f5544a481dcef1a2c` (`feat: add virtual judge problem picker`) |
| Harness image | `3ccb797d66acdafcf4c1996f0a2bc665fc2aea922d0c42558948aa489a4a7ec8` |
| Database | MariaDB 10.11 (see below) |
| Command | `fixtures/contest-goldens/_generator/run.sh --only default/05-virtual-participation` |
| Verified with | `fixtures/contest-goldens/_generator/run.sh --verify --only default/05-virtual-participation` |
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

Perturbation: the virtual accept moves 25 minutes later, dropping mallory below both live participants without touching first_solve.

8 field(s) changed:

| field | golden | perturbed |
|---|---|---|
| `ranking[0].cumtime` | `600` | `1800` |
| `ranking[0].format_data.a.time` | `600.0` | `1800.0` |
| `ranking[0].participant` | `mallory` | `alice` |
| `ranking[0].virtual` | `1` | `0` |
| `ranking[1].cumtime` | `1800` | `2100` |
| `ranking[1].format_data.a.time` | `1800.0` | `2100.0` |
| `ranking[1].participant` | `alice` | `mallory` |
| `ranking[1].virtual` | `0` | `1` |
