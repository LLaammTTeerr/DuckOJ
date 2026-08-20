import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@duckoj/db';
import { problems, problemRevisions } from '@duckoj/db/guarded';
import { JobStore } from '../src/job-store.js';
import { testDbUrl } from './db.harness.js';

/**
 * Exercises `claim()` from two independent connections against committed
 * data.
 *
 * `withTestDb` hands every caller a transaction on one connection, so two
 * `claim()` calls through it never actually race at the database — the
 * second sees the first's *uncommitted* write and returns null for that
 * reason alone. These tests instead open two separate `createDb` clients
 * against the same committed rows, which is the genuine race Task 6's
 * version never proved.
 *
 * Neither test below is evidence for `SKIP LOCKED` specifically: an
 * empirical check (removing the clause, keeping plain `FOR UPDATE`, and
 * rerunning both) showed both still pass — see the comment on the `for
 * update skip locked` line in `job-store.ts` for why. They guard the claim
 * query's actual outcome guarantees under real concurrency instead.
 */

/** Rows this file has committed so far, tracked as they're created so cleanup can run on a partial seed. */
interface Seeded {
  userId?: number;
  problemId?: number;
  revisionId?: number;
}

async function seedJobs(db: Db, count: number, seeded: Seeded): Promise<void> {
  const store = new JobStore(db);
  const [user] = await db
    .insert(schema.users)
    .values({
      username: `concurrency-${randomUUID()}`,
      email: `concurrency-${randomUUID()}@e.com`,
      passwordHash: 'x',
      displayName: 'C',
    })
    .returning();
  seeded.userId = user!.id;
  const [problem] = await db
    .insert(problems)
    .values({ code: `concurrency-${randomUUID()}`, name: 'A+B', statement: 's', createdBy: user!.id })
    .returning();
  seeded.problemId = problem!.id;
  // Not cleaned up by `cleanup()` below — a shared, idempotent 'h' package
  // row is fine to leave committed across both `it`s in this file (see
  // `onConflictDoNothing`), unlike `problems`/`problem_revisions`, which are
  // unique per test run and must be torn down.
  await db.insert(schema.packages).values({ hash: 'h', sizeBytes: 1, fileCount: 1 }).onConflictDoNothing();
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
  seeded.revisionId = revision!.id;
  for (let i = 0; i < count; i++) {
    await store.enqueue({ revisionId: revision!.id, packageHash: 'h', submissionId: null });
  }
}

/**
 * Children first: grading_jobs -> problem_revisions -> problems -> users
 * (`problems.created_by` and `problem_revisions.created_by` are FKs against
 * it). Tolerates a partial `seeded` (e.g. `seedJobs` threw after the problem
 * but before the revision) by only deleting what was actually recorded.
 */
async function cleanup(db: Db, seeded: Seeded): Promise<void> {
  if (seeded.revisionId !== undefined) {
    await db.delete(schema.gradingJobs).where(eq(schema.gradingJobs.revisionId, seeded.revisionId));
    await db.delete(problemRevisions).where(eq(problemRevisions.id, seeded.revisionId));
  }
  if (seeded.problemId !== undefined) {
    await db.delete(problems).where(eq(problems.id, seeded.problemId));
  }
  if (seeded.userId !== undefined) {
    await db.delete(schema.users).where(eq(schema.users.id, seeded.userId));
  }
}

describe('JobStore concurrency', () => {
  it('hands one job to exactly one of two concurrent claimants', async () => {
    const url = await testDbUrl();
    const a = createDb(url);
    const b = createDb(url);
    const seeded: Seeded = {};
    try {
      await seedJobs(a.db, 1, seeded);
      const storeA = new JobStore(a.db);
      const storeB = new JobStore(b.db);

      const [claimA, claimB] = await Promise.all([storeA.claim('worker-a'), storeB.claim('worker-b')]);

      const winners = [claimA, claimB].filter((c) => c !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]!.attempt).toBe(1);
    } finally {
      // Nested so a.close()/b.close() run even if cleanup itself throws —
      // an unclosed connection leaks past this test either way.
      try {
        await cleanup(a.db, seeded);
      } finally {
        await a.close();
        await b.close();
      }
    }
  }, 120_000);

  it('hands two concurrent claimants two different jobs', async () => {
    const url = await testDbUrl();
    const a = createDb(url);
    const b = createDb(url);
    const seeded: Seeded = {};
    try {
      await seedJobs(a.db, 2, seeded);
      const storeA = new JobStore(a.db);
      const storeB = new JobStore(b.db);

      const [claimA, claimB] = await Promise.all([storeA.claim('worker-a'), storeB.claim('worker-b')]);

      expect(claimA).not.toBeNull();
      expect(claimB).not.toBeNull();
      expect(claimA!.id).not.toBe(claimB!.id);
    } finally {
      try {
        await cleanup(a.db, seeded);
      } finally {
        await a.close();
        await b.close();
      }
    }
  }, 120_000);
});
