/**
 * The results-export cache keys (D71) — `booklet.cache.ts`'s design, applied
 * to the two PDFs a finished contest produces.
 *
 * **Content-addressed, not enumerable.** The document about to be typeset
 * already contains everything the answer depends on: the contest's name and
 * window, every rank, every score, every display name, and for a certificate
 * the issuing organization and the selected rows. Hashing it is the exact
 * invalidation — a rejudge that moves one row, a renamed account, a
 * disqualification, all change the document and therefore the key — so there
 * is **no invalidation call anywhere** and no `resultsCacheKeys` enumerator
 * for `invalidateScoreboards` to sweep. An edit does not delete the old
 * entry; it stops addressing it, and the entry expires on its own.
 *
 * This only works because neither document reads a clock (`results.ts`): a
 * certificate dated "now" would hash to a fresh key every second, and the
 * cache would cost a sha256 per request and never hit.
 */
import { createHash } from 'node:crypto';

/**
 * A minute, matching the booklet exactly. The load this collapses is the
 * same shape: an organiser at the closing ceremony pressing the button, and
 * a hall's worth of people reloading the results page behind them.
 */
export const RESULTS_CACHE_TTL_MS = 60_000;

/** Sixteen bytes of sha256 — a cache address, not a signature (D48's ruling). */
function digest(document: string): string {
  return createHash('sha256').update(document, 'utf8').digest('hex').slice(0, 32);
}

export function resultsCacheKey(contestId: number, document: string): string {
  return `duckoj:results:v1:${String(contestId)}:${digest(document)}`;
}

/**
 * A separate namespace from the standings, deliberately: the two documents
 * could not collide anyway (their contents differ), but a shared prefix
 * would make `KEYS duckoj:results:*` in an incident report mean two things.
 */
export function certificatesCacheKey(contestId: number, document: string): string {
  return `duckoj:certificates:v1:${String(contestId)}:${digest(document)}`;
}

/**
 * The seat slips (D129), in a namespace of their own for the reason the
 * certificates have one: the documents could not collide, but a shared prefix
 * would make `KEYS duckoj:results:*` in an incident report mean three things.
 *
 * The same 60 s TTL and the same content addressing: a slip carries the
 * contest's own window and never a clock, so the roster changing is what
 * changes the key — and a competitor who joins between two prints appears on
 * the second one.
 */
export function seatsCacheKey(contestId: number, document: string): string {
  return `duckoj:seats:v1:${String(contestId)}:${digest(document)}`;
}
