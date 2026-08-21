/**
 * The one rule in the mapping's read path that no golden can cover: a regrade
 * leaves the previous attempt's `submission_cases` rows in place beside the
 * new ones (`event-writer.ts` inserts with `onConflictDoNothing` and never
 * deletes), so the scoreboard must read **only the latest attempt**.
 *
 * The goldens are all single-attempt, so this is a decision made in
 * `ContestAccessService.loadSubmissionRows` rather than a test result — which
 * is exactly why it needs a test of its own. Both directions are pinned here:
 * a duplicate attempt must not double-count, and a *newer* attempt must win.
 */
import { describe, expect, it } from 'vitest';
import { asc, inArray } from 'drizzle-orm';
import { contestSubmissions, submissionCases } from '@duckoj/db/guarded';
import type { Db } from '@duckoj/db';
import { ContestAccessService } from '../src/authz/contest.access.js';
import { withTestDb } from './db.harness.js';
import { discoverFixtures, readContest, readJson, seedGoldenContest } from './contest-golden.fixtures.js';
import { join } from 'node:path';
import type { Scoreboard } from '@duckoj/contest-formats';

const FIXTURE = discoverFixtures().find((f) => f.id === 'default/02-score-tie')!;

/** Copies every case of every submission into a second attempt, via `mutate`. */
async function addSecondAttempt(db: Db, mutate: (points: number) => number): Promise<void> {
  const submissionIds = (
    await db.select({ id: contestSubmissions.submissionId }).from(contestSubmissions)
  ).map((row) => row.id);
  const rows = await db
    .select()
    .from(submissionCases)
    .where(inArray(submissionCases.submissionId, submissionIds))
    .orderBy(asc(submissionCases.id));
  if (rows.length === 0) return;
  await db.insert(submissionCases).values(
    rows.map((row) => ({
      submissionId: row.submissionId,
      attempt: row.attempt + 1,
      groupIndex: row.groupIndex,
      caseIndex: row.caseIndex,
      verdict: row.verdict,
      skipped: row.skipped,
      flags: row.flags,
      timeMs: row.timeMs,
      memoryKb: row.memoryKb,
      points: mutate(row.points),
      maxPoints: row.maxPoints,
    })),
  );
}

describe('a regraded submission is scored on its latest attempt only', () => {
  /**
   * Halved, not duplicated. An *identical* second attempt is invisible here
   * however the query is written: `contestSubmissionPoints` divides case
   * points by case totals, and duplication doubles both — a test asserting on
   * one would pass against a mapping with no attempt filter at all. Halving
   * separates the three possible readings: the first attempt scores `p/t`,
   * the second `p/2t`, and the two mixed (no filter) `1.5p/2t`.
   */
  it('a second attempt scoring half wins outright — the two are never mixed', async () => {
    await withTestDb(async (db) => {
      const { key } = await seedGoldenContest(db, readContest(FIXTURE));
      const golden = readJson(join(FIXTURE.dir, 'scoreboard.json')) as Scoreboard;
      // Guards against a vacuous "half of nothing is nothing".
      expect(golden.ranking.some((row) => row.score > 0)).toBe(true);

      await addSecondAttempt(db, (points) => points / 2);

      const board = await new ContestAccessService(db).getScoreboard(null, key);
      const byName = new Map(board.ranking.map((row) => [row.participant, row.score]));
      for (const row of golden.ranking) {
        expect([row.participant, byName.get(row.participant)]).toEqual([
          row.participant,
          row.score / 2,
        ]);
      }
    });
  }, 120_000);

  it('a zeroed second attempt wins over the first', async () => {
    await withTestDb(async (db) => {
      const { key } = await seedGoldenContest(db, readContest(FIXTURE));
      const before = await new ContestAccessService(db).getScoreboard(null, key);
      expect(before.ranking.some((row) => row.score > 0)).toBe(true);

      await addSecondAttempt(db, () => 0);

      const after = await new ContestAccessService(db).getScoreboard(null, key);
      expect(after.ranking.map((row) => row.score)).toEqual(after.ranking.map(() => 0));
    });
  }, 120_000);
});
