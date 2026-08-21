/**
 * The four contest formats DuckOJ keeps, as pure functions.
 *
 * No database, no ORM, no Nest, no I/O, and no dependency on anything else in
 * this repo — a format that can reach a database will eventually read one.
 * Mapping database rows into `ContestInput` is a separate, independently
 * testable job.
 *
 * DuckOJ deliberately diverges from the original in two places — it drops
 * submissions outside a participation's window, and `default` times a problem
 * by its best submission rather than its last. Both are recorded in
 * `docs/superpowers/specs/2026-08-21-contest-divergences-design.md`, and the
 * original behaviour remains reachable as `dmojCompat` so the goldens keep
 * pinning it.
 *
 * Behaviour is pinned by the 23 goldens under `fixtures/contest-goldens/`,
 * frozen from the original DMOJ/VNOJ `update_participation()`. Where this code
 * and an intuition about "how contests work" disagree, the goldens win; see the
 * per-format modules for the specific surprises, and `docs/superpowers/ledgers/
 * 2026-08-21-phase-4a-contest-goldens-ledger.md` R6 and R7 for why.
 */

export type {
  ContestFormat,
  ContestInput,
  ContestSpec,
  FormatData,
  IcpcFormatData,
  Instant,
  ParticipantSpec,
  ProblemSpec,
  ProblemTestCaseSpec,
  RankingRow,
  Scoreboard,
  ScoreboardProblem,
  SubmissionSpec,
  TestCaseSpec,
} from './types.js';

/**
 * The one piece of 4b's lowering a *writer* needs: `ContestSubmission.points`.
 * Exported so persistence computes the stored value with this arithmetic
 * instead of a second copy that could drift from what the formats recompute.
 */
export { contestSubmissionPoints } from './lower.js';

/**
 * Which semantics to compute under. Everything defaults to `duckoj`, so no
 * caller can select the bug-compatible path by forgetting an argument;
 * `dmojCompat` is named in exactly one place, the golden suite.
 */
export type { FormatSemantics } from './lower.js';
export { participationEndMs, participationStartMs } from './window.js';

/**
 * CPython's `round(value, digits)`. Exported for one reason: anything
 * comparing a computed scoreboard against a golden must normalise it the way
 * `_generator/generate.py` normalised the goldens — round to nine places —
 * and re-deriving that rounding elsewhere would compare against a second,
 * subtly different normalisation (design §7).
 */
export { pyRound } from './numeric.js';

export { defaultFormat } from './default.js';
export { icpcFormat } from './icpc.js';
export { legacyIoiFormat } from './legacy-ioi.js';
export { ioi16Format } from './ioi16.js';

import type { ContestFormat, ContestInput, Scoreboard } from './types.js';
import type { FormatSemantics } from './lower.js';
import { defaultFormat } from './default.js';
import { icpcFormat } from './icpc.js';
import { legacyIoiFormat } from './legacy-ioi.js';
import { ioi16Format } from './ioi16.js';

/**
 * Keyed by the same strings the fixtures use, which are the strings
 * `@register_contest_format` uses upstream. `legacy_ioi` is registered as
 * **`ioi`**; only the fixture directory is named after the class.
 */
export const CONTEST_FORMATS: Readonly<Record<string, ContestFormat>> = Object.freeze({
  default: defaultFormat,
  icpc: icpcFormat,
  ioi: legacyIoiFormat,
  ioi16: ioi16Format,
});

export type ContestFormatName = 'default' | 'icpc' | 'ioi' | 'ioi16';

export function isContestFormatName(name: string): name is ContestFormatName {
  return Object.prototype.hasOwnProperty.call(CONTEST_FORMATS, name);
}

/** Computes a scoreboard with the format named by `input.format`. */
export function computeContestScoreboard(
  input: ContestInput,
  semantics: FormatSemantics = 'duckoj',
): Scoreboard {
  const format = CONTEST_FORMATS[input.format];
  if (format === undefined) {
    throw new Error(
      `unknown contest format "${input.format}"; expected one of ` +
        `${Object.keys(CONTEST_FORMATS).join(', ')}`,
    );
  }
  return format(input, semantics);
}
