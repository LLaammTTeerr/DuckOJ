# Provenance — `icpc/03-deadline-boundary`

Accepts at the deadline, one second after, 59 seconds after, and a minute after.

## What this scenario pins down

- Because solve time is floored to minutes, a submission ONE SECOND after the deadline scores an identical cumtime and tiebreaker. Only format_data.time differs. This is the sharpest divergence from a seconds-based reimplementation.
- Nothing filters submissions by the contest end.
- Three rows tie on every ranking key and are ordered by -submission_count; the ranker then jumps straight from rank 1 to rank 4.

## How it was produced

| | |
|---|---|
| Source of truth | `online-judge` @ `87383c7b8e98c52d0846ac6f5544a481dcef1a2c` (`feat: add virtual judge problem picker`) |
| Harness image | `3ccb797d66acdafcf4c1996f0a2bc665fc2aea922d0c42558948aa489a4a7ec8` |
| Database | MariaDB 10.11 (see below) |
| Command | `fixtures/contest-goldens/_generator/run.sh --only icpc/03-deadline-boundary` |
| Verified with | `fixtures/contest-goldens/_generator/run.sh --verify --only icpc/03-deadline-boundary` |
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

Perturbation: carol's accept crosses the 14:01:00 minute boundary, so her cumtime and tiebreaker each rise by one and she loses the tie.

30 field(s) changed:

| field | golden | perturbed |
|---|---|---|
| `ranking[0].format_data.a.time` | `18059.0` | `18001.0` |
| `ranking[0].format_data.b.frozen_tries` | `2` | `1` |
| `ranking[0].format_data.b.time` | `360.0` | `300.0` |
| `ranking[0].format_data.b.tries` | `2` | `1` |
| `ranking[0].participant` | `carol` | `bob` |
| `ranking[0].submission_count` | `3` | `2` |
| `ranking[1].format_data.a.time` | `18001.0` | `18000.0` |
| `ranking[1].format_data.b.frozen_points` | `0` | `<absent>` |
| `ranking[1].format_data.b.frozen_tries` | `1` | `<absent>` |
| `ranking[1].format_data.b.is_frozen` | `False` | `<absent>` |
| `ranking[1].format_data.b.points` | `0.0` | `<absent>` |
| `ranking[1].format_data.b.time` | `300.0` | `<absent>` |
| `ranking[1].format_data.b.tries` | `1` | `<absent>` |
| `ranking[1].participant` | `bob` | `alice` |
| `ranking[1].submission_count` | `2` | `1` |
| `ranking[2].cumtime` | `300` | `301` |
| `ranking[2].format_data.a.time` | `18000.0` | `18060.0` |
| `ranking[2].format_data.b.frozen_points` | `<absent>` | `0` |
| `ranking[2].format_data.b.frozen_tries` | `<absent>` | `2` |
| `ranking[2].format_data.b.is_frozen` | `<absent>` | `False` |
| `ranking[2].format_data.b.points` | `<absent>` | `0.0` |
| `ranking[2].format_data.b.time` | `<absent>` | `360.0` |
| `ranking[2].format_data.b.tries` | `<absent>` | `2` |
| `ranking[2].frozen_cumtime` | `300` | `301` |
| `ranking[2].frozen_tiebreaker` | `300.0` | `301.0` |
| `ranking[2].participant` | `alice` | `carol` |
| `ranking[2].rank` | `1` | `3` |
| `ranking[2].submission_count` | `1` | `3` |
| `ranking[2].tiebreaker` | `300.0` | `301.0` |
| `ranking[3].rank` | `4` | `3` |
