# Provenance — `default/04-late-joiner`

A windowed contest (time_limit set) where participants start at different times.

## What this scenario pins down

- ContestParticipation.start returns contest.start_time for a live participant only when contest.time_limit is None. With a time_limit set it returns real_start, so every relative time is measured from the join.
- A late joiner with the same elapsed time gets the same cumtime as an early one.

## How it was produced

| | |
|---|---|
| Source of truth | `online-judge` @ `87383c7b8e98c52d0846ac6f5544a481dcef1a2c` (`feat: add virtual judge problem picker`) |
| Harness image | `3ccb797d66acdafcf4c1996f0a2bc665fc2aea922d0c42558948aa489a4a7ec8` |
| Database | MariaDB 10.11 (see below) |
| Command | `fixtures/contest-goldens/_generator/run.sh --only default/04-late-joiner` |
| Verified with | `fixtures/contest-goldens/_generator/run.sh --verify --only default/04-late-joiner` |
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

Perturbation: bob's accept moves five minutes later, so his cumtime overtakes alice's.

12 field(s) changed:

| field | golden | perturbed |
|---|---|---|
| `problems[0].first_solve` | `bob` | `alice` |
| `ranking[0].format_data.b.points` | `0.0` | `<absent>` |
| `ranking[0].format_data.b.time` | `300.0` | `<absent>` |
| `ranking[0].participant` | `bob` | `alice` |
| `ranking[0].submission_count` | `2` | `1` |
| `ranking[1].cumtime` | `1800` | `2100` |
| `ranking[1].format_data.a.time` | `1800.0` | `2100.0` |
| `ranking[1].format_data.b.points` | `<absent>` | `0.0` |
| `ranking[1].format_data.b.time` | `<absent>` | `300.0` |
| `ranking[1].participant` | `alice` | `bob` |
| `ranking[1].rank` | `1` | `2` |
| `ranking[1].submission_count` | `1` | `2` |
