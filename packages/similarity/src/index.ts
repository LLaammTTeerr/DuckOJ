/**
 * `@duckoj/similarity` — source-similarity detection for contest submissions
 * (chống gian lận).
 *
 * A **pure** package: no I/O, no database, no dependencies, no clock. It is
 * handed two strings and a language family and answers with numbers and
 * character ranges. Everything about who may ask, which submissions are
 * compared and what the answer means lives in the API (D77).
 *
 * The pipeline, in one line: tokenise language-aware → normalise identifiers
 * and literals to placeholders → hash every k-gram → winnow → compare the
 * fingerprint sets by Jaccard and by containment.
 */
export { languageFamily, type LanguageFamily } from './language.js';
export { tokenize, IDENTIFIER, NUMBER, STRING, type Token } from './tokenize.js';
export {
  DEFAULT_K,
  DEFAULT_WINDOW,
  fingerprint,
  kGramHashes,
  winnow,
  type Fingerprint,
  type FingerprintOptions,
  type Fingerprinted,
} from './fingerprint.js';
export {
  compareFingerprints,
  matchedSpans,
  mergeSpans,
  similarity,
  type MatchedSpans,
  type SimilarityScore,
  type Span,
} from './compare.js';
