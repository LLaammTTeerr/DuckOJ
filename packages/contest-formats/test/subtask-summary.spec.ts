/**
 * F-45's equality proof, layer one: **a per-group summary is enough**.
 *
 * The cold scoreboard fold used to read every `submission_cases` row of the
 * contest and re-derive each submission's points from them in JavaScript
 * (F-44 statement 34: 13 326 buffers, an external merge sort, 146 ms). The
 * redesign summarises each submission's cases per group *in the database* and
 * folds the summaries instead.
 *
 * That is only safe if the summary is **lossless for every consumer**, and
 * there are exactly two of them in this package:
 *
 * - `aggregateCases` — the judge bridge's batch-aware aggregation, behind
 *   `contestSubmissionPoints`, which `default`, `icpc` and `legacy_ioi` read
 *   through `ContestSubmission.points`;
 * - `ioi16`'s `get_best_subtask_point`, which reads the cases directly.
 *
 * Both are reproduced here **verbatim as they stood before the redesign** and
 * used as oracles. Keeping the old form as a literal in a test is the
 * `contest-monitor-plan.spec.ts` precedent: it is the only place the two
 * implementations are ever compared, so it has to be a copy rather than a
 * call.
 *
 * The comparison is `Object.is`, not `toBeCloseTo`. `submission_cases.points`
 * is `double precision`; both consumers accumulate with `+`, IEEE addition is
 * not associative, and a summary that reorders the additions would drift a
 * scoreboard by a fraction of a point — which is precisely the class of wrong
 * board D36 says has bricked a contest. Bit-identical or it does not ship.
 */
import { describe, expect, it } from 'vitest';
import { pyRound } from '../src/numeric.js';
import {
  summariseCases,
  accumulateSubtasks,
  aggregateSubtasks,
  bestSubtaskPoints,
} from '../src/subtasks.js';
import type { TestCaseSpec } from '../src/types.js';

// ---------------------------------------------------------------------------
// The oracles: `lower.ts` and `ioi16.ts` as they stood at d72441e.
// ---------------------------------------------------------------------------

/**
 * `lower.ts`'s `aggregateCases`, verbatim, before the redesign — except that
 * it also returns the sums **before** `pyRound`.
 *
 * The unrounded pair is what the property test compares. `pyRound(_, 1)`
 * erases any difference below 0.05, and a reassociated sum of realistic case
 * points differs by far less than that: comparing only the rounded output let
 * a deliberately wrong implementation — one that folded the batches in before
 * the loose cases — pass 400 generated case lists. The rounded pair is still
 * asserted, because it is what the formats actually read.
 */
function oracleAggregateCases(cases: TestCaseSpec[]): {
  rawPoints: number;
  rawTotal: number;
  casePoints: number;
  caseTotal: number;
} {
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
  return {
    rawPoints: points,
    rawTotal: total,
    casePoints: pyRound(points, 1),
    caseTotal: pyRound(total, 1),
  };
}

