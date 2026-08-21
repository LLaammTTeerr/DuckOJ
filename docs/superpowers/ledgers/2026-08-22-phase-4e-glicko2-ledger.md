# Phase 4e — Glicko-2: ledger

**Spec:** foundation design §9 (the rating rules were settled there; this phase
implements them and adds no new product decisions).

**Result:** 721 tests green (was 693). New package `packages/glicko2`,
depending on nothing — not this repository, not npm.

---

## R1 — Glicko-2, not DMOJ's rating system, and the spec already said why

The old system does **not** use Glicko-2. `judge/ratings.py` is 248 lines of a
custom tanh-based system solved by bisection. So the porting-with-goldens
method that carried 4a–4c does not apply here, and I checked the spec before
assuming it did.

Foundation §9 chose Glicko-2 deliberately and named its verification strategy:

> Glickman published a worked numerical example, giving us test vectors from
> the author for the numerically delicate part … We can prove the
> implementation correct rather than believe it.

and §"oracle harness" says the DMOJ corpus is **not needed for rating** for
exactly this reason. This is a decision already made, with a stated oracle, so
this phase implements it rather than reopening it.

The consequence worth stating plainly: **imported historical ratings from the
old system will not be reproducible.** That is inherent in choosing a different
rating system and was accepted when §9 was written.

## R2 — verified step by step against the author, not only at the end

Checking only the final rating would verify the pipeline at a single point. So
`updatePlayerDetailed` exports the intermediates — `v`, `Δ`, `σ'`, `φ*`, `φ'`,
`μ'` — because those are precisely the quantities Glickman prints.

`updatePlayer` delegates to it, so the function the system calls and the
function the paper is checked against cannot drift.

## R3 — the paper's printed figures are rounded, and the tests say so

Our results against Glickman's:

| Quantity | Ours | Paper |
|---|---|---|
| `v` | 1.7790 | 1.7785 |
| `Δ` | −0.4839 | −0.4834 |
| `φ*` | 1.15285 | 1.1528 |
| `φ'` | 0.8722 | 0.8722 |
| `μ'` | −0.2069 | −0.2069 |
| `RD'` | 151.52 | 151.52 |
| rating | 1464.05 | 1464.06 |

The two disagreements are the paper's own rounding, and the table shows why:
the paper prints its `E` values to **three** decimals and computes `v` and `Δ`
from those, while everything downstream — `φ*`, `φ'`, `μ'`, `RD'` — matches to
every digit printed. The final rating follows: `1500 + 173.7178 × (−0.2069)`
is 1464.06 with the paper's rounded `μ'`, and 1464.05 carrying it unrounded.

**The first version of this test failed**, and the honest move was to find out
why rather than widen the tolerance until it passed. The tests now assert the
rounded quantities with explicit bounds — `Math.abs(x − published) < 0.001` —
rather than `toBeCloseTo(x, n)`, whose tolerance is `0.5 × 10⁻ⁿ` and cannot
express "within one unit of the last printed digit".

## R4 — a mutation that hung instead of failing, and the guard it earned

Removing the Illinois halving from the volatility iteration did not redden the
suite. **It wedged it** — plain regula falsi keeps one endpoint fixed on this
problem and the loop never terminates. The test run had to be killed.

That is a real finding about the production code, not just about the test: a
rating computation that hangs takes a worker with it and reports nothing. Added
a 1000-iteration bound that throws with the inputs in the message. Glickman's
iteration converges in a handful of steps, so the bound is unreachable in
practice; it exists to turn a hang into a diagnosable error.

With the guard in place the same mutation reddens 9 of 10 tests, loudly.

## R5 — a test that moved with the constant it was testing

`MIN_RATED_PARTICIPANTS` is 8. My boundary test read its field sizes from the
constant — `field(MIN_RATED_PARTICIPANTS - 1)` and `field(MIN_RATED_PARTICIPANTS)`
— so setting the constant to 1 moved the test with it and **the mutation
survived a green suite**.

Now pinned to the literal, with the boundary written as 7 and 8, and a separate
assertion that the constant is 8. Same shape as the scope vocabulary pin: a
threshold that decides whether a contest counts has to be checkable against the
spec by a reader, not defined in terms of itself.

This is the second self-referential test I have written in two days. The tell is
the same both times: the test imports the thing it is meant to constrain.

## R6 — order independence is a property, and it is tested as one

Every player's update reads the **pre-contest** ratings of every opponent. An
implementation that updated in place would let a player rated early influence
the opponents of one rated later, and the result would silently depend on
iteration order.

Tested by rating the same field forwards and reversed and requiring identical
output — a bug invisible in any single run.

## R7 — mutation evidence

| Mutation | Result |
|---|---|
| M1 volatility never updated | 1 fail |
| M2 `g(φ)` ignores opponent uncertainty | 7 fail |
| M3 Illinois halving removed | **hung; see R4**, then 9 fail with the guard |
| M4 score direction inverted | 2 fail |
| M5 minimum field size removed | **survived; see R5**, then 2 fail after the fix |
| M6 `φ*` ignores volatility | 4 fail |

Two of six exposed defects in my own tests rather than confirming them.

## Deferred to the persistence phase

**`rating_event` and the fold.** Foundation §9 requires the whole history to be
recomputable from scratch, deterministically, because unrating a contest or
disqualifying someone late means replaying forward. That is a schema and a
worker, and it is the next phase.

**Inactivity needs a clock.** `applyInactivity` is here and pure, but a contest
is our rating period, so "how much time passed" is not something the algorithm
can infer. Whether RD decays per elapsed month, per missed rated contest, or
not at all is a product decision the persistence phase has to make.

**The §9 participation rules** — virtual never rated, zero-submission entrants
excluded, disqualified excluded — are facts about participation, which this
package deliberately cannot see. The caller filters; `rateContest` documents it.
