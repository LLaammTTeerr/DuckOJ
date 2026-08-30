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

  // D46 — the names are real now, in both locales, and they are DATA: the
  // web renders `nameVi`/`nameEn` straight out of this table (the way a tag
  // carries both spellings on one row, D18), so a band with a blank half
  // would render as an empty cell on exactly one locale and nowhere else.
  it('every band carries a non-blank Vietnamese and English name', () => {
    for (const band of RANK_BANDS) {
      expect(band.nameVi.trim()).not.toBe('');
      expect(band.nameEn.trim()).not.toBe('');
    }
  });

  it('names are unique within each locale', () => {
    expect(new Set(RANK_BANDS.map((b) => b.nameVi)).size).toBe(RANK_BANDS.length);
    expect(new Set(RANK_BANDS.map((b) => b.nameEn)).size).toBe(RANK_BANDS.length);
  });

  // The colour is a CSS class name, not a hex value (D46): app.css owns the
  // muted rank scale in both palettes, so the table must never carry a
  // colour the stylesheet cannot honour in dark mode.
  it('carries no colour of its own — the key is the class name', () => {
    for (const band of RANK_BANDS) {
      expect(band).not.toHaveProperty('color');
      expect(band.key).toMatch(/^[a-z][a-z-]*[a-z]$/);
    }
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

  it('the Glicko-2 default of 1500 is a Specialist', () => {
    expect(rankBand(1500).key).toBe('specialist');
  });

  // Literals, deliberately: these are the words D46 shipped, and a rename is
  // a product decision that should have to come through here.
  it('names the bands in Vietnamese and English (D46)', () => {
    expect(rankBand(800)).toMatchObject({ nameVi: 'Tân binh', nameEn: 'Newbie' });
    expect(rankBand(1200)).toMatchObject({ nameVi: 'Học viên', nameEn: 'Pupil' });
    expect(rankBand(1900)).toMatchObject({
      nameVi: 'Ứng viên kiện tướng',
      nameEn: 'Candidate Master',
    });
    expect(rankBand(2400)).toMatchObject({ nameVi: 'Đại kiện tướng', nameEn: 'Grandmaster' });
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
