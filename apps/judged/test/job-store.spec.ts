import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { schema, type Db } from '@qhhoj/db';
import { problems, problemRevisions } from '@qhhoj/db/guarded';
import { JobStore } from '../src/job-store.js';
import { withTestDb } from './db.harness.js';

/**
 * Creates a real problem and published revision, then enqueues one job
 * against it.
 *
 * The revision is not decoration: `grading_jobs.revision_id` is NOT NULL with
 * a foreign key to `problem_revisions`, so a job cannot exist without one.
 * `submissionId` stays null — this suite exercises the job store in isolation,
 * and that column is nullable by design for job kinds that carry no submission.
 */
async function seedJob(db: Db): Promise<JobStore> {
  const store = new JobStore(db);
  const [problem] = await db
    .insert(problems)
    .values({ code: 'aplusb', name: 'A+B', statement: 's' })
    .returning();
  await db.insert(schema.packages).values({ hash: 'h', sizeBytes: 1, fileCount: 1 });
  const [revision] = await db
    .insert(problemRevisions)
    .values({ problemId: problem!.id, version: 1, packageHash: 'h', state: 'published' })
    .returning();
  await store.enqueue({ revisionId: revision!.id, packageHash: 'h', submissionId: null });
  return store;
}

describe('JobStore', () => {
  it('claims a queued job and stamps a lease', async () => {
    await withTestDb(async (db) => {
      const store = await seedJob(db);

      const claimed = await store.claim('worker-a');

      expect(claimed?.attempt).toBe(1);
      const [row] = await db.select().from(schema.gradingJobs);
      expect(row?.state).toBe('leased');
      expect(row?.workerId).toBe('worker-a');
      expect(row?.leaseUntil).not.toBeNull();
    });
  }, 120_000);

  it('does not hand the same job to a second worker while the lease holds', async () => {
    await withTestDb(async (db) => {
      const store = await seedJob(db);
      await store.claim('worker-a');

      expect(await store.claim('worker-b')).toBeNull();
    });
  }, 120_000);

  it('lets another worker claim once the lease has expired, incrementing the attempt', async () => {
    await withTestDb(async (db) => {
      const store = await seedJob(db);
      const first = await store.claim('worker-a');
      await db.execute(sql`update grading_jobs set lease_until = now() - interval '1 second'`);

      const second = await store.claim('worker-b');

      expect(first?.attempt).toBe(1);
      expect(second?.attempt).toBe(2);
      expect(second?.id).toBe(first?.id);
    });
  }, 120_000);

  it('extends the lease on heartbeat', async () => {
    await withTestDb(async (db) => {
      const store = await seedJob(db);
      const claimed = await store.claim('worker-a');
      await db.execute(sql`update grading_jobs set lease_until = now() + interval '5 seconds'`);
      const [before] = await db.select().from(schema.gradingJobs);

      const ok = await store.heartbeat(claimed!.id, claimed!.attempt);
      const [after] = await db.select().from(schema.gradingJobs);

      expect(ok).toBe(true);
      expect(after!.leaseUntil!.getTime()).toBeGreaterThan(before!.leaseUntil!.getTime());
    });
  }, 120_000);

  it('refuses a heartbeat carrying a stale attempt', async () => {
    await withTestDb(async (db) => {
      const store = await seedJob(db);
      const first = await store.claim('worker-a');
      await db.execute(sql`update grading_jobs set lease_until = now() - interval '1 second'`);
      await store.claim('worker-b');

      // worker-a is now superseded; its heartbeat must not resurrect its claim.
      expect(await store.heartbeat(first!.id, first!.attempt)).toBe(false);
    });
  }, 120_000);

  it('refuses completion from a superseded attempt', async () => {
    await withTestDb(async (db) => {
      const store = await seedJob(db);
      const first = await store.claim('worker-a');
      await db.execute(sql`update grading_jobs set lease_until = now() - interval '1 second'`);
      await store.claim('worker-b');

      expect(await store.complete(first!.id, first!.attempt)).toBe(false);
      const [row] = await db.select().from(schema.gradingJobs);
      expect(row?.state).toBe('leased');
    });
  }, 120_000);

  it('reports whether an attempt is current — the fencing check', async () => {
    await withTestDb(async (db) => {
      const store = await seedJob(db);
      const first = await store.claim('worker-a');
      expect(await store.isCurrentAttempt(first!.id, first!.attempt)).toBe(true);

      await db.execute(sql`update grading_jobs set lease_until = now() - interval '1 second'`);
      await store.claim('worker-b');

      expect(await store.isCurrentAttempt(first!.id, first!.attempt)).toBe(false);
    });
  }, 120_000);

  it('lists jobs whose lease expired, so their drivers can be told to stop', async () => {
    await withTestDb(async (db) => {
      const store = await seedJob(db);
      const claimed = await store.claim('worker-a');
      await db.execute(sql`update grading_jobs set lease_until = now() - interval '1 second'`);

      expect(await store.reclaimExpired()).toEqual([claimed!.id]);
    });
  }, 120_000);
});
