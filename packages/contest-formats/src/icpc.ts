/**
 * `icpc` — `judge/contest_format/icpc.py`.
 *
 * Score is `default`'s. Cumtime is minute-floored solve times plus
 * `(tries - 1) x penalty`, over **solved problems only**; the tiebreaker is the
 * largest solve minute, not a sum.
 *
 * Four details a reimplementation usually gets wrong, each with a golden:
 *
 * - Compile errors, internal errors and null-result submissions are **free**
 *   (`icpc/06`). They are excluded from `tries` — but *not* from the raw SQL
 *   that picks the best points and the recorded time, so a CE still shapes
 *   `format_data` if it somehow held the maximum.
 * - Submissions after the accept cost nothing (`icpc/07`): `tries` counts only
 *   submissions dated at or before the first maximum-scoring one.
 * - Attempts on a problem you never solve add zero penalty (`icpc/01`) — the
 *   accumulator only runs inside the `if points:` branch.
 * - For an unsolved problem the *recorded* time is the **first** attempt. The
 *   code reassigns its local `time` to `Max(date)`, but `dt_second` — the value
 *   that reaches `format_data` — was already computed from `MIN(date)`. The
 *   reassignment only feeds the frozen-scoreboard flag. This corrected a
 *   misreading during 4a (ledger R5).
 *
 * Two behaviours worth flagging rather than fixing. Because solve time is
 * floored to whole minutes, a submission one second past the deadline scores an
 * identical cumtime and tiebreaker to one exactly at the deadline. And
 * `update_participation` **never filters by the contest end at all** — a
 * post-deadline submission counts if a `ContestSubmission` row exists. That is
 * almost certainly an upstream bug; `icpc/03-deadline-boundary` freezes it, and
 * this phase reproduces it, because diverging deliberately is a product
 * decision to record, not a fix to smuggle in.
 */

import { groupByProblem, secondsSinceStart } from './lower.js';
import type { FormatSemantics, LoweredContest, LoweredParticipation, LoweredSubmission } from './lower.js';
import { pyRound, toIntegerField } from './numeric.js';
import { alphabeticLabel, computeScoreboard } from './scoreboard.js';
import type { FormatDefinition, ParticipationResult } from './scoreboard.js';
import type { ContestInput, FormatData, IcpcFormatData, Instant, Scoreboard } from './types.js';

const CONFIG_DEFAULTS = { penalty: 20 };

function readConfig(input: Record<string, unknown> | null): { penalty: number } {
  const config = { ...CONFIG_DEFAULTS };
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!(key in CONFIG_DEFAULTS)) throw new Error(`unknown config key "${key}"`);
    if (typeof value !== 'number') throw new Error(`invalid type for config key "${key}"`);
    if (value < 0) throw new Error(`invalid value "${value}" for config key "${key}"`);
    config.penalty = value;
  }
  return config;
}

/**
 * `exclude(result__isnull=True).exclude(result__in=['IE', 'CE'])` — the
 * submissions that can carry a penalty. Everything else is free.
 */
function penalisable(submissions: LoweredSubmission[]): LoweredSubmission[] {
  return submissions.filter(
    (submission) =>
      submission.result !== null && submission.result !== 'IE' && submission.result !== 'CE',
  );
}

function makeUpdateParticipation(penaltyMinutes: number) {
  return function updateParticipation(
    contest: LoweredContest,
    participation: LoweredParticipation,
  ): ParticipationResult {
    const groups = groupByProblem(participation);
    const formatData: Record<string, FormatData | IcpcFormatData> = {};
    let cumtime = 0;
    let last = 0;
    let penalty = 0;
    let score = 0;
    let frozenCumtime = 0;
    let frozenLast = 0;
    let frozenPenalty = 0;
    let frozenScore = 0;

    // The raw SQL groups by contest problem and, per group, takes MAX(points)
    // and the MIN(date) among the submissions holding that maximum. Note it
    // joins plain `judge_contestsubmission`: CE and IE rows are in scope here.
    for (const problem of contest.problems) {
      const submissions = groups.get(problem.code);
      if (submissions === undefined) continue;

      const points = Math.max(...submissions.map((submission) => submission.points));
      const timeMs = Math.min(
        ...submissions
          .filter((submission) => submission.points === points)
          .map((submission) => submission.dateMs),
      );
      const dtSecond = secondsSinceStart(timeMs, participation);
      const dt = Math.floor(dtSecond / 60);
      // `is_frozen` on a CELL means "this cell hides attempts" — the freeze
      // itself happened in `lower()`, which dropped those submissions and
      // counted them here (D22). The DMOJ branch that zeroed `frozen_points`
      // for such a cell is gone: this board already IS the public board, and
      // projecting a second freeze onto it would hide the very score being
      // published. The `frozen_*` fields therefore mirror the served board,
      // which is what they did for all 23 goldens too.
      const pending = participation.pending.get(problem.code) ?? 0;
      const isFrozenSub = pending > 0;

      let frozenPoints = 0;
      let tries = 0;
      let frozenTries = 0;

      if (penaltyMinutes) {
        const subs = penalisable(submissions);
        if (points) {
          tries = subs.filter((submission) => submission.dateMs <= timeMs).length;
          penalty += (tries - 1) * penaltyMinutes;
          frozenPenalty += (tries - 1) * penaltyMinutes;
          frozenTries = tries;
        } else {
          tries = subs.length;
          frozenTries = tries;
          // The `time = Max(date)` reassignment upstream lands here. It feeds
          // only the freeze flag; `dtSecond` above is already fixed.
        }
      }

      if (points) {
        cumtime += dt;
        last = Math.max(last, dt);
        score += points;

        frozenPoints = points;
        frozenCumtime += dt;
        frozenLast = Math.max(frozenLast, dt);
        frozenScore += points;
      }

      formatData[problem.code] = {
        time: dtSecond,
        points,
        frozen_points: frozenPoints,
        tries,
        frozen_tries: frozenTries,
        is_frozen: isFrozenSub,
      };
    }

    return {
      score: pyRound(score, contest.precision),
      cumtime: toIntegerField(Math.max(cumtime + penalty, 0)),
      tiebreaker: last,
      frozen_score: pyRound(frozenScore, contest.precision),
      frozen_cumtime: toIntegerField(Math.max(frozenCumtime + frozenPenalty, 0)),
      frozen_tiebreaker: frozenLast,
      format_data: formatData,
    };
  };
}

export function icpcFormatDefinition(config: Record<string, unknown> | null): FormatDefinition {
  return {
    updateParticipation: makeUpdateParticipation(readConfig(config).penalty),
    showTime: () => true,
    labelForProblem: alphabeticLabel,
  };
}

export function icpcFormat(
  input: ContestInput,
  semantics: FormatSemantics = 'duckoj',
  now?: Instant,
): Scoreboard {
  return computeScoreboard(input, icpcFormatDefinition(input.format_config), semantics, now);
}
