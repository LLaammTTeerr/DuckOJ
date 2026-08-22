/**
 * The band table is data; these tests pin the two properties the data must
 * keep however the names and thresholds are edited (D6 says they will be).
 */
import { describe, expect, it } from 'vitest';
import { RANK_BANDS, rankBand } from '../src/index.js';

describe('RANK_BANDS as a table', () => {
  it('is sorted strictly ascending by min', () => {
    for (let i = 1; i < RANK_BANDS.length; i++) {
      expect(RANK_BANDS[i]!.min).toBeGreaterThan(RANK_BANDS[i - 1]!.min);
    }
  });

  it('starts at -Infinity, so no rating falls off the bottom', () => {
    // Glicko-2 has no floor; a catastrophic rating still needs a title.
    expect(RANK_BANDS[0]!.min).toBe(-Infinity);
  });

  it('keys are unique', () => {
    expect(new Set(RANK_BANDS.map((b) => b.key)).size).toBe(RANK_BANDS.length);
  });
});

describe('rankBand', () => {
  it('a boundary rating holds the higher title (min is inclusive)', () => {
    // Literals, not values read from the table — a test that derives its
    // expectations from the constant under test moves with the mutation
    // (the MIN_RATED_PARTICIPANTS lesson, contest.spec.ts).
    expect(rankBand(1200).key).toBe('pupil');
    expect(rankBand(1199).key).toBe('newbie');
    expect(rankBand(3000).key).toBe('legendary-grandmaster');
  });

  it('the Glicko-2 default of 1500 is a Specialist under the placeholder table', () => {
    expect(rankBand(1500).key).toBe('specialist');
  });

  it('is total at the extremes', () => {
    expect(rankBand(-5000).key).toBe('newbie');
    expect(rankBand(99999).key).toBe('legendary-grandmaster');
  });

  it('every band is reachable at its own floor', () => {
    for (const band of RANK_BANDS) {
      const probe = band.min === -Infinity ? -1e9 : band.min;
      expect(rankBand(probe).key).toBe(band.key);
    }
  });
});
