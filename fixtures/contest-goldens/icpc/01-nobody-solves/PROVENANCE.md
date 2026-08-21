# Provenance — `icpc/01-nobody-solves`

Failed attempts only. Tests that unsolved problems carry no penalty.

## What this scenario pins down

- Penalty is added ONLY inside the `if points:` branch. Attempts on a problem you never solve add ZERO penalty — a reimplementation that charges 20 minutes per wrong answer regardless is wrong.
- tries is still recorded (and displayed) for unsolved problems.
- The golden corrected a misreading: for an unsolved problem icpc reassigns the local `time` to Max(date), but `dt_second` — the value that reaches format_data — was already computed from the raw SQL's Min(date). The reassignment only feeds the frozen-scoreboard flag, so format_data.time records the FIRST attempt, not the last. Moving the last attempt an hour later changes nothing at all (see the null probe).

## How it was produced

| | |
|---|---|
| Source of truth | `online-judge` @ `87383c7b8e98c52d0846ac6f5544a481dcef1a2c` (`feat: add virtual judge problem picker`) |
| Harness image | `3ccb797d66acdafcf4c1996f0a2bc665fc2aea922d0c42558948aa489a4a7ec8` |
| Database | MariaDB 10.11 (see below) |
| Command | `fixtures/contest-goldens/_generator/run.sh --only icpc/01-nobody-solves` |
| Verified with | `fixtures/contest-goldens/_generator/run.sh --verify --only icpc/01-nobody-solves` |
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

Perturbation: alice's FIRST failed attempt moves one minute later; the recorded time for an unsolved problem follows the earliest attempt.

1 field(s) changed:

| field | golden | perturbed |
|---|---|---|
| `ranking[0].format_data.a.time` | `300.0` | `360.0` |

### Null probe (a change that provably does nothing)

alice's LAST failed attempt moves an hour later. The scoreboard is byte-identical, because for a zero-score problem the time that reaches format_data was already computed from Min(date); the later reassignment to Max(date) only affects the frozen-scoreboard flag.
