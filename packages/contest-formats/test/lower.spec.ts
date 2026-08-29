/**
 * `pointsScalingFactor`'s zero-dataset guard (2026-08 sweep): an all-zero
 * dataset used to yield Infinity, and ioi16 then scored 0 * Infinity = NaN —
 * serialised as null, corrupting the whole scoreboard row.
 */
import { describe, expect, it } from 'vitest';
import { lower, pointsScalingFactor } from '../src/lower.js';
import type { ContestInput, ProblemSpec } from '../src/types.js';

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

/**
 * D36 — `participation_id` is what a submission is matched on when the
 * participant's name is not an identity. Every golden omits it and lowers by
 * name exactly as before; the API sets it on every row.
 */
describe('lower() keys a participation by participation_id when it has one', () => {
  const CONTEST = {
    key: 'k',
    name: 'k',
    start_time: '2026-03-01T09:00:00Z',
    end_time: '2026-03-01T12:00:00Z',
    time_limit_seconds: null,
    points_precision: 3,
    frozen_last_minutes: 0,
  };
  const PROBLEM = { code: 'a', points: 100, partial: true, problem_partial: true };
  const CASES = [{ batch: null, case: 0, points: 100, total: 100, status: 'AC' }];

  function input(withIds: boolean): ContestInput {
    return {
      format: 'icpc',
      format_config: null,
      contest: CONTEST,
      problems: [PROBLEM],
      participants: [
        {
          name: 'alice',
          real_start: '2026-03-01T09:00:00Z',
          virtual: 0,
          ...(withIds ? { participation_id: 11 } : {}),
        },
        {
          name: 'alice',
          real_start: '2026-03-01T09:30:00Z',
          virtual: 1,
          ...(withIds ? { participation_id: 22 } : {}),
        },
      ],
      submissions: [
        {
          participant: 'alice',
          ...(withIds ? { participation_id: 11 } : {}),
          problem: 'a',
          date: '2026-03-01T10:00:00Z',
          result: 'AC',
          status: 'D',
          cases: CASES,
        },
      ],
    };
  }

  it('gives one person two participations, and the submission to exactly one', () => {
    const lowered = lower(input(true));
    expect(lowered.participations).toHaveLength(2);
    expect(lowered.participations.map((p) => p.submissions.length)).toEqual([1, 0]);
    // The name is still what a ranking row prints.
    expect(lowered.participations.map((p) => p.name)).toEqual(['alice', 'alice']);
  });

  it('refuses two participations under one key rather than silently merging them', () => {
    expect(() => lower(input(false))).toThrow(/share one key/);
  });
});
