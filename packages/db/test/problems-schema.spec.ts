import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  problemMembers,
  problemRevisions,
  problems,
  submissionCases,
  submissions,
} from '../src/schema/guarded.js';
import { schema } from '../src/index.js';
import { withTestDb } from './harness.js';

describe('problems schema', () => {
  it('permits one user to hold two roles on the same problem', async () => {
    await withTestDb(async (db) => {
      const [user] = await db
        .insert(schema.users)
        .values({
          username: 'dana',
          email: 'dana@example.com',
          passwordHash: 'x',
          displayName: 'Dana',
        })
        .returning();
      const [problem] = await db
        .insert(problems)
        .values({ code: 'p1', name: 'P1', statement: 's', createdBy: user!.id })
        .returning();
      await db.insert(problemMembers).values([
        { problemId: problem!.id, userId: user!.id, role: 'author' },
        { problemId: problem!.id, userId: user!.id, role: 'curator' },
      ]);
      const rows = await db
        .select()
        .from(problemMembers)
        .where(eq(problemMembers.problemId, problem!.id));
      expect(rows).toHaveLength(2);
    });
  }, 120_000);

  it('rejects a duplicate (problem, version)', async () => {
    await withTestDb(async (db) => {
      const [user] = await db
        .insert(schema.users)
        .values({
          username: 'erin',
          email: 'erin@example.com',
          passwordHash: 'x',
          displayName: 'Erin',
        })
        .returning();
      const [problem] = await db
        .insert(problems)
        .values({ code: 'p2', name: 'P2', statement: 's', createdBy: user!.id })
        .returning();
      await db.insert(schema.packages).values({ hash: 'ps-hash-1', sizeBytes: 1, fileCount: 1 });
      const revisionRow = {
        problemId: problem!.id,
        version: 1,
        packageHash: 'ps-hash-1',
        state: 'draft' as const,
        createdBy: user!.id,
        timeMs: 1000,
        memoryKb: 256_000,
        testCount: 5,
        totalPoints: 100,
        checkerKind: 'wcmp',
      };
      await db.insert(problemRevisions).values(revisionRow);

      await expect(db.insert(problemRevisions).values(revisionRow)).rejects.toThrow();
    });
  }, 120_000);

  it('accepts CE as a case verdict', async () => {
    await withTestDb(async (db) => {
      const [user] = await db
        .insert(schema.users)
        .values({
          username: 'frank',
          email: 'frank@example.com',
          passwordHash: 'x',
          displayName: 'Frank',
        })
        .returning();
      // Migration 0042 seeds the language catalogue (F-39/D154), so `cpp17`
      // exists in every migrated database and inserting it here is now a unique
      // violation on `languages_key_idx`. Read it instead: after 0042 the
      // catalogue is schema-seeded data, not something a fixture owns.
      const [language] = await db
        .select()
        .from(schema.languages)
        .where(eq(schema.languages.key, 'cpp17'));
      const [problem] = await db
        .insert(problems)
        .values({ code: 'p3', name: 'P3', statement: 's', createdBy: user!.id })
        .returning();
      await db.insert(schema.packages).values({ hash: 'ps-hash-2', sizeBytes: 1, fileCount: 1 });
      const [revision] = await db
        .insert(problemRevisions)
        .values({
          problemId: problem!.id,
          version: 1,
          packageHash: 'ps-hash-2',
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
          verdict: 'CE',
        })
        .returning();

      expect(submission?.verdict).toBe('CE');

      await db.insert(submissionCases).values({
        submissionId: submission!.id,
        attempt: 1,
        groupIndex: 0,
        caseIndex: 0,
        verdict: 'CE',
        timeMs: 0,
        memoryKb: 0,
        points: 0,
        maxPoints: 1,
      });

      const cases = await db
        .select()
        .from(submissionCases)
        .where(eq(submissionCases.submissionId, submission!.id));
      expect(cases[0]?.verdict).toBe('CE');
    });
  }, 120_000);
});
