import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@qhhoj/db';
import { problems, problemRevisions } from '@qhhoj/db/guarded';
import { JobStore } from '../src/job-store.js';
import { testDbUrl } from './db.harness.js';

/**
 * Exercises `claim()` from two independent connections against committed
 * data, so the concurrent claims are genuinely concurrent transactions
 * contending for the same rows.
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
async function seedJobs(db: Db, count: number): Promise<{ problemId: number; revisionId: number }> {
  const store = new JobStore(db);
  const [problem] = await db
    .insert(problems)
    .values({ code: `concurrency-${randomUUID()}`, name: 'A+B', statement: 's' })
    .returning();
  const [revision] = await db
    .insert(problemRevisions)
    .values({ problemId: problem!.id, version: 1, packageHash: 'h', state: 'published' })
    .returning();
  for (let i = 0; i < count; i++) {
    await store.enqueue({ revisionId: revision!.id, packageHash: 'h', submissionId: null });
  }
  return { problemId: problem!.id, revisionId: revision!.id };
}

/** Children first: grading_jobs -> problem_revisions -> problems. */
async function cleanup(db: Db, revisionId: number, problemId: number): Promise<void> {
  await db.delete(schema.gradingJobs).where(eq(schema.gradingJobs.revisionId, revisionId));
  await db.delete(problemRevisions).where(eq(problemRevisions.id, revisionId));
  await db.delete(problems).where(eq(problems.id, problemId));
}

describe('JobStore concurrency', () => {
  it('hands one job to exactly one of two concurrent claimants', async () => {
    const url = await testDbUrl();
    const a = createDb(url);
    const b = createDb(url);
    let seeded: { problemId: number; revisionId: number } | undefined;
    try {
      seeded = await seedJobs(a.db, 1);
      const storeA = new JobStore(a.db);
      const storeB = new JobStore(b.db);

      const [claimA, claimB] = await Promise.all([storeA.claim('worker-a'), storeB.claim('worker-b')]);

      const winners = [claimA, claimB].filter((c) => c !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]!.attempt).toBe(1);
    } finally {
      if (seeded) await cleanup(a.db, seeded.revisionId, seeded.problemId);
      await a.close();
      await b.close();
    }
  }, 120_000);

  it('hands two concurrent claimants two different jobs', async () => {
    const url = await testDbUrl();
    const a = createDb(url);
    const b = createDb(url);
    let seeded: { problemId: number; revisionId: number } | undefined;
    try {
      seeded = await seedJobs(a.db, 2);
      const storeA = new JobStore(a.db);
      const storeB = new JobStore(b.db);

      const [claimA, claimB] = await Promise.all([storeA.claim('worker-a'), storeB.claim('worker-b')]);

      expect(claimA).not.toBeNull();
      expect(claimB).not.toBeNull();
      expect(claimA!.id).not.toBe(claimB!.id);
    } finally {
      if (seeded) await cleanup(a.db, seeded.revisionId, seeded.problemId);
      await a.close();
      await b.close();
    }
  }, 120_000);
});
