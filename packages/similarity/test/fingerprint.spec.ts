import { describe, expect, it } from 'vitest';
import {
  DEFAULT_K,
  DEFAULT_WINDOW,
  fingerprint,
  kGramHashes,
  mergeSpans,
  tokenize,
  winnow,
} from '../src/index.js';

const CODE = `
int main() {
  int n; cin >> n;
  vector<int> a(n);
  for (int i = 0; i < n; i++) cin >> a[i];
  sort(a.begin(), a.end());
  long long total = 0;
  for (int i = 0; i < n; i++) total += a[i] * (i + 1);
  cout << total << endl;
}
`;

describe('kGramHashes', () => {
  it('produces one hash per k-gram', () => {
    const tokens = tokenize(CODE, 'cpp');
    expect(kGramHashes(tokens, 5)).toHaveLength(tokens.length - 4);
  });

  it('produces nothing at all for a source shorter than k', () => {
    expect(kGramHashes(tokenize('a;', 'cpp'), 5)).toEqual([]);
  });

  it('is order-sensitive — the same tokens in another order hash differently', () => {
    // The two streams are PERMUTATIONS of each other (`V + V - V` against
    // `V - V + V`), so a commutative combine — xor, sum — would call them
    // equal. Two sequences that merely differ in content would not test that.
    const forward = kGramHashes(tokenize('a + b - c', 'cpp'), 5);
    const backward = kGramHashes(tokenize('a - b + c', 'cpp'), 5);
    expect(forward).toHaveLength(1);
    expect(backward).toHaveLength(1);
    expect(forward[0]).not.toBe(backward[0]);
  });

  it('is stable — the same tokens hash the same way twice', () => {
    expect(kGramHashes(tokenize(CODE, 'cpp'), 5)).toEqual(kGramHashes(tokenize(CODE, 'cpp'), 5));
  });

  it('stays inside 32 bits, so no hash silently loses its low bits', () => {
    for (const hash of kGramHashes(tokenize(CODE, 'cpp'), 5)) {
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('winnow', () => {
  it('selects the rightmost minimum of each window', () => {
    // Windows of 4 over [5,1,1,9,7]: [5,1,1,9] → the SECOND 1 (index 2),
    // [1,1,9,7] → the same index 2 again, recorded once.
    expect(winnow([5, 1, 1, 9, 7], 4)).toEqual([{ hash: 1, index: 2 }]);
  });

  it('never records the same position twice in a row', () => {
    const selected = winnow([9, 8, 7, 6, 5, 4, 3, 2, 1], 4);
    const indices = selected.map((f) => f.index);
    expect(new Set(indices).size).toBe(indices.length);
  });

  it('guarantees a fingerprint inside every window of w k-grams', () => {
    const grams = kGramHashes(tokenize(CODE, 'cpp'), DEFAULT_K);
    const selected = winnow(grams, DEFAULT_WINDOW);
    for (let start = 0; start + DEFAULT_WINDOW <= grams.length; start += 1) {
      const inside = selected.some(
        (f) => f.index >= start && f.index < start + DEFAULT_WINDOW,
      );
      expect(inside).toBe(true);
    }
  });

  it('thins the stream — that is the whole point of winnowing', () => {
    const grams = kGramHashes(tokenize(CODE, 'cpp'), DEFAULT_K);
    const selected = winnow(grams, DEFAULT_WINDOW);
    expect(selected.length).toBeLessThan(grams.length);
    expect(selected.length).toBeGreaterThan(0);
  });

  it('falls back to the single global minimum for a file shorter than a window', () => {
    expect(winnow([7, 3, 9], 4)).toEqual([{ hash: 3, index: 1 }]);
    expect(winnow([], 4)).toEqual([]);
  });
});

describe('fingerprint', () => {
  it('carries the tokens, the selection and the distinct hashes together', () => {
    const printed = fingerprint(CODE, 'cpp');
    expect(printed.k).toBe(DEFAULT_K);
    expect(printed.tokens.length).toBeGreaterThan(DEFAULT_K);
    expect(printed.hashes.size).toBeGreaterThan(0);
    expect(printed.hashes.size).toBeLessThanOrEqual(printed.fingerprints.length);
    for (const print of printed.fingerprints) {
      expect(print.index).toBeGreaterThanOrEqual(0);
      expect(print.index).toBeLessThan(printed.tokens.length);
    }
  });

  it('honours a larger k, which selects fewer and longer grams', () => {
    const five = fingerprint(CODE, 'cpp', { k: 5 });
    const seven = fingerprint(CODE, 'cpp', { k: 7 });
    expect(seven.k).toBe(7);
    expect(seven.fingerprints.length).toBeLessThanOrEqual(five.fingerprints.length);
  });
});

describe('mergeSpans', () => {
  it('fuses overlapping and touching ranges and sorts them', () => {
    expect(mergeSpans([{ start: 10, end: 20 }, { start: 0, end: 5 }, { start: 4, end: 12 }])).toEqual([
      { start: 0, end: 20 },
    ]);
  });

  it('keeps ranges that do not meet apart', () => {
    expect(mergeSpans([{ start: 0, end: 5 }, { start: 8, end: 9 }])).toEqual([
      { start: 0, end: 5 },
      { start: 8, end: 9 },
    ]);
  });

  it('swallows a range wholly inside another', () => {
    expect(mergeSpans([{ start: 0, end: 20 }, { start: 5, end: 8 }])).toEqual([
      { start: 0, end: 20 },
    ]);
  });
});
