import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { FakeDriver, type EmitEvent, type JudgeDriver } from '@qhhoj/judge-protocol';
import { schema, type Db } from '@qhhoj/db';
import { problems, problemRevisions, submissions } from '@qhhoj/db/guarded';
import { EventWriter } from '../src/event-writer.js';
import { JobStore, type ClaimedJob } from '../src/job-store.js';
import { Worker } from '../src/worker.js';
import { withTestDb } from './db.harness.js';

/** A promise plus its own resolver, for driving async stubs by hand instead of by clock. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function seed(
  db: Db,
  store: JobStore,
  source: string,
): Promise<{ submissionId: number; jobId: number; revisionId: number }> {
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
  return { submissionId: submission!.id, jobId, revisionId: revision!.id };
}

describe('Worker', () => {
  it('claims a job, dispatches it with the submission source, and marks it done', async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish: vi.fn(async () => {}) } as never);
      const driver = new FakeDriver();
      const dispatch = vi.spyOn(driver, 'dispatch');
      const source = 'int main(){ return 0; }';
      const { jobId } = await seed(db, store, source);

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
      }, 10_000);
      // The test's name promised the submission source reaches the driver —
      // assert it, so a `Worker` that dispatched `source: ''` would fail here.
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ source }), expect.any(Function));
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
      }, 10_000);

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

  it('does not touch the next job\'s heartbeat timer when a stale heartbeatOnce() resolves after supersession', async () => {
    // Stub collaborators rather than the real loop: the race is "the 20s
    // tick lands inside the heartbeat round-trip while the job completes",
    // and driving that deterministically against real claim()/heartbeat()
    // timing would mean racing the test against the clock. Here every step
    // is signalled by hand.
    const jobA: ClaimedJob = {
      id: 1,
      attempt: 1,
      submissionId: null,
      revisionId: 1,
      packageHash: 'h',
      source: 's',
      languageKey: 'cpp17',
      timeMs: 1000,
      memoryKb: 65536,
    };
    const jobB: ClaimedJob = { ...jobA, id: 2 };

    const heartbeatGate = deferred<boolean>();
    const claimQueue = [jobA, jobB];
    const jobsStub = {
      claim: vi.fn(async () => claimQueue.shift() ?? null),
      heartbeat: vi.fn(async () => heartbeatGate.promise),
      complete: vi.fn(async () => true),
    } as unknown as JobStore;
    const writerStub = { apply: vi.fn(async () => true) } as unknown as EventWriter;

    const emitters = new Map<string, EmitEvent>();
    const dispatchSignal = [deferred<void>(), deferred<void>()];
    let dispatchCall = 0;
    const cancel = vi.fn(async () => {});
    const driverStub: JudgeDriver = {
      start: async () => {},
      capabilities: () => ({ languages: ['cpp17'], concurrency: 1 }),
      dispatch: vi.fn(async (job, emit) => {
        emitters.set(job.id, emit);
        dispatchSignal[dispatchCall]!.resolve();
        dispatchCall += 1;
        await emit({ type: 'dispatched' });
      }),
      cancel,
      stop: async () => {},
    };

    const worker = new Worker(jobsStub, writerStub, driverStub, 'worker-a');
    const internals = (): { current: ClaimedJob | null; heartbeatTimer: NodeJS.Timeout | null } =>
      worker as unknown as { current: ClaimedJob | null; heartbeatTimer: NodeJS.Timeout | null };

    const run = worker.start();
    await dispatchSignal[0]!.promise; // job A claimed and dispatched

    // Simulate the 20s tick landing mid-round-trip: call heartbeatOnce() but
    // do not await it yet — `jobs.heartbeat` stays pending until we resolve
    // `heartbeatGate` below.
    const stale = worker.heartbeatOnce();

    // While that heartbeat call is still in flight, job A finishes normally.
    await emitters.get('1')!({ type: 'finished', verdict: 'AC', points: 1, maxPoints: 1, timeMs: 1, memoryKb: 1 });

    // The loop moves on and claims job B, arming a new heartbeat timer for it.
    await dispatchSignal[1]!.promise;
    const timerForB = internals().heartbeatTimer;
    expect(internals().current).toBe(jobB);
    expect(timerForB).not.toBeNull();

    // Now let the stale call's `jobs.heartbeat` resolve as if the lease had
    // lapsed. Pre-fix, this branch would clear whatever `heartbeatTimer`
    // holds *now* — job B's — and cancel job A's already-finished attempt.
    heartbeatGate.resolve(false);
    await stale;

    expect(internals().heartbeatTimer).toBe(timerForB);
    expect(cancel).not.toHaveBeenCalled();

    // Job B never receives a terminal event in this test, so its timer would
    // otherwise keep firing every 20s past the test's own lifetime.
    if (internals().heartbeatTimer) clearInterval(internals().heartbeatTimer!);
    worker.stop();
    await Promise.race([run, new Promise((r) => setTimeout(r, 1000))]);
  }, 120_000);

  it('logs and moves on when a job\'s grading exceeds the watchdog, instead of hanging forever', async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish: vi.fn(async () => {}) } as never);
      const driver = new FakeDriver();
      const { jobId } = await seed(db, store, 'int main(){}');
      // No script(...): dispatch emits only 'dispatched' and then nothing —
      // the same shape as a collaborator that hangs forever (e.g. a Redis
      // publish stuck behind an unreachable server with the offline queue
      // buffering it indefinitely).

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const claimSpy = vi.spyOn(store, 'claim');
      const worker = new Worker(store, writer, driver, 'worker-a', 50);
      const run = worker.start();

      await vi.waitFor(() => {
        const failed = errorSpy.mock.calls
          .map((c) => c[0])
          .find((line) => typeof line === 'string' && line.includes('job failed'));
        expect(failed).toBeDefined();
      }, 10_000);
      const failLine = errorSpy.mock.calls
        .map((c) => c[0])
        .find((line) => typeof line === 'string' && line.includes('job failed')) as string;
      const logged = JSON.parse(failLine) as { jobId: number; error: string };
      expect(logged.jobId).toBe(jobId);
      expect(logged.error).toContain('50ms');

      // The loop must have gone around to try another claim, not wedged
      // forever on the failed job's promise.
      const callsAtFailure = claimSpy.mock.calls.length;
      await vi.waitFor(() => {
        expect(claimSpy.mock.calls.length).toBeGreaterThan(callsAtFailure);
      }, 10_000);

      worker.stop();
      errorSpy.mockRestore();
      await Promise.race([run, new Promise((r) => setTimeout(r, 1000))]);
    });
  }, 120_000);

  it('logs one job\'s failure and keeps grading the next job, rather than ending the loop', async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish: vi.fn(async () => {}) } as never);
      const fake = new FakeDriver();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { jobId: jobIdA, revisionId } = await seed(db, store, 'int main(){ return 1; }');
      // Job B needs no submission of its own — reusing job A's revision and
      // enqueuing with `submissionId: null` avoids a second full user/
      // language/problem row-set colliding with job A's on their unique
      // columns within this one transaction.
      const jobIdB = await store.enqueue({ revisionId, packageHash: 'h', submissionId: null });
      fake.script(String(jobIdB), [
        { type: 'finished', verdict: 'AC', points: 1, maxPoints: 1, timeMs: 1, memoryKb: 1 },
      ]);

      // Job A's dispatch rejects outright — a genuine driver-level failure.
      // (An earlier version of this test instead made `EventWriter`'s write
      // throw a real constraint violation, but `withTestDb` runs the whole
      // test in one Postgres transaction: any failed statement aborts *that
      // entire transaction*, so job B's own writes and this test's own
      // assertion query failed too. Rejecting at the driver avoids ever
      // touching the DB with the failure.)
      const driver: JudgeDriver = {
        start: () => fake.start(),
        capabilities: () => fake.capabilities(),
        dispatch: (job, emit) =>
          job.id === String(jobIdA) ? Promise.reject(new Error('judge rejected job A')) : fake.dispatch(job, emit),
        cancel: (jobId, attempt) => fake.cancel(jobId, attempt),
        stop: () => fake.stop(),
      };

      const worker = new Worker(store, writer, driver, 'worker-a');
      const run = worker.start();

      // Job B, enqueued after the job that fails, must still reach 'done' —
      // that is the property under test: one job's failure does not end the
      // loop for every other submission.
      await vi.waitFor(async () => {
        const [rowB] = await db.select().from(schema.gradingJobs).where(eq(schema.gradingJobs.id, jobIdB));
        expect(rowB?.state).toBe('done');
      }, 10_000);

      const failLine = errorSpy.mock.calls
        .map((c) => c[0])
        .find((line) => typeof line === 'string' && line.includes('job failed'));
      expect(failLine).toBeDefined();
      expect((JSON.parse(failLine as string) as { jobId: number }).jobId).toBe(jobIdA);

      worker.stop();
      errorSpy.mockRestore();
      await Promise.race([run, new Promise((r) => setTimeout(r, 1000))]);
    });
  }, 120_000);
});
