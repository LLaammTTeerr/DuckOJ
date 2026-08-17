import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { FakeDriver } from '@qhhoj/judge-protocol';
import { schema, type Db } from '@qhhoj/db';
import { problems, problemRevisions, submissions } from '@qhhoj/db/guarded';
import { EventWriter } from '../src/event-writer.js';
import { JobStore } from '../src/job-store.js';
import { Worker } from '../src/worker.js';
import { withTestDb } from './db.harness.js';

async function seed(
  db: Db,
  store: JobStore,
  source: string,
): Promise<{ submissionId: number; jobId: number }> {
  const [user] = await db
    .insert(schema.users)
    .values({ username: 'wk', email: 'wk@e.com', passwordHash: 'x', displayName: 'W' })
    .returning();
  const [language] = await db
    .insert(schema.languages)
    .values({ key: 'cpp17', name: 'C++17', extension: 'cpp' })
    .returning();
  const [problem] = await db
    .insert(problems)
    .values({ code: 'aplusb', name: 'A+B', statement: 's' })
    .returning();
  const [revision] = await db
    .insert(problemRevisions)
    .values({ problemId: problem!.id, version: 1, packageHash: 'h', state: 'published' })
    .returning();
  const [submission] = await db
    .insert(submissions)
    .values({
      userId: user!.id,
      problemId: problem!.id,
      revisionId: revision!.id,
      languageId: language!.id,
      source,
    })
    .returning();
  const jobId = await store.enqueue({ revisionId: revision!.id, packageHash: 'h', submissionId: submission!.id });
  return { submissionId: submission!.id, jobId };
}

describe('Worker', () => {
  it('claims a job, dispatches it with the submission source, and marks it done', async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish: vi.fn(async () => {}) } as never);
      const driver = new FakeDriver();
      const { jobId } = await seed(db, store, 'int main(){ return 0; }');

      // grading_jobs.id is a bigserial: its sequence is not transactional,
      // so it cannot be predicted from "this is a fresh rolled-back
      // transaction" — another `it()` in this same file may already have
      // advanced it. Use the id `enqueue` actually returned.
      driver.script(String(jobId), [
        { type: 'finished', verdict: 'AC', points: 1, maxPoints: 1, timeMs: 3, memoryKb: 900 },
      ]);

      const worker = new Worker(store, writer, driver, 'worker-a');
      const run = worker.start();
      await vi.waitFor(async () => {
        const [job] = await db.select().from(schema.gradingJobs);
        expect(job?.state).toBe('done');
      });
      worker.stop();
      await Promise.race([run, new Promise((r) => setTimeout(r, 1000))]);
    });
  }, 120_000);

  it('cancels the driver when its lease lapses, so an abandoned grade stops', async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish: vi.fn(async () => {}) } as never);
      const driver = new FakeDriver();
      const cancel = vi.spyOn(driver, 'cancel');
      const { jobId } = await seed(db, store, 'int main(){}');
      // Script nothing terminal, so the job stays in flight.
      driver.script(String(jobId), [{ type: 'compiling' }]);

      const worker = new Worker(store, writer, driver, 'worker-a');
      const run = worker.start();
      await vi.waitFor(async () => {
        const [job] = await db.select().from(schema.gradingJobs);
        expect(job?.state).toBe('leased');
      });

      // Simulate the lease lapsing and another worker taking the job.
      await db.execute(sql`update grading_jobs set lease_until = now() - interval '1 second'`);
      await store.claim('worker-b');

      // The heartbeat interval is 20s in production; drive it directly rather
      // than waiting, so the test asserts the logic and not the clock.
      await worker.heartbeatOnce();

      expect(cancel).toHaveBeenCalledWith(String(jobId), 1);
      worker.stop();
      await Promise.race([run, new Promise((r) => setTimeout(r, 1000))]);
    });
  }, 120_000);
});
