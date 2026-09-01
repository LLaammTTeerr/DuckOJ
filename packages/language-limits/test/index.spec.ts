import { describe, expect, it } from 'vitest';
import {
  MEMORY_EXTRA_KB_MAX,
  MEMORY_EXTRA_KB_MIN,
  TIME_MULTIPLIER_PCT_MAX,
  TIME_MULTIPLIER_PCT_MIN,
  effectiveLimits,
  resolveLanguageTuning,
} from '../src/index.js';

/**
 * D154. These are pure functions on purpose — the arithmetic that decides
 * whether a submission TLEs must be testable without a judge, a container or
 * a submission — and they are the SINGLE implementation: `apps/api` calls
 * them to display a limit and `apps/judged` calls them to enforce one.
 */
describe('effectiveLimits', () => {
  it('leaves an unadjusted language exactly as the setter authored it', () => {
    expect(
      effectiveLimits(
        { timeMs: 2000, memoryKb: 262_144 },
        { timeMultiplierPct: 100, memoryExtraKb: 0, allowed: true },
      ),
    ).toEqual({ timeMs: 2000, memoryKb: 262_144 });
  });

  it('multiplies time and ADDS memory', () => {
    // 300 % of 2000 ms, and CPython's floor on top of the authored 256 MB —
    // not 300 % of the memory, which would hand a generous problem three
    // quarters of a gigabyte for a floor that is 15 MB wide.
    expect(
      effectiveLimits(
        { timeMs: 2000, memoryKb: 262_144 },
        { timeMultiplierPct: 300, memoryExtraKb: 32_768, allowed: true },
      ),
    ).toEqual({ timeMs: 6000, memoryKb: 294_912 });
  });

  it('rounds a fractional millisecond UP, and stays integral', () => {
    // 333 % of 1001 ms is 3333.33. The error is one millisecond and it
    // belongs to the pupil; a `round` here would take it away from them, and
    // a float would hand the judge a limit no clock can express.
    const limits = effectiveLimits(
      { timeMs: 1001, memoryKb: 1024 },
      { timeMultiplierPct: 333, memoryExtraKb: 0, allowed: true },
    );
    expect(limits.timeMs).toBe(3334);
    expect(Number.isInteger(limits.timeMs)).toBe(true);
  });

  it('does not consult `allowed` — a refused language is refused, not timed out', () => {
    // A refusal presents as a 404 at submit time (see
    // `SubmissionAccessService.create`). If it leaked into the arithmetic as
    // a zero limit, the pupil would be shown a TLE and told their correct
    // program was too slow.
    expect(
      effectiveLimits(
        { timeMs: 1000, memoryKb: 65_536 },
        { timeMultiplierPct: 300, memoryExtraKb: 32_768, allowed: false },
      ),
    ).toEqual({ timeMs: 3000, memoryKb: 98_304 });
  });
});

describe('resolveLanguageTuning', () => {
  const defaults = { timeMultiplierPct: 300, memoryExtraKb: 32_768 };

  it('uses the language defaults when the problem says nothing', () => {
    expect(resolveLanguageTuning(defaults, null)).toEqual({
      timeMultiplierPct: 300,
      memoryExtraKb: 32_768,
      allowed: true,
    });
  });

  it('inherits COLUMN BY COLUMN, so pinning the time keeps the memory floor', () => {
    // The whole reason both override columns are nullable: a setter saying
    // "no time bonus here, the problem is about the constant factor" has said
    // nothing about memory, and silently dropping CPython's 32 MB floor with
    // it would MRE every Python submission on a problem that still accepts
    // them.
    expect(
      resolveLanguageTuning(defaults, {
        timeMultiplierPct: 100,
        memoryExtraKb: null,
        allowed: true,
      }),
    ).toEqual({ timeMultiplierPct: 100, memoryExtraKb: 32_768, allowed: true });
  });

  it('treats an explicit 0 as a value, not as absent', () => {
    expect(
      resolveLanguageTuning(defaults, { timeMultiplierPct: null, memoryExtraKb: 0, allowed: true }),
    ).toEqual({ timeMultiplierPct: 300, memoryExtraKb: 0, allowed: true });
  });

  it('carries a refusal through', () => {
    expect(
      resolveLanguageTuning(defaults, {
        timeMultiplierPct: null,
        memoryExtraKb: null,
        allowed: false,
      }).allowed,
    ).toBe(false);
  });
});
/**
 * D159 — the bounds, as CONSTANTS, before anything enforces them.
 *
 * Three layers enforce these numbers (a CHECK in migration 0043, the zod
 * bounds on `PUT /problems/{code}/language-limits`, and the authoring form),
 * and the reason they can be three rather than three different sets of
 * numbers is that they all read this module. What is asserted here is the
 * property each of them depends on, rather than the digits: that the floors
 * are exactly "changes nothing" in each unit.
 */
describe('the bounds an adjustment must satisfy', () => {
  it('floors at "takes nothing away", in each unit', () => {
    // A multiplier of 100 % and an addend of 0 KB are the same statement in
    // two units: leave the setter's authored limit exactly as it is. Below
    // either, a correct program is failed by policy while being told it was
    // failed by speed or by size — which is what `allowed = false` is for.
    expect(
      effectiveLimits(
        { timeMs: 1000, memoryKb: 65_536 },
        {
          timeMultiplierPct: TIME_MULTIPLIER_PCT_MIN,
          memoryExtraKb: MEMORY_EXTRA_KB_MIN,
          allowed: true,
        },
      ),
    ).toEqual({ timeMs: 1000, memoryKb: 65_536 });
  });

  it('admits what migration 0042 seeds, including python3 at 300 %', () => {
    // A bound that excluded a seeded value would make a fresh install fail on
    // its own seed: 0042 runs immediately before 0043.
    for (const pct of [100, 300]) {
      expect(pct).toBeGreaterThanOrEqual(TIME_MULTIPLIER_PCT_MIN);
      expect(pct).toBeLessThanOrEqual(TIME_MULTIPLIER_PCT_MAX);
    }
    for (const kb of [0, 32_768]) {
      expect(kb).toBeGreaterThanOrEqual(MEMORY_EXTRA_KB_MIN);
      expect(kb).toBeLessThanOrEqual(MEMORY_EXTRA_KB_MAX);
    }
  });

  it('keeps the ceiling inside D154’s own denial-of-service argument', () => {
    // D154 rejected the measured 110x interpreter factor because "a 350-test
    // problem at 1 s becomes 350 s of judge time per Python submission on a
    // single-judge fleet". At the ceiling that same problem costs under an
    // hour for one submission; one step past it, over.
    const worstCaseSeconds = (pct: number): number => (350 * 1000 * pct) / 100 / 1000;
    expect(worstCaseSeconds(TIME_MULTIPLIER_PCT_MAX)).toBeLessThanOrEqual(3600);
    expect(worstCaseSeconds(TIME_MULTIPLIER_PCT_MAX + 100)).toBeGreaterThan(3600);
  });
});
