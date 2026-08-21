/**
 * **The acceptance criterion for Phase 4c** (design §2).
 *
 * Every golden's `contest.json` is a complete contest: problems, participants,
 * submissions with per-case batches and timings. So each one is seeded into a
 * real Postgres, its scoreboard is computed through the real service, and the
 * result is compared against the **same input run directly through the same
 * production semantics** — differing only in whether it travelled through the
 * database.
 *
 * It is deliberately *not* compared against the golden's `scoreboard.json`.
 * DuckOJ diverges from DMOJ in two places
 * (`docs/superpowers/specs/2026-08-21-contest-divergences-design.md`), so four
 * goldens no longer describe production output. This suite's job is the
 * mapping, not format arithmetic; pinning the frozen bytes stays in
 * `packages/contest-formats`' `dmojCompat` suite, which is where it belongs.
 * Editing a fixture to match new behaviour would destroy the provenance that
 * makes the corpus worth having, and is never the fix.
 *
 * That reuses 23 fixtures for something they were never built for. 4b's tests
 * prove the formats are right *given correct input*; these prove the mapping
 * *produces* correct input. The failure isolates cleanly: if
 * `packages/contest-formats` is green and this is red, the bug is in
 * `contest.mapping.ts` — every time.
 *
 * Three properties this harness holds, mirroring 4b's:
 *
 * 1. The fixture directory is **enumerated**, never listed.
 * 2. Whole objects are compared — `ranking`, `problems` and
 *    `label_by_problem` in full, never field-picked.
 * 3. Floats are normalised exactly the way the generator normalised the
 *    goldens (`pyRound(value, 9)`, `-0` folded to `0`), using the *golden's*
 *    normalisation imported from the package, never a re-derived one. Both
 *    sides are normalised here, since neither is a frozen file any more.
 *
 * The scoreboard is read as an **anonymous** actor against a public contest,
 * so the visibility predicate is inside the loop rather than beside it.
 */
import { describe, expect, it } from 'vitest';
import { computeContestScoreboard, pyRound } from '@duckoj/contest-formats';
import type { Scoreboard } from '@duckoj/contest-formats';
import { ContestAccessService } from '../src/authz/contest.access.js';
import { withTestDb } from './db.harness.js';
import { discoverFixtures, readContest, seedGoldenContest } from './contest-golden.fixtures.js';

/** `_generator/generate.py:norm()`, applied to the computed side only. */
function norm(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isInteger(value)) {
    const rounded = pyRound(value, 9);
    return rounded === 0 ? 0 : rounded;
  }
  if (typeof value === 'number') return value === 0 ? 0 : value;
  if (Array.isArray(value)) return value.map(norm);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, norm(item)]));
  }
  return value;
}

const FIXTURES = discoverFixtures();

describe('golden replay through Postgres', () => {
  it('discovers the fixture directory rather than a hard-coded list', () => {
    // Deliberately not an equality on 23: an exact count is the hard-coded
    // list in disguise, and would have to be edited when a fixture is added.
    expect(FIXTURES.length).toBeGreaterThan(0);
    expect(FIXTURES.map((fixture) => fixture.id)).toContain('ioi16/10-points-scaling-factor');
  });

  it.each(FIXTURES)('$id', async (fixture) => {
    await withTestDb(async (db) => {
      const input = readContest(fixture);
      const { key } = await seedGoldenContest(db, input);

      const service = new ContestAccessService(db);
      const actual = norm(await service.getScoreboard(null, key)) as Scoreboard;
      // The same input, the same formats, without the round trip. A mismatch
      // therefore isolates to the mapping and nothing else.
      const expected = norm(computeContestScoreboard(input)) as Scoreboard;

      // Whole objects, not selected fields.
      expect(actual.ranking).toEqual(expected.ranking);
      expect(actual.problems).toEqual(expected.problems);
      expect(actual.label_by_problem).toEqual(expected.label_by_problem);
    });
  }, 60_000);
});
