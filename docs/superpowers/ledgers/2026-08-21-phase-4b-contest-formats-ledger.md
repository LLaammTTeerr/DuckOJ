# Phase 4b decision ledger — contest formats

Four formats as pure functions over 4a's fixture shape. **23/23 goldens pass**,
27 tests. `packages/contest-formats` depends on **nothing** — verified: its
manifest has no dependencies at all, in-repo or otherwise.

| Deferred | Ruling |
|---|---|
| **`legacy_ioi`'s `Min(date)` vs `Max(date)` tiebreak among submissions tied at the best score.** No fixture distinguishes them — no participant holds their maximum twice | R3. Left for a **generator-produced** scenario in 4a's harness; hand-writing a golden would break 4a's provenance, which is the property that makes the corpus trustworthy at all |
| `frozen_last_minutes > 0` throws by design | `is_frozen` reads the wall clock, so no deterministic golden can cover it. Freeze behaviour needs an injected clock and its own scenarios — carried from 4a |
| Contest schema, endpoints, scoreboard API, any UI | Phase 4c. This phase deliberately creates none, so the riskiest code is verified before a table exists |
| Two upstream bugs, reproduced rather than fixed | R4 |

---

## R1 — the harness was proved to fail, five different ways

Not one perturbation but five, each reddening **exactly** the goldens that pin
that rule and no others:

    icpc penalty (tries-1) -> tries           7 failed, 20 passed
    ioi16 cross-submission max -> last-wins   4 failed (05, 09, 11, the R7 test)
    ioi16 unbatched cases skipped             1 failed (11 only)
    default cumtime at best time not last     2 failed (01, 06)
    legacy_ioi zero-score records its time    1 failed (01)
    reverted                                  27 passed

The precision is the evidence. A harness where one perturbation reddens
everything proves only that it runs; one where each rule has a distinct
signature proves the goldens are pinning *different* things.

Note the first line: `icpc/01-nobody-solves` stayed green under the penalty
perturbation, correctly — the accumulator lives inside `if points:`, so a
contest nobody solves has no penalty to get wrong.

## R2 — my spec's stated trap was false, and the implementer proved it

I wrote: *"an absent batch is not a zero batch — a default-zero map passes
scenario 09 and fails 11."*

That is wrong. Cross-submission aggregation is `max`, and `max(x, 0) === x` for
non-negative points, so absent-versus-zero is **arithmetically
indistinguishable**. The implementer built the faithful form, then deliberately
broke it the way I described, and **all 23 still passed**.

What fixture 11 actually pins is different: `batch: null` folding into batch 0
as a *min*-batch. Skipping unbatched cases gives alice 90 rather than 100.

Fifteenth spec or brief defect across five phases. This one is worse than the
usual shape — I did not merely describe a file I had not opened, I asserted a
*behavioural* trap without checking the arithmetic, and had it been believed it
would have sent an implementer hunting a bug that cannot exist.

## R3 — a coverage gap reported instead of papered over

`legacy_ioi` times a problem at `Min(date)` among submissions tied at the best
score. Changing that to `Max(date)` breaks nothing, because no fixture has a
participant achieving their maximum twice.

The implementer could have hand-written a fixture and closed the gap. It did
not, and was right: 4a's goldens are trustworthy *because* every number came
from executing DMOJ's own code with recorded provenance. A hand-derived golden
in that corpus would look identical and mean something entirely different.
Left for a generator-produced scenario.

## R4 — upstream bugs reproduced deliberately, and one is broader than 4a found

As instructed, the formats reproduce DMOJ's behaviour including what is almost
certainly unintended:

- `default` penalises post-accept junk submissions, because cumtime is an
  independent aggregate from points.
- **Neither `icpc` nor `default` filters by contest end.** 4a's R6 recorded
  this for `icpc` only; implementing both surfaced that `default` shares it.

Both are documented in the format modules themselves, where the next reader
meets them. Matching the old system exactly is the point of this phase;
diverging is a product decision for later, recorded rather than smuggled in.

## R5 — a small brief inaccuracy, worth noting only for the pattern

I told the implementer the sibling packages have a `pretest` script. They do
not — their shape is `test: tsc -b && vitest run`. It matched the real shape
rather than the described one. That is the sixteenth time; every instance is
me describing a file's contents from memory.
