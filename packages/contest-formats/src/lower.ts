/**
 * Lowering the fixture input into the row shapes the formats read.
 *
 * In DMOJ the formats read `ContestSubmission.points`, `SubmissionTestCase`
 * rows and `ContestParticipation.start` — values the judge bridge and the
 * models had already computed. The fixtures carry raw per-case points instead,
 * so that arithmetic has to be reproduced here, once, for all four formats.
 */

import { accumulateSubtasks, summariseCases } from './subtasks.js';
import type { SubtaskSummary } from './subtasks.js';
import { pyRound } from './numeric.js';
import {
  SPECTATE,
  freezeAtMs,
  isFrozenAt,
  isWithinWindow,
  parseInstant,
  participationEndMs,
  participationStartMs,
} from './window.js';
import type {
  ContestInput,
  ContestSpec,
  Instant,
  ProblemSpec,
  SubmissionSpec,
} from './types.js';

export { LIVE, SPECTATE } from './window.js';

/**
 * Which semantics to compute under. `duckoj` is the default everywhere;
 * `dmojCompat` reproduces the original's behaviour bug-for-bug and exists for
 * one consumer, the golden suite. See
 * `docs/superpowers/specs/2026-08-21-contest-divergences-design.md`.
 */
export type FormatSemantics = 'duckoj' | 'dmojCompat';

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
  /**
   * The submission's cases reduced per group, in first-seen group order
   * (D165). Nothing downstream ever wanted an individual case: `ioi16` reduces
   * them per batch and `contestSubmissionPoints` reduces them per batch, so
   * the reduction happens once, here or in SQL, and never again.
   */
  subtasks: SubtaskSummary[];
  /** `ContestSubmission.points`. `ioi16` is the one format that ignores this. */
  points: number;
}

export interface LoweredParticipation {
  name: string;
  virtual: number;
  isDisqualified: boolean;
  /** `ContestParticipation.start`, in epoch milliseconds. */
  startMs: number;
  /** `ContestParticipation.end_time`, in epoch milliseconds. */
  endMs: number;
  /**
   * `endMs − F·60s`, or `null` with no freeze window. Per PARTICIPATION, not
   * per contest: a virtual entrant's freeze is shifted by their own start,
   * exactly as their window is (D22).
   */
  freezeMs: number | null;
  /** Whether `now` fell inside this participation's freeze window. */
  isFrozen: boolean;
  /** This participation's `ContestSubmission` rows, in insertion order. */
  submissions: LoweredSubmission[];
  /**
   * Problem code → how many in-window submissions the freeze hid. Lives here
   * rather than in `format_data` because a problem whose only submissions are
   * inside the freeze window has no `format_data` cell to hang a count on.
   */
  pending: Map<string, number>;
}

export interface LoweredContest {
  spec: ContestSpec;
  /** `contest.points_precision`. */
  precision: number;
  problems: LoweredProblem[];
  problemsByCode: Map<string, LoweredProblem>;
  /** Every participation, in fixture order, spectators included. */
  participations: LoweredParticipation[];
  /**
   * Whether this lowering hid anything: true when at least one RANKED
   * participation is inside its own freeze window. "The board you are looking
   * at is incomplete" is the claim a viewer needs, and it is the claim the
   * banner makes (D22).
   */
  isFrozen: boolean;
  /**
   * The CONTEST's own freeze instant, `end_time − F·60s`, as an ISO instant —
   * present whenever `F > 0`, whatever the clock says, so a caller can say
   * when the board freezes as well as that it is frozen. `null` with no
   * freeze window.
   */
  frozenAt: Instant | null;
  /** Which semantics this lowering was performed under. `default` reads it. */
  semantics: FormatSemantics;
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
  // An all-zero dataset would make this Infinity and every ioi16 score NaN
  // (serialised as null, corrupting the whole scoreboard row). A dataset
  // worth nothing scales everything to nothing — finite and honest. The API
  // additionally refuses to score an ioi16 contest against such a dataset
  // (contest.access.ts extends its missing-dataset guard to zero), so this
  // is defense in depth for direct library callers.
  if (sumBatchPoints === 0) return 0;
  return problem.points / sumBatchPoints;
}

/**
 * `Submission.update_contest()` — how `ContestSubmission.points` is derived.
 *
 * Exported (via `index.ts`) so a writer persisting `contest_submissions.points`
 * uses this arithmetic rather than a second copy of it. `partial` here is the
 * *effective* flag, `ContestProblem.partial && Problem.partial`, and `points`
 * is `ContestProblem.points` — never the problem's own total.
 *
 * Note that nothing in this package reads a persisted value: `lower()` calls
 * this on every scoreboard read, and `ioi16` ignores the result entirely.
 *
 * The batch-aware aggregation this used to inline now lives in `subtasks.ts`,
 * because the API reproduces it in SQL (D165) and one arithmetic with two
 * spellings is the split-predicate bug this project keeps finding.
 */
export function contestSubmissionPoints(
  subtasks: SubtaskSummary[],
  problem: { points: number; partial: boolean },
): number {
  const { points: casePoints, total: caseTotal } = accumulateSubtasks(subtasks);
  const roundedPoints = pyRound(casePoints, 1);
  const roundedTotal = pyRound(caseTotal, 1);
  let points =
    roundedTotal > 0 ? pyRound((roundedPoints / roundedTotal) * problem.points, 3) : 0;
  if (!problem.partial && points !== problem.points) points = 0;
  return points;
}

/**
 * @param now The instant to compute at, for the freeze window (D22).
 *   **Omitted means "no freeze"** — which is exactly the privileged view, and
 *   is also what the rating replay wants: a default that silently froze a
 *   caller who forgot the argument would fold a half-board into a rating.
 */
