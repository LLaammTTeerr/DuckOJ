# Provenance — `legacy_ioi/01-nobody-solves`

Failed attempts only, with cumtime and last_score_altering enabled.

## What this scenario pins down

- A zero-score problem records time 0 explicitly (the `else: dt = 0` branch), not the submission time — unlike default, which records the real time.
- cumtime and the tiebreaker stay 0 because neither accumulates for a zero-score problem.

## How it was produced

| | |
|---|---|
| Source of truth | `online-judge` @ `87383c7b8e98c52d0846ac6f5544a481dcef1a2c` (`feat: add virtual judge problem picker`) |
| Harness image | `3ccb797d66acdafcf4c1996f0a2bc665fc2aea922d0c42558948aa489a4a7ec8` |
| Database | MariaDB 10.11 (see below) |
| Command | `fixtures/contest-goldens/_generator/run.sh --only legacy_ioi/01-nobody-solves` |
| Verified with | `fixtures/contest-goldens/_generator/run.sh --verify --only legacy_ioi/01-nobody-solves` |
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

Perturbation: alice's second attempt scores 40 instead of 0, which turns on the time-recording branch for that problem.

6 field(s) changed:

| field | golden | perturbed |
|---|---|---|
| `ranking[0].cumtime` | `0` | `900` |
| `ranking[0].format_data.a.points` | `0.0` | `40.0` |
| `ranking[0].format_data.a.time` | `0` | `900.0` |
| `ranking[0].score` | `0.0` | `40.0` |
| `ranking[0].tiebreaker` | `0.0` | `900.0` |
| `ranking[1].rank` | `1` | `2` |

### Null probe (a change that provably does nothing)

a failed submission moves an hour later. The scoreboard is byte-identical, because legacy_ioi pins the recorded time of a zero-score problem to 0 (`else: dt = 0`), so a failed submission's timing is unobservable.
