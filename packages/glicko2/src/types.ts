/**
 * Glicko-2, in the units the algorithm is defined in.
 *
 * A `Player` is stored in the *display* scale — rating around 1500, RD in the
 * same units — because that is what a database column and a profile page hold.
 * The algorithm works in an internal scale (`mu`, `phi`) and converts at both
 * ends; keeping the conversion inside one module means no caller ever has to
 * know the factor 173.7178 exists.
 */
export interface Player {
  rating: number;
  /** Rating deviation: the uncertainty in `rating`. */
  rd: number;
  /** Volatility: how erratic this player's results are. */
  volatility: number;
}

/** One game inside a rating period, from the rated player's point of view. */
export interface Game {
  opponent: Player;
  /** `1` win, `0.5` draw, `0` loss. Nothing else is meaningful. */
  score: number;
}

/** Glicko-2's defaults, and the foundation spec's §9 table. */
export const DEFAULT_PLAYER: Player = { rating: 1500, rd: 350, volatility: 0.06 };

/**
 * The system constant τ, constraining volatility change between periods.
 *
 * Glickman: "reasonable choices are between 0.3 and 1.2, smaller values
 * prevent volatility from changing by large amounts". `0.5` is the value used
 * throughout his worked example, which is the corpus this implementation is
 * verified against — changing it would invalidate every published test vector
 * this package is checked with.
 */
export const TAU = 0.5;

/** Glicko-2's scale factor between display and internal units. */
export const SCALE = 173.7178;
