# Phase 4b — Contest formats: design

**Status:** approved for implementation.
**Predecessors:** `2026-08-21-phase-4a-contest-goldens-design.md` and its ledger
(`docs/superpowers/ledgers/2026-08-21-phase-4a-contest-goldens-ledger.md` —
**read R6 and R7 before writing any code**).

---

## 1. The shape this phase takes, and why

Phase 4a froze 23 scoreboards from DMOJ's real `update_participation()`. Each
fixture is a self-contained pair: a `contest.json` of inputs and a
`scoreboard.json` of outputs, with no database in either.

That input shape **is** the format interface. So:

> **The four formats are pure functions from the fixture's input shape to the
> fixture's output shape.** No database, no ORM, no Nest, no I/O.

This is not an aesthetic preference. It buys three things:

- Every one of the 23 goldens becomes a unit test that runs in milliseconds.
- A golden mismatch points at a **format**, never at a query — which is the
  whole reason 4a was built.
- The riskiest code in the system is testable before any contest table exists.

Consequently **this phase creates no schema, no endpoint, and no UI.** Mapping
database rows into the input shape is Phase 4c's job, and it is independently
testable. Splitting here front-loads the risk: the part that can silently
mis-score a contest lands first, fully verified.

## 2. Where it lives

`packages/contest-formats` — a new workspace package depending on **nothing**
in this repo and nothing outside it beyond TypeScript. Not `apps/api`, not
`packages/db`. A format that can reach a database will eventually read one.

```
packages/contest-formats/
  src/
    types.ts      the input and output shapes, mirroring the fixtures exactly
    default.ts    icpc.ts    legacy-ioi.ts    ioi16.ts
    index.ts      a registry keyed by the same strings the fixtures use
  test/
    goldens.spec.ts   runs every fixture under fixtures/contest-goldens/
```

## 3. What the formats must do

Authoritative descriptions are in **4a's ledger R6**. Reproduced here only as a
checklist; where this section and R6 differ, **R6 wins** — it was written from
the executing code.

- **`default`** — `max(points)` per problem. Cumtime sums the *last* submission
  time on scored problems, as an **independent aggregate** from points: a junk
  submission after an accept **raises** the penalty. Tiebreaker always 0.
- **`icpc`** — same score. Cumtime = minute-floored solve times +
  `(tries − 1) × 20`, over **solved problems only**; CE, IE, null-result and
  post-accept submissions cost nothing. Tiebreaker = largest solve minute.
  **Nothing filters by contest end.**
- **`legacy_ioi`** — best *submission* per problem, timed at `min(date)` among
  ties. Cumtime, tiebreaker and first-solve are config-gated; under the default
  config `first_solve` is null for everyone.
- **`ioi16`** — best result **per batch across submissions**: `min` within a
  batch, `max` across submissions, and **an absent batch is not a zero**. Each
  batch scaled by `problem.points ÷ batch total`, summed, then rounded.
  Cumtime, tiebreaker and all times are 0.

**R7 is the acceptance test for whether this phase understood the job.**
`ioi16/09` and `legacy_ioi/09` hold byte-identical submissions and must produce
100 and 60. An implementation reading "best score per problem" passes the other
22 and fails these.

## 4. Testing

1. **All 23 goldens pass**, driven by enumerating the fixture directory rather
   than a hand-written list — a hard-coded list silently stops covering a
   fixture someone adds later.
2. **Compare whole objects, not selected fields.** Assert the computed
   scoreboard deep-equals the golden's `ranking` and `problems`, so a format
   that gets `score` right and `format_data` wrong still fails.
3. **The comparison must be shown to fail.** Perturb one format's arithmetic and
   confirm the specific goldens go red. A harness that passes against broken
   code is worse than no harness, and this project has shipped that three times.
4. **The R7 pair asserted explicitly**, by name, with the 100-vs-60 expectation
   written in the test — not merely covered by the directory sweep. It is the
   one case worth failing loudly and by name.
5. **Float comparison must match 4a's normalisation** — nine decimal places.
   Not `toBe` on floats.

## 5. Risks

**The fixtures encode DMOJ's behaviour, including its bugs.** `icpc` not
filtering by contest end is almost certainly unintended upstream, and `default`
penalising post-accept submissions is arguably one too. Phase 4b reproduces
them anyway: matching the old system exactly is the point, and *deliberately*
diverging is a product decision for later, recorded rather than smuggled in as
a fix. If an implementer believes a golden is wrong, they must say so and
implement it as-is regardless.

**`absent batch ≠ zero batch`** in `ioi16` is the subtlest rule here and has its
own fixture (`11-missing-batch-vs-zero-batch`). An implementation using a
default-zero map passes scenario 09 and fails 11.

**Rounding.** `points_precision` is per-contest and applies at the end, not per
problem. Rounding early accumulates differently and will pass small scenarios.
