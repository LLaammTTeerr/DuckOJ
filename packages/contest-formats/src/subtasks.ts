/**
 * A submission's cases, summarised **per group** — the shape both consumers of
 * `SubmissionTestCase` rows actually need (D165).
 *
 * Nothing in this package ever looked at an individual case. `aggregateCases`
 * reduced them per batch (`min` points, `max` total, or a running sum for the
 * loose group), and `ioi16`'s `get_best_subtask_point` reduced them per batch
 * too (`min` points). Both reductions factor through one per-group record, so
 * the case rows can be reduced *before* they reach JavaScript — which is what
 * lets the API summarise 240 000 case rows into 20 000 group rows inside
 * Postgres instead of shipping and re-folding every one of them (F-44's
 * statement 34).
 *
 * `packages/contest-formats/test/subtask-summary.spec.ts` proves the factoring
 * is bit-identical against the pre-redesign implementations, kept there as
 * literal oracles.
 */

import { pyRound } from './numeric.js';
import type { TestCaseSpec } from './types.js';

/**
 * One group of one submission's cases.
 *
 * Every field is an aggregate the group's cases determine, so a summary is
 * loss-free for both consumers and no consumer can accidentally read a single
 * case's value.
 */
export interface SubtaskSummary {
  /**
   * The group, with `null` already folded into `0`.
   *
   * `TestCaseSpec.batch` spells "unbatched" two ways and both consumers
   * normalise it the same way (`batch ?? 0`, and `batch === null || batch === 0`
   * is loose), so the summary carries the normalised form — `submission_cases
   * .group_index`, which is already `0` for an ungrouped case.
   */
  batch: number;
  /** `min(points)` — what a batch scores, and what `ioi16` reads. */
  minPoints: number;
  /** `max(total)` — what a batch is out of. */
  maxTotal: number;
  /** `sum(points)` **in case order** — what the loose group contributes. */
  sumPoints: number;
  /** `sum(total)` **in case order** — what the loose group is out of. */
  sumTotal: number;
}

/**
 * Cases in, summaries out, **in first-seen group order**.
 *
 * The order is not cosmetic: `ioi16` sums its per-batch values sequentially in
 * the order the batches first appeared, and IEEE addition is not associative.
 * A `Map` keeps that order; an object literal would reorder integer-like keys
 * into ascending numeric order and silently change scores.
 *
 * This is the reference summariser. The API produces the identical rows with a
 * `GROUP BY` — `apps/api/test/contest-scoreboard-fold-plan.spec.ts` pins the
 * two against each other on real rows.
 */
export function summariseCases(cases: TestCaseSpec[]): SubtaskSummary[] {
  const groups = new Map<number, SubtaskSummary>();
  for (const testCase of cases) {
    const batch = testCase.batch ?? 0;
    const existing = groups.get(batch);
    if (existing === undefined) {
      groups.set(batch, {
        batch,
        minPoints: testCase.points,
        maxTotal: testCase.total,
        // Accumulated from the first value rather than from a leading zero, so
        // that this is the same sequence of additions Postgres' `sum(... order
        // by id)` performs. `aggregateSubtasks` adds the result into a
        // zero-initialised accumulator, which is what reproduces the original's
        // leading `0 +` (exact for every finite value, and the one thing that
        // normalises a `-0` group the same way in both directions).
        sumPoints: testCase.points,
        sumTotal: testCase.total,
      });
      continue;
    }
    existing.minPoints = Math.min(existing.minPoints, testCase.points);
    existing.maxTotal = Math.max(existing.maxTotal, testCase.total);
    existing.sumPoints += testCase.points;
    existing.sumTotal += testCase.total;
  }
  return [...groups.values()];
}

/**
 * The judge bridge's batch-aware aggregation
 * (`judge/bridge/judge_handler.py`), over summaries rather than cases: the
 * loose group sums, a batch contributes `min(points)` and `max(total)`.
 *
 * The addition order reproduces the original exactly — every loose case first,
 * because the original added them as it walked the list and only folded the
 * batches in afterwards, then the batches in first-seen order.
 */
export function accumulateSubtasks(subtasks: SubtaskSummary[]): {
  points: number;
  total: number;
} {
  let points = 0;
  let total = 0;

  for (const subtask of subtasks) {
    if (subtask.batch !== 0) continue;
    points += subtask.sumPoints;
    total += subtask.sumTotal;
  }
  for (const subtask of subtasks) {
    if (subtask.batch === 0) continue;
    points += subtask.minPoints;
    total += subtask.maxTotal;
  }
  return { points, total };
}

/**
 * `accumulateSubtasks` with the bridge's rounding applied.
 *
 * Split from the accumulation on purpose: `pyRound(_, 1)` erases any
 * discrepancy below 0.05, so a proof that compared only *this* function's
 * output would pass an implementation that reassociated the sum — verified,
 * because it did, before the property test was rewritten to compare
 * `accumulateSubtasks` instead.
 */
export function aggregateSubtasks(subtasks: SubtaskSummary[]): {
  casePoints: number;
  caseTotal: number;
} {
  const { points, total } = accumulateSubtasks(subtasks);
  return { casePoints: pyRound(points, 1), caseTotal: pyRound(total, 1) };
}

/**
 * `ContestParticipation.get_best_subtask_point()` for one problem: within a
 * submission a batch is its `min`, across submissions a batch is its `max`.
 *
 * **An absent batch stays absent** — it takes the new value outright rather
 * than maxing against an assumed zero — which is what separates
 * `ioi16/11-missing-batch-vs-zero-batch` from `ioi16/09`. The summary
 * preserves that for free: a group with no cases produces no row, here and in
 * the `GROUP BY` alike.
 */
export function bestSubtaskPoints(
  submissions: { subtasks: SubtaskSummary[] }[],
): Map<number, number> {
  const best = new Map<number, number>();
  for (const submission of submissions) {
    for (const subtask of submission.subtasks) {
      const seen = best.get(subtask.batch);
      best.set(subtask.batch, seen === undefined ? subtask.minPoints : Math.max(seen, subtask.minPoints));
    }
  }
  return best;
}
