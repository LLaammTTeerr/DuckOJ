/**
 * Lowering the fixture input into the row shapes the formats read.
 *
 * In DMOJ the formats read `ContestSubmission.points`, `SubmissionTestCase`
 * rows and `ContestParticipation.start` — values the judge bridge and the
 * models had already computed. The fixtures carry raw per-case points instead,
 * so that arithmetic has to be reproduced here, once, for all four formats.
 */

import { pyRound } from './numeric.js';
import type {
  ContestInput,
  ContestSpec,
  ParticipantSpec,
  ProblemSpec,
  SubmissionSpec,
  TestCaseSpec,
} from './types.js';

export const SPECTATE = -1;
export const LIVE = 0;

export interface LoweredProblem {
  code: string;
  /** `ContestProblem.points`. */
  points: number;
  /** `ContestProblem.partial && Problem.partial` — partial scoring applies. */
  partial: boolean;
  /** `ContestProblem.points_scaling_factor`, or null with no dataset. */
  scalingFactor: number | null;
}

export interface LoweredSubmission {
  problemCode: string;
  /** `Submission.date`, in epoch milliseconds. */
  dateMs: number;
  /** `Submission.result`; `null` for an internal error. */
  result: string | null;
  /** `SubmissionTestCase` rows, in insertion order. */
  cases: TestCaseSpec[];
  /** `ContestSubmission.points`. `ioi16` is the one format that ignores this. */
  points: number;
}

export interface LoweredParticipation {
  name: string;
  virtual: number;
  isDisqualified: boolean;
  /** `ContestParticipation.start`, in epoch milliseconds. */
  startMs: number;
  /** This participation's `ContestSubmission` rows, in insertion order. */
  submissions: LoweredSubmission[];
}

export interface LoweredContest {
  spec: ContestSpec;
  /** `contest.points_precision`. */
  precision: number;
  problems: LoweredProblem[];
  problemsByCode: Map<string, LoweredProblem>;
  /** Every participation, in fixture order, spectators included. */
  participations: LoweredParticipation[];
  /** `Contest.is_frozen`. Always false: the formats reject a freeze window. */
  isFrozen: boolean;
}

function parseInstant(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`not an ISO-8601 instant: ${value}`);
  return ms;
}

/**
 * `ContestProblem.points_scaling_factor` — `ContestProblem.points` divided by
 * the dataset's total batch points, walking `ProblemTestCase` rows in order.
 * A loose case counts only outside a batch; a batch start carries the batch's
 * points. Returns null when the problem has no dataset at all, which is what
 * the generator recorded as `points_scaling_factor: null`.
 */
export function pointsScalingFactor(problem: ProblemSpec): number | null {
  const cases = problem.problem_test_cases;
  if (cases === undefined || cases.length === 0) return null;

  let sumBatchPoints = 0;
  let inBatch = false;
  for (const testCase of cases) {
    const points = testCase.points ?? 0;
    if (testCase.type === 'C' && !inBatch) sumBatchPoints += points;
    if (testCase.type === 'S') {
      inBatch = true;
      sumBatchPoints += points;
    }
    if (testCase.type === 'E') inBatch = false;
  }
  return problem.points / sumBatchPoints;
}

/**
 * The judge bridge's batch-aware case aggregation
 * (`judge/bridge/judge_handler.py`): loose cases sum, a batch contributes
 * `min(points)` and `max(total)` over its cases. Note the bridge's test is
 * `if not case.batch`, so **batch 0 is loose**, which is why the fixtures
 * number their batches from 1.
 */
