/**
 * `default` — `judge/contest_format/default.py`.
 *
 * Score is `Max(points)` per problem. The surprise is cumtime: `Max(points)`
 * and `Max(date)` are **independent aggregates** over the same rows, so the
 * time recorded for a problem is the time of the *last* submission on it, not
 * of the best one. A zero-point resubmission after an accept therefore raises
 * your penalty and can cost you the contest — `default/06-zero-after-accept`
 * and its `legacy_ioi` twin run identical inputs and the winner changes.
 *
 * Nothing here filters by the contest end (`default/03-deadline-boundary`).
 */

import { groupByProblem, secondsSinceStart } from './lower.js';
import type { LoweredContest, LoweredParticipation } from './lower.js';
import { pyRound, toIntegerField } from './numeric.js';
import { NO_FROZEN_FIELDS, computeScoreboard, numericLabel } from './scoreboard.js';
import type { FormatDefinition, ParticipationResult } from './scoreboard.js';
import type { ContestInput, FormatData, IcpcFormatData, Scoreboard } from './types.js';

function updateParticipation(
  contest: LoweredContest,
  participation: LoweredParticipation,
): ParticipationResult {
  const groups = groupByProblem(participation);
  const formatData: Record<string, FormatData | IcpcFormatData> = {};
  let cumtime = 0;
  let points = 0;

  for (const problem of contest.problems) {
    const submissions = groups.get(problem.code);
    if (submissions === undefined) continue;

    const best = Math.max(...submissions.map((submission) => submission.points));
    const latest = Math.max(...submissions.map((submission) => submission.dateMs));
    const dt = secondsSinceStart(latest, participation);

    if (best) cumtime += dt;
    formatData[problem.code] = { time: dt, points: best };
    points += best;
  }

  return {
    score: pyRound(points, contest.precision),
    cumtime: toIntegerField(Math.max(cumtime, 0)),
    tiebreaker: 0,
    format_data: formatData,
    ...NO_FROZEN_FIELDS,
  };
}

export const defaultFormatDefinition: FormatDefinition = {
  updateParticipation,
  showTime: () => true,
  labelForProblem: numericLabel,
};

export function defaultFormat(input: ContestInput): Scoreboard {
  return computeScoreboard(input, defaultFormatDefinition);
}
