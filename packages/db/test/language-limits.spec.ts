import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { effectiveLimits, resolveLanguageTuning, schema } from '../src/index.js';
import { withTestDb } from './harness.js';

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
 * Migration 0042's seed, asserted against a database that has only ever had
 * the migrations run on it.
 *
 * The executor names are the load-bearing half. A key mapped to an executor
 * no judge announces is a language whose submissions sit `queued` forever
 * with nothing to grade them (D68), which is strictly worse than not offering
 * the language at all — so these are pinned to what the live judge's own
 * self-test reports, not to what a table in a brief guessed.
 */
describe('migration 0042 seeds the language catalogue', () => {
  it('seeds five languages, with cpp17 unadjusted and python3 adjusted', async () => {
    await withTestDb(async (db) => {
      const rows = await db
        .select({
          key: schema.languages.key,
          name: schema.languages.name,
          extension: schema.languages.extension,
          isActive: schema.languages.isActive,
          timeMultiplierPct: schema.languages.timeMultiplierPct,
          memoryExtraKb: schema.languages.memoryExtraKb,
        })
        .from(schema.languages)
        .orderBy(asc(schema.languages.key));

      expect(rows).toEqual([
        {
          key: 'c11',
          name: 'C11',
          extension: 'c',
          isActive: true,
          timeMultiplierPct: 100,
          memoryExtraKb: 0,
        },
        {
          key: 'cpp14',
          name: 'C++14',
          extension: 'cpp',
          isActive: true,
          timeMultiplierPct: 100,
          memoryExtraKb: 0,
        },
        {
          key: 'cpp17',
          name: 'C++17',
          extension: 'cpp',
          isActive: true,
          timeMultiplierPct: 100,
          memoryExtraKb: 0,
        },
        {
          key: 'cpp20',
          name: 'C++20',
          extension: 'cpp',
          isActive: true,
          timeMultiplierPct: 100,
          memoryExtraKb: 0,
        },
        {
          key: 'python3',
          name: 'Python 3',
          extension: 'py',
          isActive: true,
          timeMultiplierPct: 300,
          memoryExtraKb: 32_768,
        },
      ]);
    });
  });

  it('maps every language to the executor the live judge actually announces', async () => {
    await withTestDb(async (db) => {
      const rows = await db
        .select({ key: schema.languages.key, executorKey: schema.languageDriverKeys.executorKey })
        .from(schema.languageDriverKeys)
        .innerJoin(schema.languages, eq(schema.languages.id, schema.languageDriverKeys.languageId))
        .where(eq(schema.languageDriverKeys.driver, 'dmoj'))
        .orderBy(asc(schema.languages.key));

      // `c11 -> C11`, not `c17 -> C17`: the image ships `C` (-std=c99) and
      // `C11` (-std=c11) and nothing that compiles C17, so a key named `c17`
      // would be exactly the lie `language_driver_keys` exists to prevent.
      // `python3 -> PY3` is the first key whose executor is not its own name
      // uppercased, which is what retired the hard-coded closure in
      // `apps/judged/src/main.ts`.
      expect(rows).toEqual([
        { key: 'c11', executorKey: 'C11' },
        { key: 'cpp14', executorKey: 'CPP14' },
        { key: 'cpp17', executorKey: 'CPP17' },
        { key: 'cpp20', executorKey: 'CPP20' },
        { key: 'python3', executorKey: 'PY3' },
      ]);
    });
  });
});
