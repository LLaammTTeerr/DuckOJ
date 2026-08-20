import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { problems, problemRevisions, submissions, submissionCases } from '../src/schema/guarded.js';
import { schema } from '../src/index.js';
import { withTestDb } from './harness.js';

describe('judging schema', () => {
  it('links a submission to a user, a revision and its cases', async () => {
    await withTestDb(async (db) => {
      const [user] = await db
        .insert(schema.users)
        .values({ username: 'sub', email: 's@e.com', passwordHash: 'x', displayName: 'S' })
        .returning();
      const [language] = await db
        .insert(schema.languages)
        .values({ key: 'cpp17', name: 'C++17', extension: 'cpp' })
        .returning();
      const [problem] = await db
        .insert(problems)
        .values({ code: 'aplusb', name: 'A+B', statement: 'Add two numbers.', createdBy: user!.id })
        .returning();
      await db.insert(schema.packages).values({ hash: 'deadbeef', sizeBytes: 1, fileCount: 1 });
      const [revision] = await db
        .insert(problemRevisions)
        .values({
          problemId: problem!.id,
          version: 1,
          packageHash: 'deadbeef',
          state: 'published',
          createdBy: user!.id,
          timeMs: 1000,
          memoryKb: 256_000,
          testCount: 5,
          totalPoints: 100,
          checkerKind: 'wcmp',
        })
        .returning();

      const [submission] = await db
        .insert(submissions)
        .values({
          userId: user!.id,
          problemId: problem!.id,
          revisionId: revision!.id,
          languageId: language!.id,
          source: 'int main(){}',
        })
        .returning();

      expect(submission?.state).toBe('queued');
      expect(submission?.verdict).toBeNull();

      await db.insert(submissionCases).values({
        submissionId: submission!.id,
        attempt: 1,
        groupIndex: 0,
        caseIndex: 0,
        verdict: 'AC',
        timeMs: 4,
        memoryKb: 1024,
        points: 1,
        maxPoints: 1,
      });

      const cases = await db
        .select()
        .from(submissionCases)
        .where(eq(submissionCases.submissionId, submission!.id));
      expect(cases[0]?.verdict).toBe('AC');
      expect(cases[0]?.skipped).toBe(false);
    });
  }, 120_000);

  it('allows a null verdict on a skipped case', async () => {
    await withTestDb(async (db) => {
      const [user] = await db
        .insert(schema.users)
        .values({ username: 'sk', email: 'sk@e.com', passwordHash: 'x', displayName: 'K' })
        .returning();
      const [language] = await db
        .insert(schema.languages)
        .values({ key: 'cpp17', name: 'C++17', extension: 'cpp' })
        .returning();
      const [problem] = await db
        .insert(problems)
        .values({ code: 'p', name: 'P', statement: 's', createdBy: user!.id })
        .returning();
      await db.insert(schema.packages).values({ hash: 'h', sizeBytes: 1, fileCount: 1 });
      const [revision] = await db
        .insert(problemRevisions)
        .values({
          problemId: problem!.id,
          version: 1,
          packageHash: 'h',
          state: 'published',
          createdBy: user!.id,
          timeMs: 1000,
          memoryKb: 256_000,
          testCount: 5,
          totalPoints: 100,
          checkerKind: 'wcmp',
        })
        .returning();
      const [submission] = await db
        .insert(submissions)
        .values({
          userId: user!.id,
          problemId: problem!.id,
          revisionId: revision!.id,
          languageId: language!.id,
          source: 'x',
        })
        .returning();

      const [skipped] = await db
        .insert(submissionCases)
        .values({
          submissionId: submission!.id,
          attempt: 1,
          groupIndex: 0,
          caseIndex: 1,
          verdict: null,
          skipped: true,
          timeMs: 0,
          memoryKb: 0,
          points: 0,
          maxPoints: 1,
        })
        .returning();

      expect(skipped?.verdict).toBeNull();
      expect(skipped?.skipped).toBe(true);
    });
  }, 120_000);

  it('rejects two cases with the same (submission, attempt, group, case)', async () => {
    await withTestDb(async (db) => {
      const [user] = await db
        .insert(schema.users)
        .values({ username: 'dup', email: 'd@e.com', passwordHash: 'x', displayName: 'D' })
        .returning();
      const [language] = await db
        .insert(schema.languages)
        .values({ key: 'cpp17', name: 'C++17', extension: 'cpp' })
        .returning();
      const [problem] = await db
        .insert(problems)
        .values({ code: 'q', name: 'Q', statement: 's', createdBy: user!.id })
        .returning();
      await db.insert(schema.packages).values({ hash: 'h2', sizeBytes: 1, fileCount: 1 });
      const [revision] = await db
        .insert(problemRevisions)
        .values({
          problemId: problem!.id,
          version: 1,
          packageHash: 'h2',
          state: 'published',
          createdBy: user!.id,
          timeMs: 1000,
          memoryKb: 256_000,
          testCount: 5,
          totalPoints: 100,
          checkerKind: 'wcmp',
        })
        .returning();
      const [submission] = await db
        .insert(submissions)
        .values({
          userId: user!.id,
          problemId: problem!.id,
          revisionId: revision!.id,
          languageId: language!.id,
          source: 'x',
        })
        .returning();

      const row = {
        submissionId: submission!.id,
        attempt: 1,
        groupIndex: 0,
        caseIndex: 0,
        verdict: 'AC' as const,
        timeMs: 1,
        memoryKb: 1,
        points: 1,
        maxPoints: 1,
      };
      await db.insert(submissionCases).values(row);

      // This is what makes at-least-once delivery harmless: a redelivered
      // case result collides instead of duplicating.
      await expect(db.insert(submissionCases).values(row)).rejects.toThrow();
    });
  }, 120_000);

  // Controller ruling R2: languageDriverKeys is defined but not exercised by
  // the tests above. A later task inserts into it (mapping our language key
  // to a judge driver's own executor key, e.g. dmoj's `CPP17`), so a column
  // mismatch here — not there — is where it should surface.
  it('maps a language to a driver executor key and reads it back', async () => {
    await withTestDb(async (db) => {
      const [language] = await db
        .insert(schema.languages)
        .values({ key: 'cpp17', name: 'C++17', extension: 'cpp' })
        .returning();

      await db.insert(schema.languageDriverKeys).values({
        languageId: language!.id,
        driver: 'dmoj',
        executorKey: 'CPP17',
      });

      const rows = await db
        .select()
        .from(schema.languageDriverKeys)
        .where(eq(schema.languageDriverKeys.languageId, language!.id));

      expect(rows[0]?.driver).toBe('dmoj');
      expect(rows[0]?.executorKey).toBe('CPP17');
    });
  }, 120_000);

  // Task 12: `problem_revisions.package_hash` gained a foreign key to
  // `packages.hash` once `scripts/seed-problem.ts` proved it could repoint
  // an existing revision off a hash satisfying no such row (see
  // `packages/db/test/seed-script.spec.ts`). This is the other half — the
  // constraint itself must actually reject what it claims to.
  it('rejects a problem_revisions row whose package_hash matches no package', async () => {
    await withTestDb(async (db) => {
      const [user] = await db
        .insert(schema.users)
        .values({ username: 'fk', email: 'fk@e.com', passwordHash: 'x', displayName: 'F' })
        .returning();
      const [problem] = await db
        .insert(problems)
        .values({ code: 'r', name: 'R', statement: 's', createdBy: user!.id })
        .returning();

      await expect(
        db.insert(problemRevisions).values({
          problemId: problem!.id,
          version: 1,
          packageHash: 'no-such-package',
          state: 'published',
          createdBy: user!.id,
          timeMs: 1000,
          memoryKb: 256_000,
          testCount: 5,
          totalPoints: 100,
          checkerKind: 'wcmp',
        }),
      ).rejects.toThrow();
    });
  }, 120_000);
});
