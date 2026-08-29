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
 * DuckOJ diverges on both counts: submissions outside the participation's
 * window are dropped during lowering (DIV-1), and the time recorded is that of
 * the best submission rather than the last (DIV-2). Pass `dmojCompat` to get
 * the original behaviour; see
 * `docs/superpowers/specs/2026-08-21-contest-divergences-design.md`.
 */

import { groupByProblem, secondsSinceStart } from './lower.js';
import type { FormatSemantics, LoweredContest, LoweredParticipation } from './lower.js';
import { pyRound, toIntegerField } from './numeric.js';
import { NO_FROZEN_FIELDS, computeScoreboard, numericLabel } from './scoreboard.js';
import type { FormatDefinition, ParticipationResult } from './scoreboard.js';
import type { ContestInput, FormatData, IcpcFormatData, Instant, Scoreboard } from './types.js';

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
    // DIV-2. Upstream takes `Max(date)` over the same rows, independently of
    // `Max(points)`, so junk submitted after an accept raises the penalty and
    // can cost the contest. DuckOJ times the problem by the submission that
    // actually scored it, earliest among ties — the rule `legacy_ioi` already
    // uses. `dmojCompat` keeps the original for the goldens.
    const timeMs =
      contest.semantics === 'dmojCompat'
        ? Math.max(...submissions.map((submission) => submission.dateMs))
        : Math.min(
            ...submissions
              .filter((submission) => submission.points === best)
              .map((submission) => submission.dateMs),
          );
    const dt = secondsSinceStart(timeMs, participation);

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

export function defaultFormat(
  input: ContestInput,
  semantics: FormatSemantics = 'duckoj',
  now?: Instant,
): Scoreboard {
  return computeScoreboard(input, defaultFormatDefinition, semantics, now);
}
