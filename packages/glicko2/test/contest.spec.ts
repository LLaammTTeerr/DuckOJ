/**
 * A contest as one rating period.
 *
 * `glickman.spec.ts` proves the arithmetic against the author. This file
 * proves the mapping from a ranking onto it — which is where a rating system
 * usually goes wrong in ways the mathematics cannot catch.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAYER, MIN_RATED_PARTICIPANTS, rateContest } from '../src/index.js';
import type { Player, RankedPlayer } from '../src/index.js';

/** `n` distinct players, all at the default, ranked 1..n. */
function field(n: number, player: Player = DEFAULT_PLAYER): RankedPlayer[] {
  return Array.from({ length: n }, (_, i) => ({ userId: i + 1, rank: i + 1, player }));
}

describe('rateContest', () => {
  it('pins the minimum field size at 8', () => {
    // The literal, not `MIN_RATED_PARTICIPANTS`, and this is the whole point:
    // the boundary test below first read its field size from the constant, so
    // changing the constant moved the test with it and the mutation survived.
    // A threshold that decides whether a contest counts must be pinned to a
    // number a reader can check against the spec (foundation §9).
    expect(MIN_RATED_PARTICIPANTS).toBe(8);
  });

  it('returns null with 7 entrants and rates with 8', () => {
    // `null`, not `[]`: "this contest was not rated" is an ordinary outcome a
    // caller must handle, and must not be indistinguishable from "rated, but
    // nobody moved".
    expect(rateContest(field(7))).toBeNull();
    expect(rateContest(field(8))).toHaveLength(8);
  });

  it('raises the winner and lowers the last place', () => {
    const changes = rateContest(field(10))!;
    const first = changes[0]!;
    const last = changes.at(-1)!;
    expect(first.after.rating).toBeGreaterThan(first.before.rating);
    expect(last.after.rating).toBeLessThan(last.before.rating);
  });

  it('orders the outcome by rank — every place beats the one below it', () => {
    const changes = rateContest(field(12))!;
    for (let i = 1; i < changes.length; i += 1) {
      expect(changes[i - 1]!.after.rating, `rank ${String(i)} vs ${String(i + 1)}`).toBeGreaterThan(
        changes[i]!.after.rating,
      );
    }
  });

  it('gives an all-tie contest no rating movement at all', () => {
    // Everyone drawing everyone is a period of pure information about
    // uncertainty and none about skill: ratings must not move, though the
    // deviation may. A sign error in `scoreAgainst` breaks this immediately.
    const tied = field(10).map((entry) => ({ ...entry, rank: 1 }));
    for (const change of rateContest(tied)!) {
      expect(change.after.rating).toBeCloseTo(change.before.rating, 6);
    }
  });

  it('treats a tie as half a win: two tied players finish equal', () => {
    const entries = field(10).map((entry) =>
      entry.rank === 4 || entry.rank === 5 ? { ...entry, rank: 4 } : entry,
    );
    const changes = rateContest(entries)!;
    const [a, b] = changes.filter((change) => change.rank === 4);
    expect(a!.after.rating).toBeCloseTo(b!.after.rating, 10);
  });

  it('does not depend on the order entries are supplied in', () => {
    // Every update must read the *pre-contest* rating of every opponent. An
    // implementation that updated in place would make a player rated early
    // influence the opponents of one rated later, and the result would depend
    // on iteration order — a bug that is invisible in any single run.
    const entries = field(10);
    const forward = rateContest(entries)!;
    const reversed = rateContest([...entries].reverse())!;
    for (const change of forward) {
      const same = reversed.find((other) => other.userId === change.userId)!;
      expect(same.after.rating, `user ${String(change.userId)}`).toBeCloseTo(
        change.after.rating,
        10,
      );
    }
  });

  it('is a pure function of its input: the supplied players are not mutated', () => {
    const entries = field(10);
    const snapshot = entries.map((entry) => ({ ...entry.player }));
    rateContest(entries);
    expect(entries.map((entry) => entry.player)).toEqual(snapshot);
  });

  it('rejects a duplicated user rather than rating them twice', () => {
    const entries = field(10);
    entries[3] = { ...entries[3]!, userId: entries[0]!.userId };
    expect(() => rateContest(entries)).toThrow(/duplicate/);
  });

  it('moves a newcomer more than an established player at the same rank', () => {
    // Rating deviation earning its keep: a player the system is unsure about
    // should move further on the same evidence.
    const established: Player = { rating: 1500, rd: 60, volatility: 0.06 };
    const entries: RankedPlayer[] = field(10).map((entry) =>
      entry.userId > 2 ? entry : { ...entry, player: entry.userId === 1 ? DEFAULT_PLAYER : established },
    );
    // Both finish adjacent at the top, so the results they face are near
    // identical; only their prior certainty differs.
    const changes = rateContest(entries)!;
    const newcomer = changes.find((c) => c.userId === 1)!;
    const veteran = changes.find((c) => c.userId === 2)!;
    expect(Math.abs(newcomer.after.rating - newcomer.before.rating)).toBeGreaterThan(
      Math.abs(veteran.after.rating - veteran.before.rating),
    );
  });

  it('shrinks the deviation of everyone who competed', () => {
    for (const change of rateContest(field(10))!) {
      expect(change.after.rd).toBeLessThan(change.before.rd);
    }
  });
});
