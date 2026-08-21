/**
 * The Glicko-2 rating period update, following Glickman's
 * "Example of the Glicko-2 system" step for step.
 *
 * The step numbers in the comments below are his, so the code can be read
 * beside the paper. The delicate part is step 5 — solving for the new
 * volatility — which has no closed form and is done with the Illinois variant
 * of regula falsi, exactly as the paper prescribes. That step is why this
 * package exists as its own verifiable unit rather than as a function
 * somewhere in the API.
 */
import { SCALE, TAU, type Game, type Player } from './types.js';

/** Step 2: display scale to internal scale. */
function toInternal(player: Player): { mu: number; phi: number } {
  return { mu: (player.rating - 1500) / SCALE, phi: player.rd / SCALE };
}

/** Step 8: internal scale back to display scale. */
function toDisplay(mu: number, phi: number, volatility: number): Player {
  return { rating: SCALE * mu + 1500, rd: SCALE * phi, volatility };
}

/** g(φ) — how much an opponent's own uncertainty damps the result. */
function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

/** E(μ, μⱼ, φⱼ) — the expected score against one opponent. */
function expectedScore(mu: number, muJ: number, phiJ: number): number {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

/**
 * Step 5: solve f(x) = 0 for the new volatility, by the Illinois algorithm.
 *
 * Plain regula falsi can keep one endpoint fixed forever and converge
 * linearly; the Illinois variant halves the stale endpoint's function value,
 * which restores superlinear convergence. Glickman specifies this variant by
 * name, and the iteration below is his §5 verbatim — including the `B`
 * bracket search, which matters when Δ² is small relative to φ² + v.
 */
function solveVolatility(sigma: number, phi: number, v: number, delta: number): number {
  const EPSILON = 0.000001;
  const a = Math.log(sigma * sigma);
  const deltaSq = delta * delta;
  const phiSq = phi * phi;

  const f = (x: number): number => {
    const ex = Math.exp(x);
    const num = ex * (deltaSq - phiSq - v - ex);
    const den = 2 * (phiSq + v + ex) * (phiSq + v + ex);
    return num / den - (x - a) / (TAU * TAU);
  };

  let A = a;
  let B: number;
  if (deltaSq > phiSq + v) {
    B = Math.log(deltaSq - phiSq - v);
  } else {
    // Walk down in steps of τ until f is negative — the paper's bracketing
    // for the case where Δ² does not already exceed φ² + v.
    let k = 1;
    while (f(a - k * TAU) < 0) k += 1;
    B = a - k * TAU;
  }

  let fA = f(A);
  let fB = f(B);
  // Glickman's iteration converges in a handful of steps, so this bound is
  // never reached in practice. It exists because the alternative failure mode
  // is a hang: removing the Illinois halving below turns this into plain
  // regula falsi, which on this problem keeps one endpoint fixed and loops
  // forever. That was observed, not theorised — a mutation test removed the
  // halving and the suite stopped responding rather than failing. A rating
  // computation that wedges a worker is worse than one that reports an error.
  const MAX_ITERATIONS = 1000;
  let iterations = 0;
  while (Math.abs(B - A) > EPSILON) {
    iterations += 1;
    if (iterations > MAX_ITERATIONS) {
      throw new Error(
        `Glicko-2 volatility iteration failed to converge after ${String(MAX_ITERATIONS)} steps ` +
          `(sigma=${String(sigma)}, phi=${String(phi)}, v=${String(v)}, delta=${String(delta)})`,
      );
    }
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      // The Illinois halving. Without it this is plain regula falsi and
      // converges linearly on one-sided problems.
      fA = fA / 2;
    }
    B = C;
    fB = fC;
  }
  return Math.exp(A / 2);
}

/**
 * One rating period for one player.
 *
 * `games` empty is **not** an error: it is Glickman's step 6 special case, an
 * inactive period, where the rating and volatility are unchanged and only the
 * deviation grows. That is what models inactivity, and it is why this function
 * accepts the empty list rather than rejecting it.
 */
/**
 * The intermediate quantities of one rating period, in the internal scale.
 *
 * Exported because they are exactly the numbers Glickman prints in his worked
 * example. Checking only the final rating would leave the pipeline verified at
 * one point; checking `v`, `delta`, `phiStar`, `phiPrime` and `muPrime`
 * verifies each step against the author's own figures, which is the oracle the
 * foundation spec chose Glicko-2 partly in order to have.
 */
export interface PeriodDetail {
  /** Step 3 — estimated variance from game outcomes alone. */
  v: number;
  /** Step 4 — estimated improvement, internal scale. */
  delta: number;
  /** Step 5 — the new volatility. */
  volatility: number;
  /** Step 6 — pre-period deviation. */
  phiStar: number;
  /** Step 7 — the updated deviation and rating, internal scale. */
  phiPrime: number;
  muPrime: number;
  /** Step 8 — the same result in display units. */
  player: Player;
}

/** `updatePlayer`, also returning the intermediates. Played periods only. */
export function updatePlayerDetailed(player: Player, games: readonly Game[]): PeriodDetail {
  if (games.length === 0) throw new Error('an inactive period has no intermediates to report');
  const { mu, phi } = toInternal(player);

  let vInverse = 0;
  let deltaSum = 0;
  for (const game of games) {
    const opponent = toInternal(game.opponent);
    const gPhi = g(opponent.phi);
    const e = expectedScore(mu, opponent.mu, opponent.phi);
    vInverse += gPhi * gPhi * e * (1 - e);
    deltaSum += gPhi * (game.score - e);
  }
  const v = 1 / vInverse;
  const delta = v * deltaSum;
  const volatility = solveVolatility(player.volatility, phi, v, delta);
  const phiStar = Math.sqrt(phi * phi + volatility * volatility);
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muPrime = mu + phiPrime * phiPrime * deltaSum;

  return { v, delta, volatility, phiStar, phiPrime, muPrime, player: toDisplay(muPrime, phiPrime, volatility) };
}

export function updatePlayer(player: Player, games: readonly Game[]): Player {
  const { mu, phi } = toInternal(player);

  if (games.length === 0) {
    // Step 6, standing alone: φ* = sqrt(φ² + σ²).
    const phiStar = Math.sqrt(phi * phi + player.volatility * player.volatility);
    return toDisplay(mu, phiStar, player.volatility);
  }

  // Steps 3 through 8 live in `updatePlayerDetailed`, so the function the
  // system calls and the function the paper is checked against cannot drift.
  return updatePlayerDetailed(player, games).player;
}

/**
 * Ages a player through `periods` of inactivity.
 *
 * Repeated application of step 6, which is exactly what Glicko-2 does to a
 * player who sits out. Separate from `updatePlayer` because a contest is our
 * rating period, so "time passed" is not something the algorithm can infer —
 * a caller with a clock has to say how many periods elapsed.
 */
export function applyInactivity(player: Player, periods: number): Player {
  if (!Number.isInteger(periods) || periods < 0) {
    throw new Error(`periods must be a non-negative integer, got ${String(periods)}`);
  }
  let current = player;
  for (let i = 0; i < periods; i += 1) current = updatePlayer(current, []);
  return current;
}
