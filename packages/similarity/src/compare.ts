/**
 * The two numbers a report prints, and the highlighting behind them.
 *
 * **Two measures, deliberately, because they answer different questions.**
 *
 * - `jaccard` = shared / union. "How much of the two files, taken together,
 *   is the same?" It is the honest headline for two files of similar size.
 * - `containment` = shared / the SMALLER of the two fingerprint sets. "How
 *   much of the shorter file is inside the longer one?" This is the one that
 *   catches the copy padded with dead code, unused functions and a hundred
 *   lines of `#include`: Jaccard falls with every line of padding, and
 *   containment does not move.
 *
 * `containment >= jaccard` always (the union is never smaller than the
 * smaller set), so the pair is admitted to the report on **containment** and
 * both numbers are printed. A pair at containment 0.9 / Jaccard 0.3 is a
 * different story from one at 0.9 / 0.85 — the first is one solution buried
 * in a much longer file, the second is the same file twice — and the report
 * exists to be read by a person who can tell those apart (D77).
 */
import { fingerprint, type Fingerprinted, type FingerprintOptions } from './fingerprint.js';
import type { LanguageFamily } from './language.js';

export interface SimilarityScore {
  /** Shared fingerprints over the union. */
  readonly jaccard: number;
  /** Shared fingerprints over the smaller set — the reporting metric. */
  readonly containment: number;
  /** How many distinct fingerprints the two share. */
  readonly shared: number;
  readonly sizeA: number;
  readonly sizeB: number;
}

/** A half-open `[start, end)` range of characters in one source. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

export interface MatchedSpans {
  readonly a: Span[];
  readonly b: Span[];
}

const EMPTY: SimilarityScore = { jaccard: 0, containment: 0, shared: 0, sizeA: 0, sizeB: 0 };

/**
 * Two fingerprinted sources → the score.
 *
 * An EMPTY fingerprint set on either side scores zero, never one. Two files
 * too short to produce a single k-gram are not "identical"; they are two
 * files this algorithm has nothing to say about, and `0/0 = NaN` sorted into
 * the middle of the table would be worse than either answer.
 */
export function compareFingerprints(a: Fingerprinted, b: Fingerprinted): SimilarityScore {
  const sizeA = a.hashes.size;
  const sizeB = b.hashes.size;
  if (sizeA === 0 || sizeB === 0) return { ...EMPTY, sizeA, sizeB };
  // Iterate the smaller set: the intersection is the same either way, and a
  // 40-token file compared against a 4 000-token one should cost 40 lookups.
  const [small, large] = sizeA <= sizeB ? [a.hashes, b.hashes] : [b.hashes, a.hashes];
  let shared = 0;
  for (const hash of small) {
    if (large.has(hash)) shared += 1;
  }
  const union = sizeA + sizeB - shared;
  return {
    jaccard: shared / union,
    containment: shared / Math.min(sizeA, sizeB),
    shared,
    sizeA,
    sizeB,
  };
}

/** Source pair → score, for callers holding no fingerprints yet. */
export function similarity(
  sourceA: string,
  sourceB: string,
  family: LanguageFamily,
  options: FingerprintOptions = {},
): SimilarityScore {
  return compareFingerprints(
    fingerprint(sourceA, family, options),
    fingerprint(sourceB, family, options),
  );
}

/**
 * Where the two sources actually agree, as character ranges in each.
 *
 * Every occurrence of a shared fingerprint contributes the span of its whole
 * k-gram — from the first character of its first token to the last character
 * of its k-th — and overlapping spans are merged. The ranges therefore cover
 * the code between two matched tokens as well, comments included: a
 * highlight that skipped the whitespace would paint a stripe pattern nobody
 * can read, and the claim being made is "this REGION matches", not "these
 * bytes do".
 *
 * Spans are returned per side and are NOT paired with each other. A copier
 * who moves a function does so once; the organiser reads the two columns and
 * sees which highlighted block corresponds to which, and inventing an
 * alignment here would be the algorithm asserting more than it knows.
 */
export function matchedSpans(
  a: Fingerprinted,
  b: Fingerprinted,
): MatchedSpans {
  const shared = new Set<number>();
  for (const hash of a.hashes) {
    if (b.hashes.has(hash)) shared.add(hash);
  }
  return { a: spansFor(a, shared), b: spansFor(b, shared) };
}

/** The merged character ranges of every k-gram whose hash is in `shared`. */
function spansFor(side: Fingerprinted, shared: ReadonlySet<number>): Span[] {
  const raw: Span[] = [];
  for (const print of side.fingerprints) {
    if (!shared.has(print.hash)) continue;
    const first = side.tokens[print.index];
    // The k-gram's LAST token, clamped: `winnow`'s single-minimum branch can
    // select an index whose k-gram is the final one in the file.
    const last = side.tokens[Math.min(print.index + side.k - 1, side.tokens.length - 1)];
    if (!first || !last) continue;
    raw.push({ start: first.start, end: last.end });
  }
  return mergeSpans(raw);
}

/** Sorted, and overlapping or touching ranges fused into one. */
export function mergeSpans(spans: readonly Span[]): Span[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((x, y) => x.start - y.start || x.end - y.end);
  const merged: Span[] = [{ ...sorted[0]! }];
  for (const span of sorted.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (span.start <= last.end) {
      if (span.end > last.end) merged[merged.length - 1] = { start: last.start, end: span.end };
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}
