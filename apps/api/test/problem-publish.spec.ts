import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, schema } from '@duckoj/db';
import type { Db } from '@duckoj/db';
import { problemMembers, problemRevisions, problems, submissions } from '@duckoj/db/guarded';
import type { Actor } from '../src/authz/actor.js';
import { ProblemAccessService } from '../src/authz/problem.access.js';
import { SubmissionAccessService } from '../src/authz/submission.access.js';
import type { PackageStore } from '../src/packages/package.store.js';
import { testDbUrl, withTestDb } from './db.harness.js';
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

  /**
   * Nothing in `publishRevision` touches `submissions` at all, so this test
   * cannot fail against the current implementation — its only real
   * watch-fail evidence was the pre-implementation `is not a function`
   * failure. It stays because it is a regression guard against a *future*
   * change: a "rewrite submissions.revisionId to follow currentRevisionId"
   * step, a cascade delete of archived revisions, or a submission read that
   * joins through `problems.currentRevisionId` instead of the pinned
   * `submissions.revisionId` column. Any of those would silently break the
   * "an archived revision stays readable forever for the submissions graded
   * against it" guarantee the whole archive-on-publish design depends on;
   * this test is what would catch it.
   */
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

  it('canViewRevisions coverage: author, curator and admin can list; anonymous cannot', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'pub-owner9');
      const curator = await insertUser(db, 'pub-curator9');
      const admin = await insertUser(db, 'pub-admin9');
      const { id } = await seedProblem(db, { code: 'pub9', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      await db.insert(problemMembers).values({ problemId: id, userId: curator.id, role: 'curator' });
      const rev1 = await seedRevision(db, { problemId: id, version: 1, createdBy: owner.id });
      const service = new ProblemAccessService(db, UNUSED_STORE);

      // Author: a member via `problemMembers`, same as the tester case.
      const authorList = await service.listRevisions(actorFor(owner.id), 'pub9');
      expect(authorList).toHaveLength(1);
      expect(authorList[0]).toMatchObject({ id: rev1.id, version: 1 });

      // Curator: also a member, distinct role from author/tester.
      const curatorList = await service.listRevisions(actorFor(curator.id), 'pub9');
      expect(curatorList).toHaveLength(1);
      expect(curatorList[0]).toMatchObject({ id: rev1.id, version: 1 });

      // Admin: not a member of this problem at all — `canViewRevisions`
      // grants access via `isAdmin`, the same bypass every other predicate
      // in `problem.visibility.ts` gives admins.
      const adminList = await service.listRevisions(actorFor(admin.id, 'admin'), 'pub9');
      expect(adminList).toHaveLength(1);
      expect(adminList[0]).toMatchObject({ id: rev1.id, version: 1 });

      // Anonymous: `loadProblemContext` returns empty membership for a null
      // actor, so `canViewRevisions` is false regardless of the problem's
      // (public, by default) visibility.
      await expect(service.listRevisions(null, 'pub9')).rejects.toMatchObject({
        status: 404,
        code: 'problem_not_found',
      });
    });
  }, 120_000);
});


/** Resolves after `ms` milliseconds — used only to bound how long a test waits to observe that a promise has *not* resolved yet. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Directly exercises `problem_revisions_one_published_idx` (migration 0006),
 * independent of any concurrency: bypasses `publishRevision` entirely and
 * issues the two conflicting writes as plain SQL, so this is fast,
 * deterministic, and fails immediately (not flakily) if the migration is
 * ever reverted or the index dropped. This is "the index protects the code
 * someone writes next" half of the Task 6 review's fix, tested in isolation
 * from "the lock protects the code you wrote" below.
 */
describe('problem_revisions_one_published_idx', () => {
  it('rejects a second published revision for the same problem', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'pub-index-owner');
      const { id } = await seedProblem(db, { code: 'pubindex', createdBy: owner.id });
      const rev1 = await seedRevision(db, { problemId: id, version: 1, createdBy: owner.id });
      const rev2 = await seedRevision(db, { problemId: id, version: 2, createdBy: owner.id });

      await db.update(problemRevisions).set({ state: 'published' }).where(eq(problemRevisions.id, rev1.id));

      await expect(
        db.update(problemRevisions).set({ state: 'published' }).where(eq(problemRevisions.id, rev2.id)),
      ).rejects.toMatchObject({ cause: { code: '23505' } });
    });
  }, 120_000);
});


