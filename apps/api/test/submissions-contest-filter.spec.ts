/**
 * `GET /submissions?contest=` — submissions made INTO the contest, never
 * practice submissions that merely target its problems. The golden seeder
 * builds the real thing (participations + contest_submissions), and the
 * discriminating row is a practice submission inserted beside them on the
 * same problem: a filter implemented as "submissions to this contest's
 * problems" passes every other assertion here and fails on that one.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import { contestSubmissions, problemRevisions, problems, submissions } from '@duckoj/db/guarded';
import { withTestDb } from './db.harness.js';
import { discoverFixtures, readContest, seedGoldenContest } from './contest-golden.fixtures.js';
import { SubmissionAccessService } from '../src/authz/submission.access.js';
import type { Actor } from '../src/authz/actor.js';

const FIXTURE = discoverFixtures().find((f) => f.id === 'default/02-score-tie')!;
const ADMIN: Actor = { userId: 1, globalRole: 'admin', via: 'session', scopes: [] };

async function insertPractice(db: Db): Promise<number> {
  // The golden seeder does not set `currentRevisionId`; any revision of
  // the problem serves — practice-ness is about contest_submissions, not
  // which revision graded it.
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

describe('the contest filter', () => {
  it('returns exactly the contest_submissions set — practice rows on the same problems stay out', async () => {
    await withTestDb(async (db) => {
      const { key } = await seedGoldenContest(db, readContest(FIXTURE));
      const inContest = new Set(
        (await db.select({ id: contestSubmissions.submissionId }).from(contestSubmissions)).map(
          (r) => r.id,
        ),
      );
      expect(inContest.size).toBeGreaterThan(0);
      const practiceId = await insertPractice(db);

      const service = new SubmissionAccessService(db);
      // Case-insensitively, like every other key lookup.
      const page = await service.listVisible(ADMIN, { limit: 50, contest: key.toUpperCase() });
      const listed = new Set(page.items.map((s) => s.id));
      expect(listed).toEqual(inContest);
      expect(listed.has(practiceId)).toBe(false);

      // Unfiltered, the practice row is visible — the filter is what
      // excluded it, not submission visibility.
      const all = await service.listVisible(ADMIN, { limit: 50 });
      expect(all.items.some((s) => s.id === practiceId)).toBe(true);
    });
  }, 120_000);

  it('an unknown contest key is an empty page, not an error', async () => {
    await withTestDb(async (db) => {
      await seedGoldenContest(db, readContest(FIXTURE));
      const service = new SubmissionAccessService(db);
      const page = await service.listVisible(ADMIN, { limit: 50, contest: 'no-such-contest' });
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });
  }, 120_000);
});
