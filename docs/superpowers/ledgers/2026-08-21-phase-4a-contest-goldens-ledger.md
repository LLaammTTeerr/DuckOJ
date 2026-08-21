# Phase 4a decision ledger — contest format goldens

**What this is.** 23 golden scoreboards frozen from the real DMOJ
`update_participation()`, with the reasoning behind them. Phase 4b implements
against these.

| Deferred | Ruling |
|---|---|
| Seven of eleven DMOJ formats — `atcoder`, `ecoo`, `ultimate`, `final_submission`, `vnoj`, and the two registry helpers | Foundation spec's Dropped list. Formats are pluggable; any can return later as an isolated addition |
| No DuckOJ contest tables exist yet | Deliberate. This phase's deliverable is JSON. Modelling contests while the old app was up would have been the obvious scope creep and was refused |
| Row order beyond `(score, cumtime, tiebreaker, submission_count)` is database-defined | Not frozen, because it is not a property of the format. A mechanical check asserts no two rows in any golden tie on all four, so ordering never silently carries meaning |
| `frozen_last_minutes = 0` in every scenario | `is_frozen` reads `now()`, so a non-zero freeze window makes the output time-dependent and destroys reproducibility. Freeze behaviour needs its own scenario design with an injected clock |

---

## R1 — my spec was wrong about SQLite, and the correction is more faithful

I wrote that the harness could run on SQLite, citing `dmoj/settings.py:658`,
where the default engine is `django.db.backends.sqlite3`. I read the settings
default and not the migrations.

`judge/migrations/0085, 0089, 0189, 0198` contain MySQL-only
`UPDATE ... INNER JOIN`, so `migrate` fails outright on SQLite. The ICPC raw-SQL
block is MySQL-flavoured too. The harness runs **MariaDB 10.11** instead — about
fifteen minutes more setup, and strictly more faithful to what the fork
actually ran.

Fourteenth spec or brief defect across five phases. Same shape as most of them:
I cited a fact from one file that a second file contradicts.

## R2 — the goldens come from the real code, not from my reading of it

`requirements.txt` resolves today on `python:3.12-slim`, so every number in
these fixtures was produced by executing DMOJ's own `update_participation()`.
Two undocumented prerequisites found: `setuptools` is missing from
`requirements.txt` (the `qhhoj/ansi2html` fork needs `pkg_resources`), and
`dmoj/compressor_patch` must be imported before `django.setup()`.

A `requirements.lock.txt` from `pip freeze` is committed beside the generator,
so the resolve is reproducible even as the ranges drift.

## R3 — reproducibility proved from a destroyed database, not from a warm one

All 23 regenerate byte-identically — and the check was run after **destroying
the database container**, so it proves the pipeline reproduces from nothing
rather than that a cached run is stable.

Normalised to get there: `format_data` and `first_solve` re-keyed from
autoincrement primary keys to fixture codes; floats to nine places; `sort_keys`
with fixed indent; and the freeze window pinned to zero. Each of those is a
place where a real difference could otherwise hide behind a cosmetic one.

## R4 — sensitivity, and nine null probes

All 23 shift under a perturbed input, with field-level diffs recorded (1 to 30
fields). Nine additionally carry a **null probe**: a change proven to move
*nothing*. That is the stronger half — it pins that a format genuinely ignores
something, rather than that nobody tested it. `ioi16` records no time at all,
so submission order cannot affect its scoreboard, and the probe proves it.

## R5 — the implementer's own expectations were wrong twice, and it said so

Three scenarios failed on first pass and **two were its misreadings, not bugs**:
`icpc` records an unsolved problem's *first* attempt time (the `Max(date)`
reassignment only feeds the freeze flag), and `legacy_ioi`'s untimed config
still records times in `format_data`. Reported as corrections to its own
reading rather than quietly adjusted.

## R6 — what the formats actually do, including where they contradict belief

- **`default`** — `Max(points)` per problem. Cumtime sums the *last* submission
  time on scored problems, computed as an **independent aggregate** from the
  points, so a junk submission after an accept **increases your penalty**.
  Tiebreaker always 0.
- **`icpc`** — same score. Cumtime is minute-floored solve times plus
  `(tries − 1) × 20`, on **solved problems only**; CE, IE, null-result and
  post-accept submissions are free. Tiebreaker is the largest solve minute.
  Two surprises: one second past the deadline scores identically because of
  minute flooring, and **nothing filters by contest end at all**.
- **`legacy_ioi`** — best *submission* per problem, timed at `Min(date)` among
  ties. Cumtime, tiebreaker and first-solve are all config-gated, and under the
  default config `first_solve` is null for everyone.
- **`ioi16`** — best result **per batch across submissions**: `min` within a
  batch, `max` across submissions, and an absent batch is **not** a zero. Each
  batch scaled by `ContestProblem.points ÷ dataset batch total`, summed, then
  rounded. It **ignores `ContestSubmission.points` entirely**, reading
  `SubmissionTestCase` rows directly. Cumtime, tiebreaker and all times pinned
  to 0, so score ties are never broken.

## R7 — the pair that justifies the whole phase

`ioi16/09-partial-subtasks-multiple-submissions` and
`legacy_ioi/09-best-submission-not-best-batch` hold **byte-identical
submissions** — verified independently by me, not taken from the report. The
same participant scores **100 under `ioi16` and 60 under `legacy_ioi`**,
because she takes batch 1 from one submission and batch 2 from another.

A reimplementation that reads "best score per problem" passes every other
scenario in this corpus and is wrong by 40 points here. That single pair is
worth more than the other 22 goldens combined, and it is exactly the silent
scoring difference the foundation spec feared — now frozen as a fixture rather
than discovered in a contest.
