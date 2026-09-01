# B-32 — Attack the scoring rewrite

**Status**: done. **One defect** (medium), found by reading the writers rather
than by finding a wrong row, red-tested and fixed. **The live backfill is
clean**: all 880 summaries recomputed independently in JavaScript and identical
to what migration 0045 stored. Four observations that are not defects are
recorded with what was tried. Decisions **D167** and **D168**; **D169 unspent**.
Four commits on `main` in this clone (this report is the fourth); **nothing pushed**, nothing written to the
live database.

---

## 4. The live backfill, verified independently (done first, per the brief)

Read-only over `podman exec … psql` with `default_transaction_read_only = on`
and `extra_float_digits = 3`, exactly the transport `scripts/integrity-check.ts`
uses. Every `submissions.subtask_summary` and every `submission_cases` row
dumped as text, then **recomputed in Node with the real `summariseCases`** — not
with the migration's SQL, which would have certified that SQL against itself —
filtering to `max(attempt)` per submission and reducing in ascending `id` order.
Compared with `Object.is` on all five fields **and on array order**.

```
terminal submissions compared: 880
  agree (Object.is on all 5 fields, array order included): 880
  disagree: 0   (stored NULL: 0)
  with case rows: 867   with none (expect []): 13
  groups compared: 2241
```

**No disagreement. No live wrong score.** A second, independent SQL-side
comparison — the `submission-summary-disagrees-with-cases` check committed in
D168, which extracts the stored numbers with `->>` and compares in `float8`
rather than re-rendering through `to_jsonb` — also returns zero rows, and the
whole audit against production is:

```
25 checks, 0 with violations (high 0, medium 0, low 0)
```

### What that comparison can and cannot see — the honest half

