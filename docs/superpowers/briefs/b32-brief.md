# B-32 — Attack the scoring rewrite

## Why this hunt, and why now

F-45 changed **how a score is derived**. That is the highest-consequence
code in this system: a wrong scoreboard has bricked a contest here before
(D36), and unlike a crash it does not announce itself — it just declares the
wrong child the winner.

Read `docs/superpowers/briefs/f45-report.md` and D165/D166 first, then the
diffs of `ebbddc1`, `6b27599`, `77962fd`, `2c76cc0` and migration 0045.

Two things make this worth an adversarial pass rather than trust:

1. **The author's own proof was foolable once.** Their first property test
   compared only rounded output, and `pyRound(_, 1)` erases every discrepancy
   a reassociated floating-point sum makes — so it *passed* a deliberately
   wrong implementation. They caught it and fixed it. A test that was foolable
   once is a signal about the whole area, not a closed incident.
2. **A derived column is only as good as every writer that maintains it.**
   `subtask_summary` is now stored. Every path that can change what it should
   contain must update it, and a path that forgets does not fail — it serves a
   stale score.

## What to attack

### 1. The arithmetic

`sum(points ORDER BY id)` over `double precision` was chosen because the old
fold accumulated with `+` in `submission_cases.id` order, and an unordered sum
is a *different number*. Attack that claim from both ends:

- Is the backfill's order genuinely the order the old JavaScript used, on every
  path that built those rows — including a rejudge that inserted cases in a
  different order, and a dataset whose groups interleave?
- `SET LOCAL extra_float_digits = 3` was needed because 48,861 of 50,000 values
  failed to round-trip at the default. That fix is inside the migration's
  transaction. **Does every other writer of this column have the same
  guarantee?** A `jsonb` written by the API or by `judged` at session default
  is the same bug the migration went out of its way to avoid, arriving by a
  door the migration cannot close.
- Find an input where the stored summary and a fresh reduction of the case
  rows disagree. If you cannot, say precisely what you tried.

### 2. Every writer of a verdict

Enumerate them, then check each maintains the summary: first judging, rejudge
(one submission and a whole problem), recompute, disqualification, attempt
fencing and targeted cancel (D29), the admin submission actions, and anything
in `apps/judged` that writes a terminal state. A table of writer → does it
write the summary → proof.

There is prior art: silent counter drift in the rejudge/recompute path was a
real defect fixed with `FOR UPDATE`. The same shape applies here.

### 3. The freeze, the formats, and the cache

- The freeze masks in the JS fold and the D25 cache key, not in SQL. A fold
  that now reads a stored column must still mask identically. Try to read a
  frozen standing through the new path.
- Five formats — ICPC, IOI, IOI-2016, legacy-IOI, default. The summary is one
  shape serving all of them. Find the format where that shape loses
  information the old per-case read had.
- D25's cache: is anything now cached that keys on data the summary changed,
  without a busting path?

### 4. Verify the live backfill independently

880 of 880 live submissions were summarised by migration 0045. **Recompute
those summaries yourself from `submission_cases`, read-only, and compare to
what is stored.** Any disagreement is a live wrong score today. This is the
single most valuable thing in the slot and it is cheap: the data is small and
the comparison is arithmetic.

## Ground rules for this hunt

**A clean result is valid and must show its work** — the writer table, what you
tried against the arithmetic, and the live comparison's actual counts. An
unsupported all-clear on scoring code is worse than useless.

Rank findings by what a pupil experiences. A wrong total on a scoreboard
outranks everything else in this codebase.

## How you work

**The live stack is production**, deployed at `0baa17e`, six containers
healthy, migration 0045 applied and backfilled.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`. Only the controller deploys.
- Live database is **read-only**: `SELECT`/`EXPLAIN`. Scratch databases are
  yours to create and drop.
- **Never** write to `apps/web/dist`. **Do not run the web build.**
- **Never** read, print or commit anything from `.secrets/`.
- Live rows you create follow **D153** naming; close what you open.

**Thermal caps** (93 °C reading earlier today): every command under
`nice -n 19`; no load test; vitest `--no-file-parallelism`; a container-backed
spec runs **alone**.

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D167** is yours; **D168** and **D169** after it. Do not go
past D169, do not renumber.

## Report

Write `docs/superpowers/briefs/b32-report.md`: the writer table, the
arithmetic attacks and their outcomes, the live backfill comparison with real
counts, and every defect with its reproduction and red-test output. Return
only: status, commits, the real `N passed` line, defect count by severity, and
what you could not finish.
