/**
 * `pointsScalingFactor`'s zero-dataset guard (2026-08 sweep): an all-zero
 * dataset used to yield Infinity, and ioi16 then scored 0 * Infinity = NaN —
 * serialised as null, corrupting the whole scoreboard row.
 */
import { describe, expect, it } from 'vitest';
import { pointsScalingFactor } from '../src/lower.js';
import type { ProblemSpec } from '../src/types.js';

function problemWith(cases: Array<{ type: 'C' | 'S' | 'E'; points: number | null }>): ProblemSpec {
  return {
    code: 'p',
    points: 100,
    partial: true,
    problem_partial: true,
    problem_test_cases: cases.map((c, i) => ({ order: i, type: c.type, points: c.points })),
  } as unknown as ProblemSpec;
}

describe('pointsScalingFactor', () => {
  it('an all-zero dataset scales to 0, never Infinity', () => {
    const factor = pointsScalingFactor(problemWith([{ type: 'C', points: 0 }, { type: 'C', points: 0 }]));
    expect(factor).toBe(0);
    expect(Number.isFinite(factor!)).toBe(true);
  });

  it('a normal dataset still divides', () => {
    expect(pointsScalingFactor(problemWith([{ type: 'C', points: 50 }]))).toBe(2);
  });

  it('no dataset at all stays null (the generator recorded null)', () => {
    expect(pointsScalingFactor(problemWith([]))).toBeNull();
  });
});
