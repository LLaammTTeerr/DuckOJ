/**
 * Glicko-2, and a contest treated as one rating period.
 *
 * Depends on nothing — not on this repository, not on npm. The numerically
 * delicate part (the volatility iteration of Glickman's step 5) is verified
 * against the author's own published worked example, so this is proved rather
 * than believed. See `test/glickman.spec.ts`.
 */
export type { Game, Player } from './types.js';
export { DEFAULT_PLAYER, SCALE, TAU } from './types.js';
export { applyInactivity, updatePlayer, updatePlayerDetailed } from './glicko2.js';
export type { PeriodDetail } from './glicko2.js';
export { MIN_RATED_PARTICIPANTS, rateContest } from './contest.js';
export type { RankedPlayer, RatingChange } from './contest.js';
