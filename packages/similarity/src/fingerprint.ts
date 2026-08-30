/**
 * k-gram hashing and winnowing — Schleimer, Wilkerson and Aiken's scheme,
 * implemented here rather than depended on (this package has no
 * dependencies, and the whole algorithm is sixty lines).
 *
 * Why not hash every k-gram and compare those sets directly: the fingerprint
 * of a 3 000-token file would then be 3 000 hashes, every comparison an
 * intersection of two such sets, and a 300-competitor problem is 45 000
 * comparisons. Winnowing keeps roughly `2/(w+1)` of them while GUARANTEEING
 * that any shared run of at least `w + k - 1` tokens contributes at least one
 * shared fingerprint. That guarantee is the property this feature needs: a
 * copier who changes one line in five cannot slip below it.
 */
import { tokenize, type Token } from './tokenize.js';
import type { LanguageFamily } from './language.js';

/** Tokens per k-gram. Five is short enough to survive a rewritten line. */
export const DEFAULT_K = 5;
/** Winnowing window, in k-grams. */
export const DEFAULT_WINDOW = 4;

export interface FingerprintOptions {
  /** k-gram length in tokens; 5..7 is the useful range. */
  readonly k?: number;
  /** Winnowing window, in k-grams. */
  readonly window?: number;
}

/** One selected k-gram: its hash, and where in the token stream it starts. */
export interface Fingerprint {
  readonly hash: number;
  /** Index into `tokens` of the FIRST token of the k-gram. */
  readonly index: number;
}

export interface Fingerprinted {
  readonly tokens: readonly Token[];
  readonly fingerprints: readonly Fingerprint[];
  /** Distinct hashes — what the two similarity measures are computed over. */
  readonly hashes: ReadonlySet<number>;
  readonly k: number;
}

/**
 * FNV-1a, 32 bit, over the token's normalised text.
 *
 * `Math.imul` rather than `*`: the product of two 32-bit values exceeds
 * float64's exact integer range, so a plain multiply silently loses low bits
 * — the bits a hash is made of.
 */
function hashToken(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Source → tokens, k-grams, winnowed fingerprints. */
export function fingerprint(
  source: string,
  family: LanguageFamily,
  options: FingerprintOptions = {},
): Fingerprinted {
  const k = options.k ?? DEFAULT_K;
  const window = options.window ?? DEFAULT_WINDOW;
  const tokens = tokenize(source, family);
  const grams = kGramHashes(tokens, k);
  const fingerprints = winnow(grams, window);
  return {
    tokens,
    fingerprints,
    hashes: new Set(fingerprints.map((f) => f.hash)),
    k,
  };
}

/**
 * The hash of every k-gram, in order.
 *
 * A source with fewer than `k` tokens yields NOTHING — not one short gram.
 * A three-token file has no structure to compare, and giving it a
 * fingerprint would let two one-liners match at 1.0 and head the report
 * above the pair that matters.
 */
export function kGramHashes(tokens: readonly Token[], k: number): number[] {
  if (k < 1 || tokens.length < k) return [];
  const tokenHashes = tokens.map((token) => hashToken(token.text));
  const grams: number[] = [];
  for (let i = 0; i + k <= tokenHashes.length; i += 1) {
    let h = 0x811c9dc5;
    for (let j = 0; j < k; j += 1) {
      // Mixed in position order, so `a b c d e` and `e d c b a` differ: a
      // commutative combine (xor, sum) would call a reversed statement
      // sequence identical, which is the one reordering a copier CAN do
      // cheaply.
      h = Math.imul(h ^ tokenHashes[i + j]!, 0x01000193) >>> 0;
    }
    grams.push(h);
  }
  return grams;
}

/**
 * Winnowing: in every window of `w` consecutive k-gram hashes, select the
 * minimum; on a tie select the RIGHTMOST, and select the same position only
 * once.
 *
 * The rightmost-on-tie rule is not arbitrary. It makes the selection depend
 * only on the window's contents and not on where the window sits, which is
 * what makes two files that share a passage select the SAME k-grams inside
 * it — the property the whole scheme is built on. Leftmost would work
 * equally well; mixing the two would not.
 */
export function winnow(grams: readonly number[], w: number): Fingerprint[] {
  if (grams.length === 0) return [];
  const width = Math.max(1, w);
  // Fewer grams than a window: the file is shorter than the guarantee's
  // granularity, so the single global minimum is its whole fingerprint.
  if (grams.length <= width) {
    let best = 0;
    for (let i = 1; i < grams.length; i += 1) {
      if (grams[i]! <= grams[best]!) best = i;
    }
    return [{ hash: grams[best]!, index: best }];
  }
  const selected: Fingerprint[] = [];
  let previous = -1;
  for (let start = 0; start + width <= grams.length; start += 1) {
    let best = start;
    for (let i = start + 1; i < start + width; i += 1) {
      // `<=` is the rightmost-on-tie rule.
      if (grams[i]! <= grams[best]!) best = i;
    }
    if (best !== previous) {
      selected.push({ hash: grams[best]!, index: best });
      previous = best;
    }
  }
  return selected;
}
