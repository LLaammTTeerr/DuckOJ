/**
 * Everything the four formats share: how a participation's four fields become
 * a ranked board.
 *
 * In DMOJ this is split between the format class and `judge/views/contests.py`
 * plus `judge/utils/ranker.py`. The goldens record the *view's* output, so the
 * ordering and the rank numbering belong here rather than in each format.
 */

import { SPECTATE, lower } from './lower.js';
import type { FormatSemantics } from './lower.js';
import type { LoweredContest, LoweredParticipation } from './lower.js';
import type {
  ContestInput,
  FormatData,
  IcpcFormatData,
  RankingRow,
  Scoreboard,
  ScoreboardProblem,
} from './types.js';

/** What `update_participation()` writes back onto the participation. */
export interface ParticipationResult {
  score: number;
  cumtime: number;
  tiebreaker: number;
  frozen_score: number;
  frozen_cumtime: number;
  frozen_tiebreaker: number;
  format_data: Record<string, FormatData | IcpcFormatData>;
}

/** The per-format behaviour, mirroring the methods `BaseContestFormat` declares. */
export interface FormatDefinition {
  updateParticipation(
    contest: LoweredContest,
    participation: LoweredParticipation,
  ): ParticipationResult;
  /**
   * `get_first_solves_and_total_ac` guards the first-solve update on
   * `show_time`. `default` and `icpc` do not have the guard at all (so: true);
   * the IOI formats compute it from their config, and under both defaults it is
   * false, which is why `first_solve` is null across every IOI golden.
   */
  showTime(contest: LoweredContest): boolean;
  labelForProblem(index: number): string;
}

/** `default`'s labels: 1, 2, 3, ... Inherited by both IOI formats. */
export function numericLabel(index: number): string {
  return String(index + 1);
}

/** `icpc`'s labels: A, B, ... Z, AA, AB, ... */
export function alphabeticLabel(index: number): string {
  let remaining = index + 1;
  let label = '';
  while (remaining > 0) {
    label += String.fromCharCode(((remaining - 1) % 26) + 65);
    remaining = Math.floor((remaining - 1) / 26);
  }
  return [...label].reverse().join('');
}

interface ComputedRow {
  participation: LoweredParticipation;
  result: ParticipationResult;
  submissionCount: number;
}

/**
 * `base_contest_ranking_queryset`'s ordering:
 * `is_disqualified, -score, cumtime, tiebreaker, -submission_count`.
 *
 * Both `cumtime` and `tiebreaker` are ascending — smaller is better — whatever
 * a format chooses to put in them. Rows equal on all five keep their input
 * order; the 4a ledger records that no golden contains such a pair, because
 * beyond these five the order is database-defined and not a property of the
 * format.
 */
function compareRows(a: ComputedRow, b: ComputedRow): number {
  return (
    Number(a.participation.isDisqualified) - Number(b.participation.isDisqualified) ||
    b.result.score - a.result.score ||
    a.result.cumtime - b.result.cumtime ||
    a.result.tiebreaker - b.result.tiebreaker ||
    b.submissionCount - a.submissionCount
  );
}

/**
 * `judge/utils/ranker.py`, keyed on `(score, cumtime, tiebreaker)` only — *not*
 * on submission count. Two rows can therefore print in a definite order and
 * still share a rank, and after a group of k tied rows the next rank jumps by
 * k: 1, 1, 1, 4.
 */
function assignRanks(rows: ComputedRow[]): number[] {
  const ranks: number[] = [];
  let delta = 1;
  let rank = 0;
  let last: [number, number, number] | null = null;

  for (const row of rows) {
    const key: [number, number, number] = [
      row.result.score,
      row.result.cumtime,
      row.result.tiebreaker,
    ];
    if (last === null || key[0] !== last[0] || key[1] !== last[1] || key[2] !== last[2]) {
      rank += delta;
      delta = 0;
    }
    delta += 1;
    ranks.push(rank);
    last = key;
  }
  return ranks;
}

/**
 * `get_first_solves_and_total_ac`, shared by all four formats.
 *
 * `total_ac` counts every participation at full marks, virtual ones included.
 * `first_solve` counts only live participations, and only when the format shows
 * times at all.
 */
function firstSolvesAndTotalAc(
  contest: LoweredContest,
  rows: ComputedRow[],
  showTime: boolean,
): { firstSolve: Map<string, string | null>; totalAc: Map<string, number> } {
  const firstSolve = new Map<string, string | null>();
  const totalAc = new Map<string, number>();

  for (const problem of contest.problems) {
    let minTime: number | null = null;
    firstSolve.set(problem.code, null);
    totalAc.set(problem.code, 0);

    for (const row of rows) {
      const formatData = row.result.format_data[problem.code];
      if (formatData === undefined) continue;
      if (formatData.points !== problem.points) continue;

      totalAc.set(problem.code, (totalAc.get(problem.code) ?? 0) + 1);
      if (
        showTime &&
        row.participation.virtual === 0 &&
        (minTime === null || minTime > formatData.time)
      ) {
        minTime = formatData.time;
        firstSolve.set(problem.code, row.participation.name);
      }
    }
  }
  return { firstSolve, totalAc };
}

/** Runs one format over one contest and assembles the golden's output shape. */
export function computeScoreboard(
  input: ContestInput,
  definition: FormatDefinition,
  semantics: FormatSemantics = 'duckoj',
): Scoreboard {
  const contest = lower(input, semantics);

  const rows: ComputedRow[] = contest.participations
    .filter((participation) => participation.virtual > SPECTATE)
    .map((participation) => ({
      participation,
      result: definition.updateParticipation(contest, participation),
      submissionCount: participation.submissions.length,
    }));

  rows.sort(compareRows);
  const ranks = assignRanks(rows);
  const { firstSolve, totalAc } = firstSolvesAndTotalAc(
    contest,
    rows,
    definition.showTime(contest),
  );

  const problems: ScoreboardProblem[] = contest.problems.map((problem, index) => ({
    code: problem.code,
    label: definition.labelForProblem(index),
    points: problem.points,
    points_scaling_factor: problem.scalingFactor,
    total_ac: totalAc.get(problem.code) ?? 0,
    first_solve: firstSolve.get(problem.code) ?? null,
  }));

  const ranking: RankingRow[] = rows.map((row, index) => ({
    rank: ranks[index] ?? 0,
    participant: row.participation.name,
    virtual: row.participation.virtual,
    is_disqualified: row.participation.isDisqualified,
    score: row.result.score,
    cumtime: row.result.cumtime,
    tiebreaker: row.result.tiebreaker,
    frozen_score: row.result.frozen_score,
    frozen_cumtime: row.result.frozen_cumtime,
    frozen_tiebreaker: row.result.frozen_tiebreaker,
    submission_count: row.submissionCount,
    format_data: row.result.format_data,
  }));

  return {
    label_by_problem: Object.fromEntries(
      contest.problems.map((problem, index) => [problem.code, definition.labelForProblem(index)]),
    ),
    problems,
    ranking,
  };
}

/** The three fields only `icpc` maintains; everyone else leaves them at zero. */
export const NO_FROZEN_FIELDS = {
  frozen_score: 0,
  frozen_cumtime: 0,
  frozen_tiebreaker: 0,
} as const;