| fact about the live data | consequence for the proof |
| --- | --- |
| **All 8 755 case rows carry integer points** (`count(*) filter (where points <> floor(points))` = 0; 8 distinct values, min 0, max 60) | Integer-valued doubles under 2⁵³ add **exactly in any order**, so this comparison **cannot detect a reassociated sum at all**. The order-sensitivity claim is carried by the scratch-database run in §1, not by this. |
| **All 880 summaries were written by migration 0045's backfill**; `select count(*) from submissions where judged_at > (the migration's own timestamp)` = **0** — nothing has been judged since 0045 was applied at 2026-09-01 11:40:37 UTC | This is a genuine **SQL-backfill vs JavaScript-oracle** check, which is the strongest form of it. It exercises `EventWriter`'s jsonb seam **not at all**; that seam is proved only by `apps/judged/test/event-writer.spec.ts` and by §1's probe. |
| `points = 'NaN'::float8` on zero rows | The "`JSON.stringify(NaN)` → `null` → validator refuses → permanent residue" hazard has nothing to bite on. |
| Case-row attempts present are 1 (8 420 rows), 3 (323), 5 (12) | A rejudge bumps `attempt` and `claim` bumps it again, so graded attempts are odd. Consistent. |
| `grading_jobs.attempt` vs `max(submission_cases.attempt)`, per terminal submission: `1/none` ×13, `1/1` ×836, `3/3` ×30, `5/5` ×1 | **Defect 1 is not live today.** No submission carries a superseded attempt. |

---

## 1. The arithmetic

### Is the backfill's order the order the old JavaScript used?

Yes, and it is the same order on every path that builds the rows.

- `summariseCases` keys a `Map` in **first-seen** order and accumulates
  `sumPoints`/`sumTotal` from the first value. The backfill orders groups by
  `min(id)` and sums with `sum(points ORDER BY id)`. Over a list already sorted
  by `id`, first-seen order **is** `min(id)` order and the addition sequences
  are identical, including the leading value rather than a leading `0 +`.
- Both readers that feed `summariseCases` sort by `id`:
  `EventWriter.writeTerminal` (`orderBy(asc(submissionCases.id))`) and the fold's
  residue read `loadSubtasksFromCases` (same). Interleaved groups are not a
  special case — first-seen order across an id-sorted list is exactly `min(id)`
  order however the groups interleave.
- **A rejudge cannot insert cases in a different order**: `requeueAll` DELETEs
  every case row and the regrade inserts fresh `bigserial` ids.

**Attacked on a scratch database** (`b32_scratch`, created on the live cluster's
Postgres 16.15 and dropped): 400 submissions, **1 783 groups**, five groups per
submission interleaved at random, a superseded earlier attempt on every fourth,
and points drawn from a pool the shipped spec's generator does not emit — `-0`,
denormals (`5e-324`, `4.9e-324`), negatives, `1e-300`, `1e150`, `2**40`,
`1e15 + 0.1`, `1/3`. Migration 0045's own statements were **read out of the
file** and run inside a real `BEGIN`/`COMMIT` so its `SET LOCAL` applied, then
compared to `summariseCases` with `Object.is`:

```
submissions: 400  groups: 1783  agree: 400  disagree: 0
```

### `SET LOCAL extra_float_digits = 3` — does every other writer have the guarantee?

**The door the brief feared is not open, and here is why, with citations rather
than reasoning.**

The column has exactly **two** writers and one nuller (§2). Only one of them
ever renders a `double precision` server-side:

| writer | how the number crosses into jsonb | reached by `extra_float_digits`? |
| --- | --- | --- |
| migration 0045's backfill | `to_jsonb(sc.points)` — a server-side `float8out` | **Yes**, and it pins it |
| `EventWriter.writeTerminal` | drizzle's `PgJsonb.mapToDriverValue` is `JSON.stringify(value)` (`node_modules/drizzle-orm/pg-core/columns/jsonb.js:21`) — the text is built in Node and bound as a parameter | **No**. The GUC cannot reach it |

And the migration's `SET LOCAL` **does** take effect: drizzle's migrator wraps
*every* pending migration in one `session.transaction`
(`node_modules/drizzle-orm/pg-core/dialect.js:60`), so the setting is live for
the backfill statements two lines below it.

Measured on this cluster over 17 adversarial doubles, both writers side by side:

| writer / setting | values that round-trip |
| --- | --- |
| `to_jsonb(float8)` at `extra_float_digits = 0` | **10 / 17** — including `1/3` → `0.333333333333333`, `0.1+0.2` → `0.3`, `99.99999999999999` → `100`, and `1.797…e308` → an integer that `JSON.parse`s to **`Infinity`**, which `readSubtaskSummary` would refuse forever |
| `to_jsonb(float8)` at `extra_float_digits = 1` (the live cluster's setting) | 16 / 17 |
| `to_jsonb(float8)` at `extra_float_digits = 3` (the migration's) | 16 / 17 |
| `JSON.stringify` — drizzle's jsonb writer | 16 / 17 |

The shared 17th is `-0`, which both writers normalise to `+0` (observation O2).
The migration's comment is vindicated: at 0 this would have been a wrong
scoreboard reported as a right one, and the fix is real rather than decorative.

**Where the guarantee is inherited rather than constructed** — observation O1,
and it is the brief's question turned around. Nothing pins `extra_float_digits`
for the sessions that **read** `submission_cases.points` as `float8` over the
wire before summing: `EventWriter.writeTerminal` and the residue read
`loadSubtasksFromCases`. `packages/db/src/client.ts:16` passes only `{ max: 10 }`,
and the GUC appears nowhere in `node_modules/postgres` or `node_modules/drizzle-orm`.
They take the server default, which is **1** on this cluster (verified live) and
is PostgreSQL's default at ≥ 12, where any value > 0 is the shortest
exactly-round-tripping form. Safe today by inheritance. A cluster or `PGOPTIONS`
setting it to 0 would make the stored summary and a fresh reduction disagree —
at the rate the migration itself measured.

### An input where the stored summary and a fresh reduction disagree

**Found one, and it is score-inert.** A batch whose only points are `+0` and
`-0` stores `minPoints: 0` (SQL `min` then jsonb, which renders `-0` as `0`)
while `summariseCases` recomputes `-0` (`Math.min(0, -0)` is `-0`).
Demonstrated on the scratch database:

```
stored:     [{"batch": 3, "maxTotal": 1, "sumTotal": 2, "minPoints": 0, "sumPoints": 0}]
recomputed: summariseCases minPoints is -0 : true
```

`Object.is` separates them; **no consumer can**. `accumulateSubtasks` adds every
value into a `0`-initialised accumulator (`0 + -0 === 0`) and `bestSubtaskPoints`
`Math.max`es it. Both writers agree with each other — judged's
`JSON.stringify(-0)` is also `"0"` — so the disagreement is only ever between
the stored column and a JavaScript recomputation, and only ever in a bit no
score reads. Recorded, not fixed: "bit-identical across the jsonb seam" is
literally false for `-0`, and the shipped proofs' `Object.is` would fire on it.

**Two more attacked and found unreachable**: a loose sum overflowing `float8`
(Postgres raises and aborts the migration; JavaScript yields `Infinity`, which
`JSON.stringify` writes as `null` and the validator then refuses) — impossible
at real point values, which live between 0 and 60. And `NaN` points, which JSON
cannot carry over the judge protocol and which zero live rows hold.

---

## 2. Every writer of a verdict

The population is small and provable: **`EventWriter` is the only code in the
repository that sets `submissions.state` to `done` or `errored`**
(`grep "state: 'done'|'errored'"` over `apps/api/src` and `apps/judged/src`
returns `event-writer.ts` and nothing else), and **only two statements in the
repository mutate `submission_cases`** — judged's insert and `requeueAll`'s
delete.

| writer | writes the summary? | proof |
| --- | --- | --- |
| **First judging** — `finished` → `EventWriter.writeTerminal` | Yes | The summary rides the same fenced UPDATE as the verdict (`event-writer.ts:260`), from this attempt's rows read in the same transaction. `event-writer.spec.ts` compares it to `summariseCases` field by field |
| **`compileError`** → `writeTerminal` | Yes — `[]`, never null | Null means "ask the case rows"; a compile error has none and never will. Spec: "summarises an empty attempt as an empty list, never as null" |
| **`internalError`** → `writeTerminal` | Yes | Same UPDATE. **This is where defect 1 lived**: `[]` while a superseded attempt still answered `max(attempt)` |
| **`terminated`** → `writeTerminal` | Yes | Same UPDATE |
| **D29 targeted cancel** — `worker.ts:364` / `:260` calls `driver.cancel(job, attempt)`; the judge answers `submission-terminated`, which `dmoj-driver.ts:571` translates to `terminated` | Yes, by construction | Cancel writes nothing itself. It reaches the column only through `writeTerminal`, which recomputes from the current attempt's rows — so a cancel cannot leave a summary describing anything else |
| **D29 attempt fencing** | Inherited, nothing to do | `fencedById` is a subselect on `grading_jobs.attempt` inside the UPDATE's own `WHERE`. A superseded attempt matches zero rows and so sets neither verdict nor summary. Spec: "rejects an event from a superseded attempt and writes nothing" |
| **Rejudge, one submission** — `rejudgeSubmission` | Nulls it | Calls the same `requeueAll` (`rejudge.access.ts:97`) |
| **Rejudge, a whole problem** — `rejudgeProblem` | Nulls it | Calls the same `requeueAll` (`:153`) |
| `requeueAll` itself | Nulls it, in the statement that nulls the verdict, three lines above the `DELETE` of the case rows | `rejudge.access.ts:185` |
| `requeueAll`'s repair branch (job row missing → fresh job inserted) | n/a, and fails closed | The summary is already null from the UPDATE above it. The new job's `attempt` starts at 0/1; an old `ClaimedJob`'s fence subselects **that** row's attempt, so a stale write matches nothing |
| **Recompute** (`?recompute=1`, D100; `recomputeContestProblemStats`) | No, and must not | It rebuilds `contest_problem_stats` from the rows. It changes no verdict and no case row, so the summary is not stale |
| **Disqualification** | No, and must not | Writes `contest_participations.is_disqualified`. No verdict, no case row |
| **Admin submission actions** | None exist | The only mutating submission routes are the two rejudges above |
| **Lease lapse / re-claim** — `JobStore.claim` | Nothing, and that was the hazard | It bumps `attempt` and deletes nothing (`job-store.ts:122`). Nothing about the submission row changes until the regrade's first `dispatched` moves it out of a terminal state |
| **The API** | Never writes it | `grep subtask_summary` over `apps/api/src` returns the read in `contest.access.ts` and the null in `rejudge.access.ts`, nothing else |

### Defect 1 (medium) — a superseded attempt still answered `max(attempt)`

**Fixed in `dadc644`; ruled D167.**

`writeTerminal` summarises **`job.attempt`**. Every other reader of the same rows
takes the latest attempt **present**: `getVisible` (`submission.access.ts:623`,
whose own comment says a re-claimed submission has rows for more than one
attempt), `loadSubtasksFromCases`, and migration 0045's backfill. They agree
everywhere except one place: **an attempt that ends having graded no case at
all.**

Reproduction (`apps/judged/test/event-writer.spec.ts`, "leaves no superseded case
row answering max(attempt) behind it (D167)"): attempt 1 grades a batch worth 60
and is abandoned — the worker dies or its grading watchdog fires, so no terminal
event is written and the lease simply lapses. `claim` re-leases as attempt 2. The
same unhealthy judge answers `internalError` before grading anything.

Red, before the fix:

```
AssertionError: a superseded attempt still answers max(attempt):
  expected [ { attempt: 1, n: '1' } ] to deeply equal []
