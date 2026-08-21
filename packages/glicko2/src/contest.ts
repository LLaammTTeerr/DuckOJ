/**
 * A contest as one Glicko-2 rating period.
 *
 * **This module consumes ranks and nothing else** (foundation spec §9). It
 * never sees points, penalties or subtasks, so adding a contest format never
 * touches rating code, and rating is testable with no contest fixture at all.
 *
 * Every other participant is one game, scored `1 / 0.5 / 0` by rank. That is
 * Glicko-2 used as designed rather than bent: a rating period containing many
 * games, updated in batch, is exactly what a contest is.
 */
import { updatePlayer } from './glicko2.js';
import type { Player } from './types.js';

export interface RankedPlayer {
  userId: number;
  /** 1-based. Ties share a rank, as every scoreboard in this project produces. */
  rank: number;
  player: Player;
}

export interface RatingChange {
  userId: number;
  rank: number;
  before: Player;
  after: Player;
}

/**
 * Below this, the field is too small for the result to mean anything
 * (foundation spec §9). Enforced here rather than by the caller so that
 * "was this contest rated" has one answer in one place.
 */
export const MIN_RATED_PARTICIPANTS = 8;

/**
 * Rates a contest, or returns `null` if the field is too small.
 *
 * `null` rather than an empty array, and rather than throwing: "this contest
 * was not rated" is an ordinary outcome a caller must handle, not an error and
 * not indistinguishable from "rated, but nobody moved".
 *
 * The caller is responsible for having already excluded virtual
 * participations, disqualified entrants and registered-but-absent users — the
 * spec's §9 rules — because each of those is a fact about *participation*,
 * which this module deliberately cannot see.
 */
export function rateContest(entries: readonly RankedPlayer[]): RatingChange[] | null {
  if (entries.length < MIN_RATED_PARTICIPANTS) return null;

  const seen = new Set<number>();
  for (const entry of entries) {
    if (seen.has(entry.userId)) {
      throw new Error(`duplicate userId in ranking: ${String(entry.userId)}`);
    }
    seen.add(entry.userId);
  }

  // Every update reads the *pre-contest* ratings of every opponent. Computing
  // them in place, so that a player rated early in the loop influenced the
  // opponents of one rated later, would make the result depend on iteration
  // order — the same trap as reading a scoreboard while writing it.
  return entries.map((entry) => ({
    userId: entry.userId,
    rank: entry.rank,
    before: entry.player,
    after: updatePlayer(
      entry.player,
      entries
        .filter((other) => other.userId !== entry.userId)
        .map((other) => ({ opponent: other.player, score: scoreAgainst(entry.rank, other.rank) })),
    ),
  }));
}

/** `1` for finishing ahead, `0.5` for a tie, `0` for behind. */
function scoreAgainst(rank: number, opponentRank: number): number {
  if (rank < opponentRank) return 1;
  if (rank > opponentRank) return 0;
  return 0.5;
}
