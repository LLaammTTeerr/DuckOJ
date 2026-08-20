import { describe, expect, it } from 'vitest';
import { findPathCollision } from '../src/collision.js';

describe('findPathCollision', () => {
  it('returns null for genuinely distinct paths', () => {
    expect(findPathCollision([{ path: 'a.txt' }, { path: 'b.txt' }, { path: 'tests/01.in' }])).toBeNull();
  });

  it('catches a case-insensitive collision', () => {
    const result = findPathCollision([{ path: 'README.md' }, { path: 'readme.md' }]);
    expect(result).toEqual(['README.md', 'readme.md']);
  });

  it('catches an NFC/NFD collision', () => {
    // Built from explicit \u escapes, never a literal accented character in
    // source: an editor or formatter would silently normalise a literal
    // character and quietly merge the two fixtures into one.
    const nfc = 'caf\u00e9.txt'; // U+00E9 LATIN SMALL LETTER E WITH ACUTE, precomposed
    const nfd = 'cafe\u0301.txt'; // 'e' + U+0301 COMBINING ACUTE ACCENT, decomposed
    expect(nfc).not.toBe(nfd);
    expect(nfc.normalize('NFC')).toBe(nfd.normalize('NFC'));

    const result = findPathCollision([{ path: nfc }, { path: nfd }]);
    expect(result).toEqual([nfc, nfd]);
  });

  /**
   * Neither fold alone catches this pair: `CAF\u00c9.txt` (NFC, uppercase)
   * survives `normalize('NFC')` alone (case differs) and `cafe\u0301.txt`
   * (NFD, lowercase) survives `toLowerCase()` alone (the decomposed 'e' +
   * combining accent never matches the precomposed \u00c9 once lowered).
   * Only the combined NFC-then-lowercase fold catches it.
   */
  it('catches a pair that collides only once case-folding and NFC-normalising are combined', () => {
    const upperNfc = 'CAF\u00c9.txt'; // U+00C9 LATIN CAPITAL LETTER E WITH ACUTE, precomposed
    const lowerNfd = 'cafe\u0301.txt'; // 'e' + U+0301 COMBINING ACUTE ACCENT, decomposed
    expect(upperNfc.toLowerCase()).not.toBe(lowerNfd.toLowerCase());
    expect(upperNfc.normalize('NFC')).not.toBe(lowerNfd.normalize('NFC'));
    expect(upperNfc.normalize('NFC').toLowerCase()).toBe(lowerNfd.normalize('NFC').toLowerCase());

    const result = findPathCollision([{ path: upperNfc }, { path: lowerNfd }]);
    expect(result).toEqual([upperNfc, lowerNfd]);
  });

  /**
   * The reverse gap: a pair that collides under case-folding ALONE, but NOT
   * under the single combined `normalize('NFC').toLowerCase()` fold — proof
   * that a one-map implementation (only the combined fold) is not a safe
   * simplification of this three-map one, contrary to the intuition that the
   * combined fold is strictly the more aggressive comparison.
   *
   * `H\u0331` (H + U+0331 COMBINING MACRON BELOW) and `h\u0331` (h + the
   * same mark) both lowercase to the identical 2-code-point string
   * `h\u0331` — a plain case-alone collision, since `toLowerCase()` never
   * touches the combining mark. But normalising *before* lowering diverges:
   * `h\u0331` composes under NFC to the single precomposed code point
   * U+1E96 (LATIN SMALL LETTER H WITH LINE BELOW) — a character that exists
   * only in lowercase, with no uppercase counterpart — so
   * `H\u0331`.normalize('NFC') stays two code points (nothing to compose
   * into), then lowercases to `h\u0331` (2 code points), while
   * `h\u0331`.normalize('NFC') composes first to the 1-code-point `\u1e96`,
   * which (already lowercase) normalize+lower leaves alone. The combined
   * fold's two keys differ in code-point count, so a one-map
   * `normalize('NFC').toLowerCase()` implementation would miss this pair
   * entirely, even though it is exactly the kind of "different bytes, same
   * file once materialised" collision this check exists to catch (plain
   * case-insensitivity, no normalising filesystem even required). Confirmed
   * by an exhaustive scan over every assigned Unicode code point combined
   * with the U+0300 through U+036F combining-marks block: this was the only
   * class of gap found, and this is its simplest instance.
   */
  it('catches a pair that collides under case-folding alone but not under the combined NFC+lower fold', () => {
    const upperDecomposed = 'H\u0331'; // 'H' + U+0331 COMBINING MACRON BELOW
    const lowerDecomposed = 'h\u0331'; // 'h' + U+0331 COMBINING MACRON BELOW

    // Collide under case-folding alone.
    expect(upperDecomposed.toLowerCase()).toBe(lowerDecomposed.toLowerCase());

    // Do NOT collide under the single combined NFC-then-lowercase fold — the
    // gap a one-map implementation would have.
    const combinedFold = (s: string) => s.normalize('NFC').toLowerCase();
    expect(combinedFold(upperDecomposed)).not.toBe(combinedFold(lowerDecomposed));

    // The three-map `findPathCollision` still catches it, via the
    // case-alone map.
    const result = findPathCollision([{ path: upperDecomposed }, { path: lowerDecomposed }]);
    expect(result).toEqual([upperDecomposed, lowerDecomposed]);
  });

  it('returns the first colliding pair in file order', () => {
    const result = findPathCollision([{ path: 'a.txt' }, { path: 'README.md' }, { path: 'readme.md' }]);
    expect(result).toEqual(['README.md', 'readme.md']);
  });
});
