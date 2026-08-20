import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@duckoj/db';
import type { Db } from '@duckoj/db';
import { problemMembers, problemRevisions, problems, submissions } from '@duckoj/db/guarded';
import type { Actor } from '../src/authz/actor.js';
import { ProblemAccessService } from '../src/authz/problem.access.js';
import { SubmissionAccessService } from '../src/authz/submission.access.js';
import type { PackageStore } from '../src/packages/package.store.js';
import { withTestDb } from './db.harness.js';
import { insertUser } from './submissions.fixtures.js';

function actorFor(userId: number, globalRole: 'user' | 'setter' | 'admin' = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

/**
 * `publishRevision`/`listRevisions` never touch the package store (that's
 * `attachRevision`'s job) — throwing on every call turns an accidental
 * future dependency into a loud test failure instead of a silent no-op.
 * Mirrors `problem-writes.spec.ts`'s `UNUSED_STORE`.
 */
const UNUSED_STORE: PackageStore = {
  has: () => Promise.reject(new Error('unexpected package store access in this test')),
  put: () => Promise.reject(new Error('unexpected package store access in this test')),
  get: () => Promise.reject(new Error('unexpected package store access in this test')),
  delete: () => Promise.reject(new Error('unexpected package store access in this test')),
};

async function seedProblem(db: Db, opts: { code: string; createdBy: number }): Promise<{ id: number }> {
  const [problem] = await db
    .insert(problems)
    .values({ code: opts.code, name: opts.code, statement: 'statement', createdBy: opts.createdBy })
    .returning();
  return { id: problem!.id };
}

/**
 * Inserts a draft `problemRevisions` row directly, skipping the real package
 * pipeline entirely (a distinct dummy `packages` row per hash is all the
 * `packageHash` foreign key needs). `timeMs` defaults differ by version on
 * purpose so a test can tell, after publishing, which revision's limits a
 * read is reporting.
 */
async function seedRevision(
  db: Db,
  opts: { problemId: number; version: number; createdBy: number; timeMs?: number },
): Promise<{ id: number }> {
  const hash = `pub-${opts.problemId}-${opts.version}`;
  await db.insert(schema.packages).values({ hash, sizeBytes: 1, fileCount: 1 }).onConflictDoNothing();
  const [revision] = await db
    .insert(problemRevisions)
    .values({
      problemId: opts.problemId,
      version: opts.version,
      packageHash: hash,
      state: 'draft',
      createdBy: opts.createdBy,
      timeMs: opts.timeMs ?? 1000,
      memoryKb: 65536,
      testCount: 2,
      totalPoints: 100,
      checkerKind: 'standard',
    })
    .returning();
  return { id: revision!.id };
}

async function seedLanguage(db: Db, key: string): Promise<void> {
  await db.insert(schema.languages).values({ key, name: key, extension: 'cpp' });
}

describe('ProblemAccessService.publishRevision', () => {
  it('publishing a draft sets it published and points current_revision_id at it', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'pub-owner1');
      const { id } = await seedProblem(db, { code: 'pub1', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const rev1 = await seedRevision(db, { problemId: id, version: 1, createdBy: owner.id });
      const service = new ProblemAccessService(db, UNUSED_STORE);

      const result = await service.publishRevision(actorFor(owner.id), 'pub1', 1);
      expect(result).toEqual({ version: 1 });

      const [revRow] = await db.select().from(problemRevisions).where(eq(problemRevisions.id, rev1.id));
      expect(revRow!.state).toBe('published');
      const [problemRow] = await db.select().from(problems).where(eq(problems.id, id));
      expect(problemRow!.currentRevisionId).toBe(rev1.id);
    });
  }, 120_000);

  it('publishing a second revision archives the first', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'pub-owner2');
      const { id } = await seedProblem(db, { code: 'pub2', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const rev1 = await seedRevision(db, { problemId: id, version: 1, createdBy: owner.id, timeMs: 1000 });
      const rev2 = await seedRevision(db, { problemId: id, version: 2, createdBy: owner.id, timeMs: 2000 });
      const service = new ProblemAccessService(db, UNUSED_STORE);

      await service.publishRevision(actorFor(owner.id), 'pub2', 1);
      const result = await service.publishRevision(actorFor(owner.id), 'pub2', 2);
      expect(result).toEqual({ version: 2 });

      const [rev1Row] = await db.select().from(problemRevisions).where(eq(problemRevisions.id, rev1.id));
      expect(rev1Row!.state).toBe('archived');
      const [rev2Row] = await db.select().from(problemRevisions).where(eq(problemRevisions.id, rev2.id));
      expect(rev2Row!.state).toBe('published');
      const [problemRow] = await db.select().from(problems).where(eq(problems.id, id));
      expect(problemRow!.currentRevisionId).toBe(rev2.id);

      // The join `listVisible`/`getVisible` rely on (`currentRevisionId` +
      // `state = 'published'`) must still be true after the swap, and it
      // must be reporting v2's limits, not v1's stale ones.
      const detail = await service.getVisible(actorFor(owner.id), 'pub2');
      expect(detail.hasPublishedRevision).toBe(true);
      expect(detail.timeMs).toBe(2000);
    });
  }, 120_000);

  it('a submission made against the archived revision still reads back its own revision', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'pub-owner3');
      const solver = await insertUser(db, 'pub-solver3');
      const { id } = await seedProblem(db, { code: 'pub3', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const rev1 = await seedRevision(db, { problemId: id, version: 1, createdBy: owner.id });
      const rev2 = await seedRevision(db, { problemId: id, version: 2, createdBy: owner.id });
      await seedLanguage(db, 'pub3-cpp');
      const problemService = new ProblemAccessService(db, UNUSED_STORE);
      const submissionService = new SubmissionAccessService(db);

      await problemService.publishRevision(actorFor(owner.id), 'pub3', 1);

      const { id: submissionId } = await submissionService.create(actorFor(solver.id), {
        problemCode: 'pub3',
        languageKey: 'pub3-cpp',
        source: 'int main() {}',
      });

      const [beforeSubmission] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
      expect(beforeSubmission!.revisionId).toBe(rev1.id);

      await problemService.publishRevision(actorFor(owner.id), 'pub3', 2);

      const [rev1Row] = await db.select().from(problemRevisions).where(eq(problemRevisions.id, rev1.id));
      expect(rev1Row!.state).toBe('archived');

      const [afterSubmission] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
      expect(afterSubmission!.revisionId).toBe(rev1.id);
      expect(afterSubmission!.revisionId).not.toBe(rev2.id);
    });
  }, 120_000);

  it('publishing an already-published revision is a 200 no-op', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'pub-owner4');
      const { id } = await seedProblem(db, { code: 'pub4', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const rev1 = await seedRevision(db, { problemId: id, version: 1, createdBy: owner.id });
      const service = new ProblemAccessService(db, UNUSED_STORE);

      await service.publishRevision(actorFor(owner.id), 'pub4', 1);
      const result = await service.publishRevision(actorFor(owner.id), 'pub4', 1);
      expect(result).toEqual({ version: 1 });

      const [revRow] = await db.select().from(problemRevisions).where(eq(problemRevisions.id, rev1.id));
      expect(revRow!.state).toBe('published');
      const [problemRow] = await db.select().from(problems).where(eq(problems.id, id));
      expect(problemRow!.currentRevisionId).toBe(rev1.id);
    });
  }, 120_000);

  it('publishing an archived revision rolls back to it', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'pub-owner5');
      const { id } = await seedProblem(db, { code: 'pub5', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const rev1 = await seedRevision(db, { problemId: id, version: 1, createdBy: owner.id });
      const rev2 = await seedRevision(db, { problemId: id, version: 2, createdBy: owner.id });
      const service = new ProblemAccessService(db, UNUSED_STORE);

      await service.publishRevision(actorFor(owner.id), 'pub5', 1);
      await service.publishRevision(actorFor(owner.id), 'pub5', 2);
      // rev1 is now archived, rev2 published. Roll back to rev1.
      const result = await service.publishRevision(actorFor(owner.id), 'pub5', 1);
      expect(result).toEqual({ version: 1 });

      const [rev1Row] = await db.select().from(problemRevisions).where(eq(problemRevisions.id, rev1.id));
      expect(rev1Row!.state).toBe('published');
      const [rev2Row] = await db.select().from(problemRevisions).where(eq(problemRevisions.id, rev2.id));
      expect(rev2Row!.state).toBe('archived');
      const [problemRow] = await db.select().from(problems).where(eq(problems.id, id));
      expect(problemRow!.currentRevisionId).toBe(rev1.id);
    });
  }, 120_000);

  it('an unknown version gets 404 revision_not_found', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'pub-owner6');
      const { id } = await seedProblem(db, { code: 'pub6', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      await seedRevision(db, { problemId: id, version: 1, createdBy: owner.id });
      const service = new ProblemAccessService(db, UNUSED_STORE);

      await expect(service.publishRevision(actorFor(owner.id), 'pub6', 99)).rejects.toMatchObject({
        status: 404,
        code: 'revision_not_found',
      });
    });
  }, 120_000);

  it('a tester publishing gets 403 problem_forbidden', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'pub-owner7');
      const tester = await insertUser(db, 'pub-tester7');
      const { id } = await seedProblem(db, { code: 'pub7', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      await db.insert(problemMembers).values({ problemId: id, userId: tester.id, role: 'tester' });
      await seedRevision(db, { problemId: id, version: 1, createdBy: owner.id });
      const service = new ProblemAccessService(db, UNUSED_STORE);

      await expect(service.publishRevision(actorFor(tester.id), 'pub7', 1)).rejects.toMatchObject({
        status: 403,
        code: 'problem_forbidden',
      });
    });
  }, 120_000);

  it('listRevisions is 404 for a plain user, and lists drafts for a tester', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'pub-owner8');
      const tester = await insertUser(db, 'pub-tester8');
      const outsider = await insertUser(db, 'pub-outsider8');
      const { id } = await seedProblem(db, { code: 'pub8', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      await db.insert(problemMembers).values({ problemId: id, userId: tester.id, role: 'tester' });
      const rev1 = await seedRevision(db, { problemId: id, version: 1, createdBy: owner.id });
      const service = new ProblemAccessService(db, UNUSED_STORE);

      await expect(service.listRevisions(actorFor(outsider.id), 'pub8')).rejects.toMatchObject({
        status: 404,
        code: 'problem_not_found',
      });

      const list = await service.listRevisions(actorFor(tester.id), 'pub8');
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: rev1.id, version: 1, state: 'draft' });
    });
  }, 120_000);
});