export function lower(
  input: ContestInput,
  semantics: FormatSemantics = 'duckoj',
  now?: Instant,
): LoweredContest {
  const spec = input.contest;
  // A negative window is nonsense rather than "no freeze", so it is refused
  // here as well as at the API's write time — this package is reachable
  // directly. Zero and absent both mean the same thing: no freeze.
  if (spec.frozen_last_minutes < 0) {
    throw new Error(`frozen_last_minutes must not be negative: ${spec.frozen_last_minutes}`);
  }
  const nowMs = now === undefined ? null : parseInstant(now);

  const problems: LoweredProblem[] = input.problems.map((problem) => ({
    code: problem.code,
    points: problem.points,
    partial: problem.partial && problem.problem_partial,
    scalingFactor: pointsScalingFactor(problem),
  }));
  const problemsByCode = new Map(problems.map((problem) => [problem.code, problem]));

  const participations: LoweredParticipation[] = input.participants.map((participant) => {
    const endMs = participationEndMs(participant, spec);
    const freezeMs = freezeAtMs(endMs, spec.frozen_last_minutes);
    return {
      name: participant.name,
      virtual: participant.virtual,
      isDisqualified: participant.is_disqualified ?? false,
      startMs: participationStartMs(participant, spec),
      endMs,
      freezeMs,
      isFrozen: nowMs !== null && isFrozenAt(nowMs, freezeMs, endMs),
      submissions: [],
      pending: new Map<string, number>(),
    };
  });
  // Keyed by `participation_id` where the caller supplies one, by name where
  // it does not (D36). A name is only an identity while a person holds one
  // participation, and the product's `join` makes that false routinely — a
  // live entrant replaying the contest virtually holds two, and each is a
  // ranked row of its own. Every golden omits `participation_id`, so they all
  // lower by name exactly as they did.
  const byKey = new Map<string, LoweredParticipation>();
  input.participants.forEach((participant, index) => {
    const key = participantKey(participant);
    // Refused rather than silently overwritten: two participations under one
    // key would merge their submissions into whichever came last and report a
    // wrong board as a right one. Unreachable from the API, which keys every
    // participation by its own primary key.
    if (byKey.has(key)) {
      throw new Error(`two participations share one key: ${participant.name}`);
    }
    byKey.set(key, participations[index]!);
  });

  for (const submission of input.submissions) {
    const participation = byKey.get(participantKey({
      name: submission.participant,
      ...(submission.participation_id === undefined
        ? {}
        : { participation_id: submission.participation_id }),
    }));
    if (participation === undefined) {
      throw new Error(`submission by unknown participant: ${submission.participant}`);
    }
    const problem = problemsByCode.get(submission.problem);
    if (problem === undefined) {
      throw new Error(`submission to unknown problem: ${submission.problem}`);
    }
    const dateMs = parseInstant(submission.date);
    // DIV-1. Nothing upstream filters by time, so `icpc/03-deadline-boundary`
    // scores a submission a full minute past the deadline as a solve. The
    // window is per-participation and inclusive at both ends; see window.ts.
    const inWindow = isWithinWindow(dateMs, participation.startMs, participation.endMs);
    if (semantics === 'duckoj' && !inWindow) {
      continue;
    }
    // The freeze runs AFTER the window filter, and only over what the window
    // kept: a submission outside the participation's window is void, not
    // pending, and counting it would advertise attempts that will never
    // appear when the board thaws.
    if (inWindow && participation.isFrozen && dateMs >= (participation.freezeMs ?? Infinity)) {
      const code = submission.problem;
      participation.pending.set(code, (participation.pending.get(code) ?? 0) + 1);
      continue;
    }
    const subtasks = subtasksOf(submission);
    participation.submissions.push({
      problemCode: submission.problem,
      dateMs,
      result: submission.result,
      subtasks,
      points: contestSubmissionPoints(subtasks, problem),
    });
  }

  const contestFreezeMs = freezeAtMs(parseInstant(spec.end_time), spec.frozen_last_minutes);
  return {
    spec,
    precision: spec.points_precision,
    problems,
    problemsByCode,
    participations,
    // Spectators are never ranked, so a spectator's freeze window would
    // announce a frozen board that hides nothing anyone can see.
    isFrozen: participations.some(
      (participation) => participation.virtual > SPECTATE && participation.isFrozen,
    ),
    frozenAt: contestFreezeMs === null ? null : new Date(contestFreezeMs).toISOString(),
    semantics,
  };
}

/**
 * A submission's per-group summaries, however the caller supplied them.
 *
 * A fixture carries raw `cases` and is summarised here; the API carries
 * `subtasks` it already summarised in SQL. Both together is refused rather
 * than resolved by precedence — two descriptions of one submission that
 * disagree would silently score a board from whichever one won.
 */
function subtasksOf(submission: SubmissionSpec): SubtaskSummary[] {
  if (submission.subtasks !== undefined) {
    if (submission.cases !== undefined) {
      throw new Error(
        `submission by "${submission.participant}" carries both cases and subtasks; supply one`,
      );
    }
    return submission.subtasks;
  }
  return summariseCases(submission.cases ?? []);
}

/**
 * What a submission is matched to a participation on (D36): the
 * `participation_id` when there is one, the name otherwise. The two spaces are
 * prefixed apart so an id of `7` can never collide with a participant named
 * `7`.
 */
function participantKey(who: { name: string; participation_id?: number }): string {
  return who.participation_id === undefined ? `n:${who.name}` : `p:${String(who.participation_id)}`;
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