function aggregateCases(cases: TestCaseSpec[]): { casePoints: number; caseTotal: number } {
  let points = 0;
  let total = 0;
  const batches = new Map<number, { points: number; total: number }>();

  for (const testCase of cases) {
    const batch = testCase.batch;
    if (batch === null || batch === 0) {
      points += testCase.points;
      total += testCase.total;
      continue;
    }
    const existing = batches.get(batch);
    if (existing === undefined) {
      batches.set(batch, { points: testCase.points, total: testCase.total });
    } else {
      existing.points = Math.min(existing.points, testCase.points);
      existing.total = Math.max(existing.total, testCase.total);
    }
  }
  for (const batch of batches.values()) {
    points += batch.points;
    total += batch.total;
  }
  return { casePoints: pyRound(points, 1), caseTotal: pyRound(total, 1) };
}

/** `Submission.update_contest()` — how `ContestSubmission.points` is derived. */
function contestSubmissionPoints(submission: SubmissionSpec, problem: LoweredProblem): number {
  const { casePoints, caseTotal } = aggregateCases(submission.cases);
  let points = caseTotal > 0 ? pyRound((casePoints / caseTotal) * problem.points, 3) : 0;
  if (!problem.partial && points !== problem.points) points = 0;
  return points;
}

/**
 * `ContestParticipation.start`. A live or spectating participation in a contest
 * with no time limit starts when the *contest* does, so joining late costs
 * nothing — `real_start` is only honoured for virtual participations and for
 * time-limited contests.
 */
function participationStartMs(participant: ParticipantSpec, contest: ContestSpec): number {
  const live = participant.virtual === LIVE;
  const spectate = participant.virtual === SPECTATE;
  if (contest.time_limit_seconds === null && (live || spectate)) {
    return parseInstant(contest.start_time);
  }
  return parseInstant(participant.real_start);
}

export function lower(input: ContestInput): LoweredContest {
  const spec = input.contest;
  if (spec.frozen_last_minutes !== 0) {
    throw new Error(
      'frozen_last_minutes must be 0: Contest.is_frozen compares timezone.now() to the ' +
        'freeze instant, so a freeze window makes the scoreboard wall-clock dependent. ' +
        'No golden covers it (4a ledger, deferred-decisions table); it needs its own ' +
        'scenario design with an injected clock.',
    );
  }

  const problems: LoweredProblem[] = input.problems.map((problem) => ({
    code: problem.code,
    points: problem.points,
    partial: problem.partial && problem.problem_partial,
    scalingFactor: pointsScalingFactor(problem),
  }));
  const problemsByCode = new Map(problems.map((problem) => [problem.code, problem]));

  const participations: LoweredParticipation[] = input.participants.map((participant) => ({
    name: participant.name,
    virtual: participant.virtual,
    isDisqualified: participant.is_disqualified ?? false,
    startMs: participationStartMs(participant, spec),
    submissions: [],
  }));
  const byName = new Map(
    participations.map((participation) => [participation.name, participation]),
  );

  for (const submission of input.submissions) {
    const participation = byName.get(submission.participant);
    if (participation === undefined) {
      throw new Error(`submission by unknown participant: ${submission.participant}`);
    }
    const problem = problemsByCode.get(submission.problem);
    if (problem === undefined) {
      throw new Error(`submission to unknown problem: ${submission.problem}`);
    }
    participation.submissions.push({
      problemCode: submission.problem,
      dateMs: parseInstant(submission.date),
      result: submission.result,
      cases: submission.cases,
      points: contestSubmissionPoints(submission, problem),
    });
  }

  return {
    spec,
    precision: spec.points_precision,
    problems,
    problemsByCode,
    participations,
    isFrozen: false,
  };
}

/** `(date - participation.start).total_seconds()`. */
export function secondsSinceStart(dateMs: number, participation: LoweredParticipation): number {
  return (dateMs - participation.startMs) / 1000;
}

/** Groups a participation's contest submissions by problem, in first-seen order. */
export function groupByProblem(
  participation: LoweredParticipation,
): Map<string, LoweredSubmission[]> {
  const groups = new Map<string, LoweredSubmission[]>();
  for (const submission of participation.submissions) {
    const group = groups.get(submission.problemCode);
    if (group === undefined) groups.set(submission.problemCode, [submission]);
    else group.push(submission);
  }
  return groups;
}