/**
 * `withTestDb` hands every caller a transaction on one connection — two
 * `publishRevision` calls through it are nested savepoints of the same
 * transaction (xid), so a sibling savepoint always sees "its own"
 * uncommitted writes and a `SELECT ... FOR UPDATE` can never block itself.
 * This test instead opens two independent `createDb` connections against
 * the same committed rows and commits for real, cleaning up its own rows in
 * a `finally` rather than relying on rollback — mirrors
 * `apps/judged/test/job-store.concurrency.spec.ts`.
 *
 * Two earlier versions of this test were tried and discarded, empirically,
 * per the review's own standard ("if it passes without the lock ... I would
 * rather know that than have a green tick"):
 *
 * 1. Two real `publishRevision` calls under a bare `Promise.all` (Task 5's
 *    `attachRevision` concurrency test's shape), asserting the resulting
 *    published-row count. Run with the lock removed, it still passed: on
 *    this fast local Postgres, each transaction's full lifecycle (lock
 *    attempt, target read, one or two updates, commit) reliably completed
 *    before the other connection's first statement was even sent — no
 *    overlap window ever opened.
 * 2. Connection `a` manually holding *only* the `problems`-row lock
 *    (idle, touching nothing else) while a real `publishRevision` ran on
 *    `b`. This also passed with the lock removed: `publishRevision`
 *    unconditionally writes `problems.currentRevisionId` as its last
 *    statement regardless of the mutation, and *that* write always
 *    contends with `a`'s held lock — so the test was silently observing a
 *    write that exists either way, not the mutation.
 *
 * This version has connection `a` replay `publishRevision(v1)`'s exact
 * statement sequence by hand (the lock, the no-op archive step, the target
 * update — mirroring the real implementation, not reimplementing its
 * business logic) and pauses *after* v1 is written but *before* committing.
 * `b`'s real `publishRevision(v2)` is started while `a` is still
 * uncommitted, with a short delay before `a` is released so `b` has time to
 * reach its own critical statements first. This makes the discriminator the
 * *outcome* of `b`'s call rather than its timing:
 *
 * - With the lock, `b`'s first statement is the same `problems`-row
 *   `FOR UPDATE` `a` already holds, so `b` blocks immediately, before
 *   touching `problem_revisions` at all, and only proceeds once `a`
 *   commits — at which point `b`'s archive step correctly sees v1 as
 *   published. `b` resolves cleanly; exactly one revision ends up
 *   published (v2, after archiving v1).
 * - Without the lock, `b` reads `problem_revisions` immediately (nothing
 *   there blocks it), doesn't see `a`'s still-uncommitted publish of v1
 *   under READ COMMITTED, and its own `UPDATE ... SET state = 'published'`
 *   for v2 is left racing `a`'s uncommitted identical write to
 *   `problem_revisions_one_published_idx`. Once `a` commits, that
 *   collision resolves as a real unique-violation error and `b`'s call
 *   rejects — the "confirm it fails" signal for this mutation.
 */
describe('ProblemAccessService.publishRevision — concurrency', () => {
  it('a concurrent publish waits for an in-flight publish on the same problem instead of racing past it', async () => {
    const url = await testDbUrl();
    const a = createDb(url);
    const b = createDb(url);
    let problemId: number | undefined;
    let userId: number | undefined;
    try {
      const owner = await insertUser(a.db, 'pub-concurrent-owner');
      userId = owner.id;
      const { id } = await seedProblem(a.db, { code: 'pubconcurrent', createdBy: owner.id });
      problemId = id;
      await a.db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const rev1 = await seedRevision(a.db, { problemId: id, version: 1, createdBy: owner.id });
      await seedRevision(a.db, { problemId: id, version: 2, createdBy: owner.id });

      const serviceB = new ProblemAccessService(b.db, UNUSED_STORE);
      const actor = actorFor(owner.id);

      let signalV1Published: () => void = () => {};
      const v1Published = new Promise<void>((resolve) => {
        signalV1Published = resolve;
      });
      let releaseHolder: () => void = () => {};
      const releaseGate = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });

      const holderDone = a.db.transaction(async (tx) => {
        await tx.select({ id: problems.id }).from(problems).where(eq(problems.id, id)).for('update');
        await tx
          .update(problemRevisions)
          .set({ state: 'archived' })
          .where(and(eq(problemRevisions.problemId, id), eq(problemRevisions.state, 'published')));
        await tx.update(problemRevisions).set({ state: 'published' }).where(eq(problemRevisions.id, rev1.id));
        signalV1Published();
        await releaseGate;
        await tx.update(problems).set({ currentRevisionId: rev1.id }).where(eq(problems.id, id));
      });
      await v1Published;

      const bPromise = serviceB.publishRevision(actor, 'pubconcurrent', 2);
      // Gives `b` real wall-clock time to reach its own critical statements
      // (the lock attempt, with the fix; the `problem_revisions` writes,
      // without it) before `a`'s hold is released — without this, `a` could
      // commit before `b` has done anything at all, closing the same
      // overlap window discarded version 1 above ran into.
      await delay(150);
      releaseHolder();

      await holderDone;
      // Resolves cleanly with the lock in place; rejects with a raw
      // unique-violation error without it (see the file-level comment).
      await bPromise;

      const publishedRows = await a.db
        .select({ id: problemRevisions.id, version: problemRevisions.version })
        .from(problemRevisions)
        .where(and(eq(problemRevisions.problemId, id), eq(problemRevisions.state, 'published')));
      expect(publishedRows).toHaveLength(1);
      expect(publishedRows[0]!.version).toBe(2);
    } finally {
      // `problems` cascades to `problem_members` and `problem_revisions` on
      // delete, so deleting it is enough to take both with it; `users` (and
      // the shared, idempotently-keyed `packages` rows `seedRevision` wrote)
      // are cleaned up the same way `job-store.concurrency.spec.ts` does.
      try {
        if (problemId !== undefined) await a.db.delete(problems).where(eq(problems.id, problemId));
        if (userId !== undefined) await a.db.delete(schema.users).where(eq(schema.users.id, userId));
      } finally {
        await a.close();
        await b.close();
      }
    }
  }, 120_000);
});