```

What that means to a pupil: the stored summary is `[]`, so the scoreboard scores
the submission **0**; the residue read and the backfill score it **60**; and the
submission page — the `max(attempt)` reader a pupil actually looks at — shows six
graded cases beside a scoreboard row that does not count them. Two derivations of
one number disagreeing silently is D36's shape, and it breaks the property
D165's whole safety argument rests on: that the residue read is an *equivalent*
fallback rather than a second answer.

**Fix**: the terminal write deletes this submission's rows for earlier attempts,
in the same transaction, **after** the fence — so `max(attempt)` and
`job.attempt` are the same number for every terminal submission. `requeueAll`
already deletes case rows for the same reason. D167 records that this changes a
score (0 rather than a dead attempt's partial) and why zero is the coherent
answer: the verdict is `IE`, `submissions.points` is null, and the case list is
now empty too.

**Severity medium, not high**: no live row is in this state (the attempt table
above), and reaching it needs a judge failure at both ends of one lease window.

---

## 3. The freeze, the formats, and the cache

**The freeze cannot be read through the new path.** `lower()` drops a frozen
submission at `lower.ts:265` — `participation.pending.set(...); continue;` —
**before** `subtasksOf` is ever called, so no summary of a frozen submission is
read at all, stored or residue. D165 changed what fills `SubmissionSpec.subtasks`
and nothing about when it is consulted. Confirmed additionally from the outside:
`grep -c subtask openapi.json` = **0**, and `subtaskSummary` appears nowhere in
`packages/contracts/src` or `packages/sdk/src` — the column is not on the wire at
all, so there is no route that could serve it around D22/D23's masking.

**No format loses information.** The summary's five fields are consumed by
exactly two functions and nothing else reads a group:

| format | what it reads | served by |
| --- | --- | --- |
| `default`, `icpc`, `ioi` (legacy), `legacy-ioi` | `submission.points` — `contestSubmissionPoints`, which is `accumulateSubtasks` + `pyRound` | loose group: `sumPoints`/`sumTotal`; batch: `minPoints`/`maxTotal` |
| `ioi16` | `bestSubtaskPoints` — per batch, `min` within a submission and `max` across them | `minPoints` |

`status` is mapped faithfully by `STATUS_BY_STATE` and read by no format;
per-case verdicts, case counts and `min(total)` were never read by any of them.
The one case where a *count* would matter — an absent batch versus a batch worth
zero, which `ioi16/11-missing-batch-vs-zero-batch` pins — survives because a
group with no cases produces **no row**, in `summariseCases` and in the `GROUP
BY` alike.

**D25's cache gained nothing that keys on the summary.** `scoreboardCacheKeys`
keys on contest id, privileged-vs-public, and the freeze phase — not on any
verdict or score — and the board's TTL is 2 s. The summary and the verdict are
one UPDATE, so no bust exists that could catch one and miss the other. The one
path that moves a submission *away* from terminal, `requeueAll`, invalidates
every affected board explicitly after its transaction commits
(`rejudge.access.ts:312`).

**`readSubtaskSummary([])` is accepted, not refused** — checked, because a
validator that treated the empty array as "unrecognised" would send the 13 live
compile-error submissions down the residue read on every fold forever. It
returns `[]`, and the fold stores it.

---

## Observations that are not defects

| | |
| --- | --- |
| **O1** (low) | The sessions that **read** `submission_cases.points` before summing — `writeTerminal` and the residue read — inherit `extra_float_digits` from the cluster. Nothing pins it (`client.ts:16`, and the GUC is absent from both drivers). Safe at PostgreSQL ≥ 12's default of 1, which is what the live cluster reports. The migration went to some trouble to close this door for itself and left it ajar for its two readers |
| **O2** (informational) | `-0` is normalised to `+0` crossing into jsonb, by **both** writers. Score-inert; demonstrated above |
| **O3** (low) | `contest-scoreboard-fold-plan.spec.ts` substitutes `set extra_float_digits = 3` for migration 0045's own `SET LOCAL`, so the migration's mechanism is asserted by **no test**. It does hold — drizzle wraps every migration in one transaction (`pg-core/dialect.js:60`) — but that is now verified by reading a dependency, which a drizzle upgrade can change silently |
| **O4** (informational) | Because drizzle wraps *all* pending migrations in one transaction, 0045's `SET LOCAL extra_float_digits = 3` leaks into any later migration applied in the same run. Harmless today (0045 is the newest), and worth knowing before a migration that renders a `float8` lands after it |

---

## Verification

Every new assertion demonstrated **red** first.

| Suite | Result |
| --- | --- |
| `apps/judged` (all 18 spec files, includes the new D167 test) | **138 passed** |
| `packages/contest-formats` | **125 passed** |
| `apps/api/test/rejudge.spec.ts` (container) | **8 passed** |
| `apps/api/test/contest-regrade-attempt.spec.ts` (container) | **2 passed** |
| `packages/db/test/integrity-check-script.spec.ts` (container, D168's two checks) | **1 passed** — one `it` driving the script as a subprocess over the one-of-each fixture, so it carries all **25** checks and both exit codes |

**274 passed.** `typecheck` and `lint` clean for `@duckoj/judged` and
`@duckoj/db`, plus `typecheck:scripts` and `lint:scripts`.

Reds demonstrated:

- `expected [ { attempt: 1, n: '1' } ] to deeply equal []` — defect 1, before
  the DELETE.
- `expected [ …(23) ] to deeply equal [ …(25) ]` — correcting submission 4's
  planted `sumPoints` and giving submission 2 its `[]` drops both new check ids
  from the reported set, so neither check is vacuous.

Against production: `corepack pnpm tsx scripts/integrity-check.ts --live` →
**25 checks, 0 with violations (high 0, medium 0, low 0)**.

## The databases

- **`duckoj`, live, read-only.** `SELECT` and the audit script only; every
  session opened with `default_transaction_read_only = on`. Nothing written, no
  row created, no container started, stopped or rebuilt. `apps/web/dist` was not
  touched and the web build was not run. Nothing under `.secrets/` was read,
  printed or committed.
- **`b32_scratch`, created and dropped** on the same cluster: two bare tables
  holding the 400-submission adversarial fixture of §1, plus the `to_jsonb`
  round-trip probe. `drop database b32_scratch` confirmed.
- Every command under `nice -n 19`; every container-backed spec run alone with
  `--no-file-parallelism`; **no load test**.

## What I could not finish

- **The judged writer is not proved against a live row.** Nothing has been judged
  since migration 0045 was applied, so all 880 live summaries are the backfill's.
  §4's comparison therefore says nothing about `EventWriter`'s jsonb seam; that
  rests on `event-writer.spec.ts` and on §1's probe of `JSON.stringify`. The
  first real grade after the next deploy is the first live evidence, and
  `submission-summary-disagrees-with-cases` is now standing there to read it.
- **The remaining API scoring suites were not re-run** — `contest-golden-replay`
  (24), `contest-freeze` (10), `contest-results` (47),
  `contest-scoreboard-cache` (4), `contest-scoreboard-fold-plan` (1). Under the
  thermal cap, and because this slot's code changes are confined to
  `apps/judged/src/event-writer.ts` and `scripts/integrity-check.ts`: those
  fixtures seed summaries directly and never construct an `EventWriter`, so
  nothing in them can reach the change. Stated rather than assumed.
- **O1 and O3 are recorded, not closed.** Pinning `extra_float_digits` in
  `createDb`, and asserting 0045's `SET LOCAL` rather than substituting for it,
  are both one-line changes with a test each; neither is a defect today and both
  would have been changes made without a measurement.
- **D169 is unspent.**
- **`contestWindowOpenWhere`** (D49's anti-join, `PROVINCE-READINESS.md` gap 3)
  is untouched, as it was in F-45.

## Commits

| | |
| --- | --- |
| `dadc644` | `fix(judged): a terminal write leaves no superseded attempt answering max(attempt) (D167)` |
| `257323b` | `feat(scripts): the integrity audit asks whether a stored subtask summary is still true (D168)` |
| `6e7925e` | `docs(D167,D168): the attempt every reader but one picks, and the audit that asks the rows` |
| `2ac6026` | `docs(b32): the live comparison, the writer table, and the one attempt every other reader picks` — this report |