/** `ioi16.ts`'s `bestSubtaskPoints`, verbatim, before the redesign. */
function oracleBestSubtaskPoints(
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
      best.set(batch, seen === undefined ? points : Math.max(seen, points));
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Generated case lists
// ---------------------------------------------------------------------------

/** mulberry32 — a seeded PRNG, so a failure is reproducible from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Points are deliberately **fractional and irregular**, never integers.
 *
 * Integer points make IEEE addition associative over any realistic case count,
 * so an integer-only generator would pass a summary that reordered the sum and
 * prove nothing. `x / 7`-shaped values do not survive reassociation.
 */
function fractionalPoints(random: () => number): number {
  const pick = random();
  if (pick < 0.10) return 0;
  if (pick < 0.18) return Math.floor(random() * 20);
  // Spread over eleven orders of magnitude. A generator confined to one
  // magnitude produces sums that survive reassociation intact — every term is
  // within an ulp-scale of every other — so it cannot see an addition performed
  // out of order. Mixed magnitudes make the order visible in the low bits of
  // the very first sum, which is the whole property under test.
  const magnitude = 10 ** Math.floor(random() * 11 - 5);
  return (Math.floor(random() * 1000) / 7) * magnitude;
}

/**
 * One submission's cases, in `submission_cases.id` order.
 *
 * Shapes the generator must be able to produce, because each is a way a
 * summary can be wrong:
 * - an empty list (a compile error grades no case at all);
 * - `batch: null` beside `batch: 0` — both are the implicit loose group, and
 *   the two consumers disagree about what that group means (one sums it, the
 *   other takes its minimum);
 * - a batch whose cases are interleaved with another batch's, so first-seen
 *   group order is not group-index order;
 * - a batch of one case, and a batch of many.
 */
function generateCases(random: () => number): TestCaseSpec[] {
  const count = Math.floor(random() * 24);
  const cases: TestCaseSpec[] = [];
  for (let index = 0; index < count; index++) {
    const roll = random();
    const batch = roll < 0.25 ? null : roll < 0.45 ? 0 : 1 + Math.floor(random() * 4);
    cases.push({
      batch,
      case: index,
      points: fractionalPoints(random),
      total: fractionalPoints(random) + 1,
      status: 'AC',
    });
  }
  return cases;
}

const SEEDS = Array.from({ length: 400 }, (_, index) => index + 1);

describe('summariseCases is lossless for the judge bridge aggregation', () => {
  it('is bit-identical to the case-by-case aggregation on 400 generated case lists', () => {
    for (const seed of SEEDS) {
      const cases = generateCases(rng(seed));
      const expected = oracleAggregateCases(cases);
      const summaries = summariseCases(cases);
      const raw = accumulateSubtasks(summaries);
      const rounded = aggregateSubtasks(summaries);
      expect(
        Object.is(raw.points, expected.rawPoints) &&
          Object.is(raw.total, expected.rawTotal) &&
          Object.is(rounded.casePoints, expected.casePoints) &&
          Object.is(rounded.caseTotal, expected.caseTotal),
        `seed ${String(seed)}: expected ${JSON.stringify(expected)}, got ${JSON.stringify({ ...raw, ...rounded })}`,
      ).toBe(true);
    }
  });

  it('adds the loose group before the batches, as the original walk did', () => {
    // One large loose case and two small batches: adding the batches first
    // accumulates them into a value the large one can still absorb, adding
    // them last does not, and the two answers differ in the last bit.
    const cases: TestCaseSpec[] = [
      { batch: 0, case: 0, points: 2 ** 53, total: 1, status: 'AC' },
      { batch: 1, case: 1, points: 1, total: 1, status: 'AC' },
      { batch: 2, case: 2, points: 1, total: 1, status: 'AC' },
    ];
    const looseFirst = 2 ** 53 + 1 + 1;
    const batchesFirst = 1 + 1 + 2 ** 53;
    // The premise of the test, asserted rather than assumed.
    expect(looseFirst).not.toBe(batchesFirst);
    expect(accumulateSubtasks(summariseCases(cases)).points).toBe(looseFirst);
    expect(oracleAggregateCases(cases).rawPoints).toBe(looseFirst);
  });

  it('sums a loose group in case order, and the order is observable', () => {
    // `null` and `0` are one group, and it is summed in `submission_cases.id`
    // order. Two small values ahead of a large one accumulate into something
    // the large one must round up for; behind it they are lost one at a time.
    const cases: TestCaseSpec[] = [
      { batch: 0, case: 0, points: 1e-4, total: 1, status: 'AC' },
      { batch: null, case: 1, points: 1e-4, total: 1, status: 'AC' },
      { batch: 0, case: 2, points: 2 ** 40, total: 1, status: 'AC' },
    ];
    const reversed = [...cases].reverse();
    // The premise: this input can tell the two orders apart at all.
    expect(oracleAggregateCases(cases).rawPoints).not.toBe(
      oracleAggregateCases(reversed).rawPoints,
    );
    for (const order of [cases, reversed]) {
      expect(accumulateSubtasks(summariseCases(order)).points).toBe(
        oracleAggregateCases(order).rawPoints,
      );
    }
  });
});

describe('summariseCases is lossless for ioi16', () => {
  it('reproduces get_best_subtask_point, values and insertion order, over generated submissions', () => {
    for (const seed of SEEDS) {
      const random = rng(seed);
      const submissions = Array.from({ length: 1 + Math.floor(random() * 4) }, () => ({
        cases: generateCases(random),
      }));
      const expected = oracleBestSubtaskPoints(submissions);
      const actual = bestSubtaskPoints(
        submissions.map((submission) => ({ subtasks: summariseCases(submission.cases) })),
      );
      // Insertion order is load-bearing: the caller sums these sequentially
      // and IEEE addition is not associative, so the Maps must agree as
      // ordered sequences of entries, not merely as sets of them.
      expect([...actual.entries()], `seed ${String(seed)}`).toEqual([...expected.entries()]);
    }
  });

  it('keeps an absent batch absent rather than folding it to zero (ioi16/11)', () => {
    const withBatchTwo = summariseCases([
      { batch: 1, case: 0, points: 10, total: 10, status: 'AC' },
      { batch: 2, case: 1, points: 20, total: 20, status: 'AC' },
    ]);
    const withoutBatchTwo = summariseCases([
      { batch: 1, case: 0, points: 30, total: 10, status: 'AC' },
    ]);
    // The summary INVENTS no group: a submission that never ran batch 2 has no
    // batch-2 row, so there is no zero for the running maximum to see. (With
    // non-negative points this is the only way the distinction is observable —
    // `Math.max(seen ?? 0, x)` and `seen === undefined ? x : Math.max(seen, x)`
    // agree on every non-negative input — so it is asserted on the summariser,
    // where it is a real property, rather than on the fold, where it is not.)
    expect(withoutBatchTwo.map((subtask) => subtask.batch)).toEqual([1]);
    const best = bestSubtaskPoints([{ subtasks: withBatchTwo }, { subtasks: withoutBatchTwo }]);
    expect([...best.entries()]).toEqual([
      [1, 30],
      [2, 20],
    ]);
  });
});
