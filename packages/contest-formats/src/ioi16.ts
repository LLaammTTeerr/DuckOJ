/**
 * `ioi16` — `judge/contest_format/ioi.py`, subclassing `legacy_ioi`.
 *
 * The board is score-only: `cumtime`, `tiebreaker` and every
 * `format_data[*].time` are unconditionally `0`, the declared `{"cumtime": ...}`
 * config is ignored by `update_participation`, and ties fall straight through
 * to `-submission_count`. Timing a submission differently cannot move this
 * scoreboard at all — 4a proved that with a null probe.
 *
 * The score is the part that matters, and it is the reason this phase exists.
 * It reads `SubmissionTestCase` rows directly and **ignores
 * `ContestSubmission.points` entirely**:
 *
 * 1. Within one submission a batch scores `min(points)` over its cases — every
 *    case carries the batch's value, so one failed case zeroes the batch. A
 *    `NULL` batch folds into batch `0`, so unbatched cases compete with each
 *    other by `min` as a single implicit batch. (Note this differs from the
 *    judge bridge's own aggregation, where batch 0 is *loose* and sums.)
 * 2. Across submissions a batch scores `max` of its per-submission values.
 * 3. **A batch absent from a submission contributes nothing.** It does not drag
 *    the running maximum to zero, so "absent" and "scored zero" behave
 *    differently. An implementation using a default-zero map passes scenario 09
 *    and fails `ioi16/11-missing-batch-vs-zero-batch`.
 * 4. Every batch is scaled by `points_scaling_factor`, then summed, and only
 *    then is the **total** rounded to `points_precision`. `format_data` keeps
 *    the unrounded per-problem value. Rounding per problem instead accumulates
 *    differently and still passes the small scenarios.
 *
 * Points 1-3 are what make `ioi16/09` score 100 where `legacy_ioi/09` scores 60
 * on byte-identical submissions: one participant took batch 1 from one
 * submission and batch 2 from another. An implementation reading "best score
 * per problem" passes the other 22 goldens and is wrong by 40 points there.
 *
 * `first_solve` is inherited from `legacy_ioi` and, since `show_time` is false
 * under ioi16's defaults, is null for every problem.
 */

import { groupByProblem } from './lower.js';
import type { FormatSemantics, LoweredContest, LoweredParticipation } from './lower.js';
import { pyRound } from './numeric.js';
import { NO_FROZEN_FIELDS, computeScoreboard, numericLabel } from './scoreboard.js';
import type { FormatDefinition, ParticipationResult } from './scoreboard.js';
import type { ContestInput, FormatData, IcpcFormatData, Instant, Scoreboard } from './types.js';

/**
 * `ContestParticipation.get_best_subtask_point()`, for one problem.
 *
 * Insertion order is load-bearing: the caller sums these values sequentially,
 * and IEEE addition is not associative. A plain object would reorder
 * integer-like keys into ascending numeric order; a `Map` keeps first-seen
 * order the way a Python dict does.
 */
function bestSubtaskPoints(
  submissions: { cases: { points: number; batch: number | null }[] }[],
): Map<number, number> {
  const best = new Map<number, number>();

  for (const submission of submissions) {
    const current = new Map<number, number>();
    for (const testCase of submission.cases) {
      const batch = testCase.batch ?? 0;
      const seen = current.get(batch);
      current.set(batch, seen === undefined ? testCase.points : Math.min(testCase.points, seen));
    }
    for (const [batch, points] of current) {
      const seen = best.get(batch);
      // `undefined` here is an *absent* batch, not a zero one: it takes the new
      // value outright rather than maxing against an assumed 0.
      best.set(batch, seen === undefined ? points : Math.max(seen, points));
    }
  }
  return best;
}

function updateParticipation(
  contest: LoweredContest,
  participation: LoweredParticipation,
): ParticipationResult {
  const groups = groupByProblem(participation);
  const formatData: Record<string, FormatData | IcpcFormatData> = {};
  let score = 0;

  // Upstream iterates the participation's contest submissions, so problems
  // appear in first-submission order rather than contest-problem order.
  for (const [problemCode, submissions] of groups) {
    const problem = contest.problemsByCode.get(problemCode);
    if (problem === undefined) continue;
    if (problem.scalingFactor === null) {
      throw new Error(
        `ioi16 problem "${problemCode}" has no dataset: points_scaling_factor divides by the ` +
          "sum of the dataset's batch points, so every ioi16 problem needs ProblemTestCase rows.",
      );
    }

    // Upstream scales in place and then sums; scaling and summing in one pass
    // is the same sequence of IEEE additions, in the same insertion order.
    const subtasks = bestSubtaskPoints(submissions);
    let points = 0;
    for (const batchPoints of subtasks.values()) {
      points += batchPoints * problem.scalingFactor;
    }

    formatData[problemCode] = { points, time: 0 };
    score += points;
  }

  return {
    // The one rounding in this format, and it happens here — on the total.
    score: pyRound(score, contest.precision),
    cumtime: 0,
    tiebreaker: 0,
    format_data: formatData,
    ...NO_FROZEN_FIELDS,
  };
}

export const ioi16FormatDefinition: FormatDefinition = {
  updateParticipation,
  // `config_defaults` is `{'cumtime': False}` and there is no
  // `last_score_altering`, so the inherited `show_time` is always false.
  showTime: () => false,
  labelForProblem: numericLabel,
};

export function ioi16Format(
  input: ContestInput,
  semantics: FormatSemantics = 'duckoj',
  now?: Instant,
): Scoreboard {
  return computeScoreboard(input, ioi16FormatDefinition, semantics, now);
}
