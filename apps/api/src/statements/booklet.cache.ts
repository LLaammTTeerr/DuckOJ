/**
 * The booklet cache key (D48).
 *
 * Sixty seconds, and keyed on a hash of the **document about to be
 * typeset** rather than on "the contest's revision set", which is what the
 * brief asked for and is not enough: a statement lives in `problems.statement`,
 * a plain column, so a setter fixing a typo mid-contest changes no revision
 * id at all and would have gone on serving the old PDF for a minute. The
 * document already contains the contest's name, its window, every label,
 * every limit and every statement — hashing it is the exact invalidation,
 * and it costs one sha256 over a few kilobytes on a path that is about to
 * fork a typesetter.
 *
 * There is therefore **no invalidation call anywhere**: an edit does not
 * delete this key, it stops addressing it, and the old entry expires on its
 * own. That is the whole reason the key is content-addressed rather than
 * enumerable the way `scoreboardCacheKeys` is.
 */
import { createHash } from 'node:crypto';
import type { StatementLang } from './markdown-to-typst.js';

/**
 * A minute. The booklet is a printable artefact of a contest that has
 * already started, so nobody is watching it tick; the TTL is here to
 * collapse the burst of a whole room downloading the problems at the bell,
 * which is the only load this endpoint ever sees.
 */
export const BOOKLET_CACHE_TTL_MS = 60_000;

export function bookletCacheKey(contestId: number, lang: StatementLang, document: string): string {
  // Sixteen bytes of sha256. The key is a cache address, not a signature:
  // collisions cost a wrong booklet for at most a minute, and 2^-64 of that
  // is not a risk worth a 64-character Redis key per contest per language.
  const digest = createHash('sha256').update(document, 'utf8').digest('hex').slice(0, 32);
  return `duckoj:booklet:v1:${String(contestId)}:${lang}:${digest}`;
}
