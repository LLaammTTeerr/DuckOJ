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
import { asc, eq, inArray } from 'drizzle-orm';
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
  it('an identical second attempt does not double-count', async () => {
    await withTestDb(async (db) => {
      const input = readContest(FIXTURE);
      const { key } = await seedGoldenContest(db, input);
      await addSecondAttempt(db, (points) => points);

      const board = await new ContestAccessService(db).getScoreboard(null, key);
      const golden = readJson(join(FIXTURE.dir, 'scoreboard.json')) as Scoreboard;
      // Reading both attempts would sum every loose case twice, so this
      // assertion fails loudly against a mapping without the filter.
      expect(board.ranking.map((row) => row.score)).toEqual(golden.ranking.map((row) => row.score));
    });
  }, 120_000);

  it('a zeroed second attempt wins over the first', async () => {
    await withTestDb(async (db) => {
      const input = readContest(FIXTURE);
      const { key } = await seedGoldenContest(db, input);
      const before = await new ContestAccessService(db).getScoreboard(null, key);
      expect(before.ranking.some((row) => row.score > 0)).toBe(true);

      await addSecondAttempt(db, () => 0);

      const after = await new ContestAccessService(db).getScoreboard(null, key);
      expect(after.ranking.map((row) => row.score)).toEqual(after.ranking.map(() => 0));
    });
  }, 120_000);

  it('the fixture it relies on has cases to duplicate', async () => {
    await withTestDb(async (db) => {
      const { key } = await seedGoldenContest(db, readContest(FIXTURE));
      const cases = await db
        .select()
        .from(submissionCases)
        .where(eq(submissionCases.attempt, 1));
      expect(cases.length).toBeGreaterThan(0);
      expect(key).toBe(readContest(FIXTURE).contest.key);
    });
  }, 120_000);
});
