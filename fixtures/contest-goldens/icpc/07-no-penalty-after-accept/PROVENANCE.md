# Provenance — `icpc/07-no-penalty-after-accept`

Wrong answers sent after the accept on the same problem.

## What this scenario pins down

- Submissions after the first maximum-score submission do NOT add penalty: tries filters on `submission__date__lte=time`, where time is the earliest submission carrying the maximum score.
- They also do not move the recorded time, because the raw SQL takes MIN(date) over the submissions holding the maximum points.
- Contrast default/06-zero-after-accept, where the same shape of input DOES move the time.

## How it was produced

| | |
|---|---|
| Source of truth | `online-judge` @ `87383c7b8e98c52d0846ac6f5544a481dcef1a2c` (`feat: add virtual judge problem picker`) |
| Harness image | `3ccb797d66acdafcf4c1996f0a2bc665fc2aea922d0c42558948aa489a4a7ec8` |
| Database | MariaDB 10.11 (see below) |
| Command | `fixtures/contest-goldens/_generator/run.sh --only icpc/07-no-penalty-after-accept` |
| Verified with | `fixtures/contest-goldens/_generator/run.sh --verify --only icpc/07-no-penalty-after-accept` |
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

Perturbation: alice's accept moves ten minutes earlier; her cumtime drops by ten while the two later wrong answers stay free.

5 field(s) changed:

| field | golden | perturbed |
|---|---|---|
| `ranking[0].cumtime` | `20` | `10` |
| `ranking[0].format_data.a.time` | `1200.0` | `600.0` |
| `ranking[0].frozen_cumtime` | `20` | `10` |
| `ranking[0].frozen_tiebreaker` | `20.0` | `10.0` |
| `ranking[0].tiebreaker` | `20.0` | `10.0` |

### Null probe (a change that provably does nothing)

alice's first post-accept wrong answer moves ten minutes later. The scoreboard is byte-identical, because submissions after the first maximum-score submission are invisible to icpc: they neither add penalty nor move the recorded time.
