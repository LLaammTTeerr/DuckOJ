/**
 * The four contest formats DuckOJ keeps, as pure functions.
 *
 * No database, no ORM, no Nest, no I/O, and no dependency on anything else in
 * this repo — a format that can reach a database will eventually read one.
 * Mapping database rows into `ContestInput` is a separate, independently
 * testable job.
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

export { defaultFormat } from './default.js';
export { icpcFormat } from './icpc.js';
export { legacyIoiFormat } from './legacy-ioi.js';
export { ioi16Format } from './ioi16.js';

import type { ContestFormat, ContestInput, Scoreboard } from './types.js';
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
export function computeContestScoreboard(input: ContestInput): Scoreboard {
  const format = CONTEST_FORMATS[input.format];
  if (format === undefined) {
    throw new Error(
      `unknown contest format "${input.format}"; expected one of ` +
        `${Object.keys(CONTEST_FORMATS).join(', ')}`,
    );
  }
  return format(input);
}
