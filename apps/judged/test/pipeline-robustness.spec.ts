/**
 * The 2026-08 sweep's pipeline defects, pinned:
 *  - a failed event write fails the ATTEMPT (no silent at-most-once),
 *  - a superseded attempt's terminal UPDATE matches zero rows (in-statement
 *    fence, not check-then-act),
 *  - the grading ceiling scales with the dataset,
 *  - claim() serves the revision's real limits, not Phase 1's constants.
 */
import { describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { problems, problemRevisions, submissions } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import type { EmitEvent, JudgeDriver } from '@duckoj/judge-protocol';
import { EventWriter } from '../src/event-writer.js';
import { JobStore, type ClaimedJob } from '../src/job-store.js';
import { Worker, MAX_GRADING_MS, ABSOLUTE_MAX_GRADING_MS, gradingCeilingMs } from '../src/worker.js';
import { withTestDb } from './db.harness.js';

async function seed(db: Db, store: JobStore, revision: { timeMs: number; memoryKb: number; testCount: number }) {
  const [user] = await db
    .insert(schema.users)
    .values({ username: 'p', email: 'p@e.com', passwordHash: 'x', displayName: 'p' })
    .returning();
  const [language] = await db
    .insert(schema.languages)
    .values({ key: 'cpp17', name: 'C++17', extension: 'cpp' })
    .returning();
  const [problem] = await db
    .insert(problems)
    .values({ code: 'p', name: 'P', statement: 's', visibility: 'public', createdBy: user!.id })
    .returning();
  await db.insert(schema.packages).values({ hash: 'h', sizeBytes: 1, fileCount: 1 });
  const [rev] = await db
    .insert(problemRevisions)
    .values({
      problemId: problem!.id,
      version: 1,
      packageHash: 'h',
      state: 'published',
      createdBy: user!.id,
      ...revision,
      totalPoints: 100,
      checkerKind: 'wcmp',
    })
    .returning();
  const [submission] = await db
    .insert(submissions)
    .values({ userId: user!.id, problemId: problem!.id, revisionId: rev!.id, languageId: language!.id, source: 's' })
    .returning();
  await store.enqueue({ revisionId: rev!.id, packageHash: 'h', submissionId: submission!.id });
  return { submissionId: submission!.id };
}

describe('claim serves the revision limits', () => {
  it('a 2500 ms / 128 MB / 42-test revision claims with exactly those numbers', async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      await seed(db, store, { timeMs: 2500, memoryKb: 131072, testCount: 42 });
      const job = (await store.claim('w'))!;
      // Before the fix these were pinned at 1000 / 65536 — the problem page
      // showed the real limits while grading quietly used Phase 1 constants.
      expect(job.timeMs).toBe(2500);
      expect(job.memoryKb).toBe(131072);
      expect(job.testCount).toBe(42);
    });
  }, 120_000);
});

describe('gradingCeilingMs', () => {
  it('floors at the constant, scales with the dataset, and hard-caps', () => {
    expect(gradingCeilingMs({ testCount: null, timeMs: 1000 })).toBe(MAX_GRADING_MS);
    expect(gradingCeilingMs({ testCount: 5, timeMs: 1000 })).toBe(MAX_GRADING_MS);
    // 350 honest seconds of grading would loop forever under a 300s ceiling.
    expect(gradingCeilingMs({ testCount: 350, timeMs: 1000 })).toBe(350 * 1000 * 3 + 60_000);
    expect(gradingCeilingMs({ testCount: 100_000, timeMs: 1000 })).toBe(ABSOLUTE_MAX_GRADING_MS);
  });
});

describe('a superseded attempt cannot overwrite the retry', () => {
  it('a terminal write whose attempt is stale matches zero rows even when the pre-check lied', async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      const { submissionId } = await seed(db, store, { timeMs: 1000, memoryKb: 65536, testCount: 3 });
      const job = (await store.claim('w1'))!;

      // The race: between the writer's isCurrentAttempt SELECT and its
      // UPDATE, the job is given to a new attempt. Simulated by lying in
      // the pre-check while the DATABASE holds the truth.
      await db.execute(sql`update grading_jobs set attempt = ${job.attempt + 1} where id = ${job.id}`);
      const lyingStore = { isCurrentAttempt: vi.fn(async () => true) } as unknown as JobStore;
      const writer = new EventWriter(db, lyingStore, { publish: vi.fn(async () => {}) } as never);

      await writer.apply(job, { type: 'finished', verdict: 'IE', points: 0, maxPoints: 1, timeMs: 1, memoryKb: 1 });

      const [row] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
      // The stale write must have matched nothing: no verdict, no state flip.
      expect(row!.verdict).toBeNull();
      expect(row!.state).toBe('queued');
    });
  }, 120_000);
});

describe('a failed event write fails the attempt', () => {
  it('the job is never completed when apply rejects mid-grading', async () => {
    const job: ClaimedJob = {
      id: 1,
      attempt: 1,
      submissionId: 10,
      revisionId: 1,
      packageHash: 'h',
      source: 's',
      languageKey: 'cpp17',
      timeMs: 1000,
      memoryKb: 65536,
      testCount: null,
    };
    const claimQueue = [job];
    const complete = vi.fn(async () => true);
    const jobsStub = {
      claim: vi.fn(async () => claimQueue.shift() ?? null),
      heartbeat: vi.fn(async () => true),
      complete,
    } as unknown as JobStore;
    // The write that loses a case row: rejects once, on the caseResult.
    const apply = vi.fn(async (_job: ClaimedJob, event: { type: string }) => {
      if (event.type === 'caseResult') throw new Error('insert failed');
      return true;
    });
    const writerStub = { apply } as unknown as EventWriter;

    let emitFn!: EmitEvent;
    let dispatchResolve!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      dispatchResolve = resolve;
    });
    const driverStub: JudgeDriver = {
      start: async () => {},
      capabilities: () => ({ languages: ['cpp17'], concurrency: 1 }),
      dispatch: vi.fn(async (j, emit) => {
        emitFn = emit;
        dispatchResolve();
      }),
      cancel: vi.fn(async () => {}),
      stop: async () => {},
    };

    const worker = new Worker(jobsStub, writerStub, driverStub, 'w');
    const run = worker.start();
    await dispatched;

    // The lost write: before the fix this was swallowed by the driver's
    // per-packet catch and grading sailed on to complete(). Now the attempt
    // must error and complete() must never run.
    await expect(
      emitFn({
        type: 'caseResult',
        groupIndex: 0,
        caseIndex: 0,
        verdict: 'AC',
        skipped: false,
        flags: [],
        timeMs: 1,
        memoryKb: 1,
        points: 1,
        maxPoints: 1,
        feedback: '',
      }),
    ).rejects.toThrow('insert failed');

    await new Promise((r) => setTimeout(r, 50));
    expect(complete).not.toHaveBeenCalled();
    await worker.stop();
    await run;
  }, 30_000);
});
