/**
 * Glickman's own worked example — "Example of the Glicko-2 system" — used as
 * the test corpus for the numerically delicate part of this package.
 *
 * The foundation spec (§9, and §"oracle harness") chose Glicko-2 partly *for*
 * this: the author published intermediate and final values, so the volatility
 * iteration can be proved correct against the person who defined it rather
 * than against our own reimplementation of it.
 *
 * The paper's setup: a player rated 1500 with RD 200 and volatility 0.06,
 * playing three opponents in one rating period, with τ = 0.5.
 *
 *   opponent   rating   RD    score
 *   1          1400     30    1
 *   2          1550     100   0
 *   3          1700     300   0
 *
 * The paper reports the result to two decimal places, which is the precision
 * every assertion below is written to.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLAYER,
  SCALE,
  TAU,
  applyInactivity,
  updatePlayer,
  updatePlayerDetailed,
} from '../src/index.js';
import type { Game, Player } from '../src/index.js';

const SUBJECT: Player = { rating: 1500, rd: 200, volatility: 0.06 };

const GAMES: Game[] = [
  { opponent: { rating: 1400, rd: 30, volatility: 0.06 }, score: 1 },
  { opponent: { rating: 1550, rd: 100, volatility: 0.06 }, score: 0 },
  { opponent: { rating: 1700, rd: 300, volatility: 0.06 }, score: 0 },
];

describe("Glickman's published example", () => {
  const result = updatePlayer(SUBJECT, GAMES);
  const detail = updatePlayerDetailed(SUBJECT, GAMES);

  it('τ is 0.5, the value the example is computed with', () => {
    // Not a tautology worth skipping: every number below is only correct for
    // this τ, so a change to it must break loudly here rather than silently
    // shift every rating in the system.
    expect(TAU).toBe(0.5);
  });

  // Each step against the author's own figure, rather than only the final
  // rating — which would leave the pipeline verified at a single point.
  //
  // Two precisions appear below, for a reason worth stating. The paper prints
  // its intermediate `E` values to **three** decimals, and computes `v` and
  // `Δ` from those rounded figures; recomputing them at full precision gives
  // 1.7790 and -0.4839 against the paper's 1.7785 and -0.4834. That is the
  // paper's rounding, not a disagreement — every quantity downstream of them
  // (`φ*`, `φ'`, `μ'`) matches to all four decimals the paper prints.
  // Explicit bounds rather than `toBeCloseTo(x, n)`, whose tolerance is
  // 0.5 × 10⁻ⁿ and so cannot express "within one unit of the last printed
  // digit" — which is exactly the claim being made about a rounded figure.
  it("matches the paper's v = 1.7785 to within its own rounding", () => {
    expect(Math.abs(detail.v - 1.7785)).toBeLessThan(0.001);
  });

  it("matches the paper's Δ = -0.4834 to within its own rounding", () => {
    expect(Math.abs(detail.delta - -0.4834)).toBeLessThan(0.001);
  });

  it("matches the paper's φ* = 1.1528 to within its own rounding", () => {
    expect(Math.abs(detail.phiStar - 1.1528)).toBeLessThan(0.0001);
  });

  it("matches the paper's φ' = 0.8722 exactly at four decimals", () => {
    expect(detail.phiPrime).toBeCloseTo(0.8722, 4);
  });

  it("matches the paper's μ' = -0.2069 exactly at four decimals", () => {
    expect(detail.muPrime).toBeCloseTo(-0.2069, 4);
  });

  it("produces the paper's new rating deviation of 151.52", () => {
    // Unrounded on both sides: this one lands on the paper's figure exactly.
    expect(result.rd).toBeCloseTo(151.52, 2);
  });

  it("produces the paper's new volatility of 0.059996", () => {
    // The volatility iteration is the one part of Glicko-2 with no closed
    // form, and this single number is why this package is verified against
    // the author rather than against itself. The paper prints `0.05999`,
    // which is this value truncated at five decimals.
    expect(detail.volatility).toBeCloseTo(0.059996, 6);
  });

  it("produces the paper's new rating of 1464.06, to the precision μ' supports", () => {
    // The paper reports 1464.06. Computed from its own rounded μ' = -0.2069:
    //   1500 + 173.7178 × (-0.2069) = 1464.062
    // Carrying μ' unrounded gives 1464.0507. The difference is entirely the
    // paper's rounding of μ', which the assertion above pins independently —
    // so this is checked against the paper's figure with the tolerance that
    // rounding implies, rather than against a number we chose.
    expect(result.rating).toBeCloseTo(1464.06, 1);
    expect(result.rating).toBeCloseTo(1500 + SCALE * detail.muPrime, 10);
  });

  it('refuses to report intermediates for a period with no games', () => {
    expect(() => updatePlayerDetailed(SUBJECT, [])).toThrow();
  });
});

describe('the scale conversion', () => {
  it('leaves a default player at 1500 when nothing happens to them', () => {
    // Round-trips the display/internal conversion: an inactive period changes
    // RD and nothing else, so any drift in `rating` here is a conversion bug.
    const idle = updatePlayer({ rating: 1500, rd: 200, volatility: 0.06 }, []);
    expect(idle.rating).toBeCloseTo(1500, 10);
    expect(idle.volatility).toBe(0.06);
  });

  it('uses the published scale factor', () => {
    expect(SCALE).toBeCloseTo(173.7178, 4);
  });
});

describe('inactivity', () => {
  it('grows the deviation and moves nothing else', () => {
    // Glickman step 6 standing alone: φ* = sqrt(φ² + σ²). This is what makes
    // a returning user's rating move quickly again instead of staying frozen
    // at a stale value (foundation spec §9).
    const start: Player = { rating: 1500, rd: 200, volatility: 0.06 };
    const after = updatePlayer(start, []);
    expect(after.rd).toBeGreaterThan(start.rd);
    expect(after.rating).toBeCloseTo(start.rating, 10);
    expect(after.volatility).toBe(start.volatility);
    // sqrt(200² + (0.06 × 173.7178)²) — computed in the internal scale, so the
    // growth is small at large RD and this is not merely "it went up".
    const phi = start.rd / SCALE;
    const expected = SCALE * Math.sqrt(phi * phi + start.volatility * start.volatility);
    expect(after.rd).toBeCloseTo(expected, 10);
  });

  it('compounds over periods, and is monotonic', () => {
    const start: Player = { rating: 1500, rd: 100, volatility: 0.06 };
    const one = applyInactivity(start, 1);
    const five = applyInactivity(start, 5);
    expect(five.rd).toBeGreaterThan(one.rd);
    expect(applyInactivity(start, 0)).toEqual(start);
    expect(five.rating).toBeCloseTo(1500, 10);
  });

  it('refuses a negative or fractional number of periods', () => {
    expect(() => applyInactivity(DEFAULT_PLAYER, -1)).toThrow();
    expect(() => applyInactivity(DEFAULT_PLAYER, 1.5)).toThrow();
  });
});

describe('directional sanity, which the example alone does not pin', () => {
  // The published example is a single point. These say the function behaves
  // like a rating system either side of it — a sign error that happened to
  // reproduce 1464.06 is not possible, but a sign error elsewhere is.
  it('beating a stronger player raises the rating more than beating a weaker one', () => {
    const beatStrong = updatePlayer(SUBJECT, [
      { opponent: { rating: 1800, rd: 50, volatility: 0.06 }, score: 1 },
    ]);
    const beatWeak = updatePlayer(SUBJECT, [
      { opponent: { rating: 1200, rd: 50, volatility: 0.06 }, score: 1 },
    ]);
    expect(beatStrong.rating).toBeGreaterThan(beatWeak.rating);
    expect(beatWeak.rating).toBeGreaterThan(SUBJECT.rating);
  });

  it('losing lowers the rating, and losing to a weaker player lowers it more', () => {
    const lostToStrong = updatePlayer(SUBJECT, [
      { opponent: { rating: 1800, rd: 50, volatility: 0.06 }, score: 0 },
    ]);
    const lostToWeak = updatePlayer(SUBJECT, [
      { opponent: { rating: 1200, rd: 50, volatility: 0.06 }, score: 0 },
    ]);
    expect(lostToWeak.rating).toBeLessThan(lostToStrong.rating);
    expect(lostToStrong.rating).toBeLessThan(SUBJECT.rating);
  });

  it('playing at all shrinks the deviation', () => {
    // The point of RD: evidence reduces uncertainty. An implementation that
    // grew it after a played period would still pass the example if it got
    // the arithmetic right by accident elsewhere.
    expect(updatePlayer(SUBJECT, GAMES).rd).toBeLessThan(SUBJECT.rd);
  });

  it('an uncertain opponent moves the rating less than a well-known one', () => {
    // g(φ) exists precisely to do this, and nothing in the published example
    // isolates it.
    const vsKnown = updatePlayer(SUBJECT, [
      { opponent: { rating: 1600, rd: 30, volatility: 0.06 }, score: 1 },
    ]);
    const vsUnknown = updatePlayer(SUBJECT, [
      { opponent: { rating: 1600, rd: 350, volatility: 0.06 }, score: 1 },
    ]);
    expect(vsKnown.rating).toBeGreaterThan(vsUnknown.rating);
  });
});
