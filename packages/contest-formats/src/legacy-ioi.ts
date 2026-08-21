/**
 * `legacy_ioi` — registered upstream as **`ioi`**;
 * `judge/contest_format/legacy_ioi.py`. The directory is named after the class
 * (`LegacyIOIContestFormat`) to avoid confusion with `ioi16`.
 *
 * Score is `Max(points)` per problem — the best *submission* — timed at
 * `Min(date)` among the submissions that reached it. So a later worthless
 * submission is invisible here, where `default` would charge for it. A problem
 * scoring zero has its recorded time forced to `0`, not the submission time.
 *
 * Everything else is config-gated: `tiebreaker` accumulates only under
 * `last_score_altering`, and `cumtime` is the sum of times under `cumtime` and
 * *the tiebreaker value* otherwise. Under the default config both are zero and
 * score ties are never broken.
 *
 * The subtle consequence is in `get_first_solves_and_total_ac`, which guards
 * the first-solve update on `show_time = cumtime or last_score_altering`: under
 * the default config **`first_solve` is null for every problem**, even for
 * participants with full marks, while `total_ac` still counts
 * (`legacy_ioi/12-untimed-config`). Note `format_data` still records the time
 * under that config — only the aggregate fields are pinned to zero.
 *
 * The reason this format exists separately from `ioi16` is `legacy_ioi/09`,
 * which holds submissions byte-identical to `ioi16/09` and scores 60 where
 * `ioi16` scores 100: best *submission* against best *batch*.
 */

import { groupByProblem, secondsSinceStart } from './lower.js';
import type { LoweredContest, LoweredParticipation } from './lower.js';
import { pyRound, toIntegerField } from './numeric.js';
import { computeScoreboard, numericLabel } from './scoreboard.js';
import type { FormatDefinition, ParticipationResult } from './scoreboard.js';
import type { ContestInput, FormatData, IcpcFormatData, Scoreboard } from './types.js';

export interface LegacyIoiConfig {
  cumtime: boolean;
  last_score_altering: boolean;
}

const CONFIG_DEFAULTS: LegacyIoiConfig = { cumtime: false, last_score_altering: false };

export function readLegacyIoiConfig(input: Record<string, unknown> | null): LegacyIoiConfig {
  const config = { ...CONFIG_DEFAULTS };
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!(key in CONFIG_DEFAULTS)) throw new Error(`unknown config key "${key}"`);
    if (typeof value !== 'boolean') throw new Error(`invalid type for config key "${key}"`);
    if (key === 'cumtime') config.cumtime = value;
    else config.last_score_altering = value;
  }
  return config;
}

function makeUpdateParticipation(config: LegacyIoiConfig) {
  return function updateParticipation(
    contest: LoweredContest,
    participation: LoweredParticipation,
  ): ParticipationResult {
    const groups = groupByProblem(participation);
    const formatData: Record<string, FormatData | IcpcFormatData> = {};
    let cumtime = 0;
    let lastSubmissionTime = 0;
    let score = 0;

    for (const problem of contest.problems) {
      const submissions = groups.get(problem.code);
      if (submissions === undefined) continue;

      const points = Math.max(...submissions.map((submission) => submission.points));
      const timeMs = Math.min(
        ...submissions
          .filter((submission) => submission.points === points)
          .map((submission) => submission.dateMs),
      );

      let dt = 0;
      if (points) {
        dt = secondsSinceStart(timeMs, participation);
        if (config.last_score_altering) lastSubmissionTime = Math.max(lastSubmissionTime, dt);
        if (config.cumtime) cumtime += dt;
      }

      formatData[problem.code] = { points, time: dt };
      score += points;
    }

    return {
      score: pyRound(score, contest.precision),
      // Not a typo, and not `0`: with `cumtime` off, cumtime *is* the
      // tiebreaker value, which `last_score_altering` alone can make non-zero.
      cumtime: toIntegerField(config.cumtime ? Math.max(cumtime, 0) : lastSubmissionTime),
      tiebreaker: lastSubmissionTime,
      format_data: formatData,
      frozen_score: 0,
      frozen_cumtime: 0,
      frozen_tiebreaker: 0,
    };
  };
}

export function legacyIoiFormatDefinition(
  config: Record<string, unknown> | null,
): FormatDefinition {
  const parsed = readLegacyIoiConfig(config);
  return {
    updateParticipation: makeUpdateParticipation(parsed),
    showTime: () => parsed.cumtime || parsed.last_score_altering,
    labelForProblem: numericLabel,
  };
}

export function legacyIoiFormat(input: ContestInput): Scoreboard {
  return computeScoreboard(input, legacyIoiFormatDefinition(input.format_config));
}
