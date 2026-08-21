# Provenance — `icpc/08-problem-nobody-solves`

Two problems: one solved by everyone, one solved by nobody, with a participant who never attempted it at all.

## What this scenario pins down

- total_ac is 0 and first_solve is null for the unsolved problem.
- A participant with NO submission on a problem has no format_data key for it at all (the raw SQL INNER JOINs judge_contestsubmission), while a participant who attempted and failed has a key with points 0 and tries > 0. "Absent" and "zero" are different states.

## How it was produced

| | |
|---|---|
| Source of truth | `online-judge` @ `87383c7b8e98c52d0846ac6f5544a481dcef1a2c` (`feat: add virtual judge problem picker`) |
| Harness image | `3ccb797d66acdafcf4c1996f0a2bc665fc2aea922d0c42558948aa489a4a7ec8` |
| Database | MariaDB 10.11 (see below) |
| Command | `fixtures/contest-goldens/_generator/run.sh --only icpc/08-problem-nobody-solves` |
| Verified with | `fixtures/contest-goldens/_generator/run.sh --verify --only icpc/08-problem-nobody-solves` |
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

Perturbation: alice's accept moves 30 minutes later, transferring the first solve on a to bob and reordering the board.

21 field(s) changed:

| field | golden | perturbed |
|---|---|---|
| `problems[0].first_solve` | `alice` | `bob` |
| `ranking[0].cumtime` | `15` | `35` |
| `ranking[0].format_data.a.time` | `900.0` | `2100.0` |
| `ranking[0].format_data.b.frozen_tries` | `2` | `1` |
| `ranking[0].format_data.b.time` | `4800.0` | `3600.0` |
| `ranking[0].format_data.b.tries` | `2` | `1` |
| `ranking[0].frozen_cumtime` | `15` | `35` |
| `ranking[0].frozen_tiebreaker` | `15.0` | `35.0` |
| `ranking[0].participant` | `alice` | `bob` |
| `ranking[0].submission_count` | `3` | `2` |
| `ranking[0].tiebreaker` | `15.0` | `35.0` |
| `ranking[1].cumtime` | `35` | `45` |
| `ranking[1].format_data.a.time` | `2100.0` | `2700.0` |
| `ranking[1].format_data.b.frozen_tries` | `1` | `2` |
| `ranking[1].format_data.b.time` | `3600.0` | `4800.0` |
| `ranking[1].format_data.b.tries` | `1` | `2` |
| `ranking[1].frozen_cumtime` | `35` | `45` |
| `ranking[1].frozen_tiebreaker` | `35.0` | `45.0` |
| `ranking[1].participant` | `bob` | `alice` |
| `ranking[1].submission_count` | `2` | `3` |
| `ranking[1].tiebreaker` | `35.0` | `45.0` |
