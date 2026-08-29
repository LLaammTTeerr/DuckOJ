/**
 * A submission carries the contest it was made INTO — `contestKey` /
 * `contestLabel` on both `SubmissionSummary` (the list) and
 * `SubmissionDetail`, `null` for a practice submission.
 *
 * The discriminating row is the practice submission seeded beside the
 * contest's own on the SAME problem: an implementation that derived the
 * contest from "this problem belongs to contest X" instead of from the
 * `contest_submissions` row passes every other assertion here and fails on
 * that one — the same trap `submissions-contest-filter.spec.ts` sets for the
 * filter.
 *
 * The list assertion also pins that the join does not fan rows out:
 * `contest_submissions_submission_idx` is unique on `submission_id`, and a
 * page whose length grew would say the LEFT JOIN had duplicated rows and
 * broken the keyset cursor with it.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import { contests, contestSubmissions, problemRevisions, problems, submissions } from '@duckoj/db/guarded';
import { withTestDb } from './db.harness.js';
import { discoverFixtures, readContest, seedGoldenContest } from './contest-golden.fixtures.js';
import { SubmissionAccessService } from '../src/authz/submission.access.js';
import type { Actor } from '../src/authz/actor.js';

const FIXTURE = discoverFixtures().find((f) => f.id === 'default/02-score-tie')!;
const ADMIN: Actor = { userId: 1, globalRole: 'admin', via: 'session', scopes: [] };

/** A submission to one of the contest's problems that is NOT in the contest. */
async function insertPractice(db: Db): Promise<number> {
  const [problem] = await db
    .select({ id: problems.id, revisionId: problemRevisions.id })
    .from(problems)
    .innerJoin(problemRevisions, eq(problemRevisions.problemId, problems.id))
    .limit(1);
  const [language] = await db.select({ id: schema.languages.id }).from(schema.languages).limit(1);
  const [user] = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
  const [row] = await db
    .insert(submissions)
    .values({
      userId: user!.id,
      problemId: problem!.id,
      revisionId: problem!.revisionId,
      languageId: language!.id,
      source: 'practice',
      state: 'done',
      verdict: 'AC',
    })
    .returning({ id: submissions.id });
  return row!.id;
}

describe('the contest a submission belongs to', () => {
  it('names the contest on every contest submission and nothing on a practice one', async () => {
    await withTestDb(async (db) => {
      const { key, contestId } = await seedGoldenContest(db, readContest(FIXTURE));
      const [contest] = await db
        .select({ name: contests.name, key: contests.key })
        .from(contests)
        .where(eq(contests.id, contestId));
      const inContest = new Set(
        (await db.select({ id: contestSubmissions.submissionId }).from(contestSubmissions)).map(
          (r) => r.id,
        ),
      );
      expect(inContest.size).toBeGreaterThan(0);
      const practiceId = await insertPractice(db);

      const service = new SubmissionAccessService(db);
      const page = await service.listVisible(ADMIN, { limit: 100 });

      // No fan-out: exactly one row per submission, contest or not.
      expect(page.items.length).toBe(inContest.size + 1);

      for (const item of page.items) {
        if (inContest.has(item.id)) {
          expect(item.contestKey).toBe(contest!.key);
          expect(item.contestLabel).toBe(contest!.name);
        } else {
          expect(item.contestKey).toBeNull();
          expect(item.contestLabel).toBeNull();
        }
      }
      expect(key).toBe(contest!.key);

      // The detail route agrees with the list, row for row.
      const contestOne = [...inContest][0]!;
      const detail = await service.getVisible(ADMIN, contestOne);
      expect(detail.contestKey).toBe(contest!.key);
      expect(detail.contestLabel).toBe(contest!.name);

      const practice = await service.getVisible(ADMIN, practiceId);
      expect(practice.contestKey).toBeNull();
      expect(practice.contestLabel).toBeNull();
    });
  }, 120_000);
});
