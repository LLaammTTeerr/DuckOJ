/**
 * B3's open concern, closed: **a judge that dies mid-grade pins the
 * submission until the grading ceiling.**
 *
 * `BridgeServer`'s `socket.on('close')` removed the connection from its own
 * maps and told the driver nothing. `DmojDriver` kept a `live` entry and an
 * `assignments` row for a socket that no longer existed; `Worker` had long
 * since seen `dispatch()` resolve (it resolves when the request is *written*,
 * not when grading ends) and was parked on a wrapper promise waiting for a
 * terminal event from a process that was gone. Nothing settled that promise
 * until `gradingCeilingMs` fired — 300 s at the floor, up to 30 minutes for a
 * large dataset — and only then did the lease begin its own 60 s lapse. A
 * student watched "đang chấm" for five minutes because a container restarted.
 *
 * The channel this needed runs driver → worker: `dispatch` now takes an
 * `abandon` callback, `BridgeServer` reports a disconnect, and `DmojDriver`
 * calls `abandon` for whatever that connection was grading. The worker
 * rejects its wrapper promise and — because a vanished judge is the one case
 * where we *know* nobody is still grading — releases the lease immediately
 * instead of letting it lapse, so the job is reclaimable at once.
 *
 * Both tests run over a real socket, because the bug lived in what a real
 * `close` event did and did not reach.
 */
import { connect, type Socket } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPacketDecoder, encodePacket, type GradingEvent, type GradingJob } from '@duckoj/judge-protocol';
import { schema, type Db } from '@duckoj/db';
import { problems, problemRevisions, submissions } from '@duckoj/db/guarded';
import { BridgeServer } from '../src/drivers/dmoj/bridge-server.js';
import { DmojDriver } from '../src/drivers/dmoj/dmoj-driver.js';
import { EventWriter } from '../src/event-writer.js';
import { JobStore } from '../src/job-store.js';
import { Worker } from '../src/worker.js';
import { withTestDb } from './db.harness.js';

const job: GradingJob = {
  id: '7',
  attempt: 1,
  kind: 'submission',
  packageHash: 'hash-of-aplusb',
  revisionId: '1',
  language: 'cpp17',
  source: 'int main(){}',
  limits: { timeMs: 1000, memoryKb: 65536 },
};

/** A minimal judge: speaks the real wire format, runs no sandbox. */
function fakeJudge(port: number, id = 'j1') {
  const received: Record<string, unknown>[] = [];
  let socket: Socket;
  const ready = new Promise<void>((resolve) => {
    socket = connect(port, '127.0.0.1', () => {
      socket.write(
        encodePacket({ name: 'handshake', problems: [['aplusb', 0]], executors: { CPP17: {} }, id, key: 'k' }),
      );
      resolve();
    });
    const decoder = createPacketDecoder({
      onPacket: (p) => received.push(p as Record<string, unknown>),
      onError: () => {},
    });
    socket.on('data', (c) => decoder.push(c));
    socket.on('error', () => {});
  });
  return {
    ready,
    received,
    send: (p: unknown) => socket!.write(encodePacket(p)),
    close: () => socket!.destroy(),
  };
}

function fakeAgent() {
  return { ensure: vi.fn(async () => {}) };
}

describe('a judge that disconnects mid-grade', () => {
  let server: BridgeServer | undefined;
  let judge: ReturnType<typeof fakeJudge> | undefined;

  afterEach(async () => {
    judge?.close();
    judge = undefined;
    await server?.close();
    server = undefined;
  });

  it('abandons the in-flight dispatch instead of leaving it to the ceiling', async () => {
    server = new BridgeServer({ languageToExecutor: () => 'CPP17', verifyJudge: async () => true });
    const port = await server.listen(0);
    const driver = new DmojDriver(server, fakeAgent());
    judge = fakeJudge(port);
    await judge.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(1), 10_000);

    const events: GradingEvent[] = [];
    const abandoned: string[] = [];
    await driver.dispatch(
      job,
      async (event) => {
        events.push(event);
      },
      (reason) => abandoned.push(reason),
    );
    await vi.waitFor(() => expect(judge!.received.map((p) => p.name)).toContain('submission-request'), 10_000);

    // The judge starts grading, then its container dies.
    judge.send({ name: 'grading-begin', 'submission-id': 7 });
    await vi.waitFor(() => expect(events.map((e) => e.type)).toContain('compiling'), 10_000);
    judge.close();

    await vi.waitFor(() => expect(abandoned).toHaveLength(1), 10_000);
    expect(abandoned[0]).toContain('j1');

    // Crucially, NOT an event. `internalError` or `terminated` here would
    // write a permanent IE onto a submission whose only sin was being on the
    // judge that restarted — the exact shape B2 already paid for once.
    expect(events.map((e) => e.type)).toEqual(['dispatched', 'compiling']);

    // The connection is given back, so the fleet's capacity is honest again
    // rather than permanently one judge short.
    expect(driver.idleCapacity()).toBe(0);
    expect(server.judgeCount()).toBe(0);
  }, 60_000);

  it('releases the lease at once, so the job is reclaimable without waiting for it to lapse', async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish: vi.fn(async () => {}) } as never);
      const seeded = await seed(db, store);

      server = new BridgeServer({ languageToExecutor: () => 'CPP17', verifyJudge: async () => true });
      const port = await server.listen(0);
      const driver = new DmojDriver(server, fakeAgent());
      judge = fakeJudge(port);
      await judge.ready;
      await vi.waitFor(() => expect(server!.judgeCount()).toBe(1), 10_000);

      const worker = new Worker(store, writer, driver, 'worker-disconnect');
      const run = worker.start();
      try {
        await vi.waitFor(async () => {
          const [row] = await db.select().from(schema.gradingJobs);
          expect(row?.state).toBe('leased');
        }, 15_000);
        await vi.waitFor(
          () => expect(judge!.received.map((p) => p.name)).toContain('submission-request'),
          15_000,
        );
        judge.send({ name: 'grading-begin', 'submission-id': seeded.jobId });

        judge.close();

        // Promptly — the ceiling for this 5-test revision is 300_000 ms, and
        // the lease is another 60 s on top. Fifteen seconds of slack is two
        // orders of magnitude inside that, so this cannot pass by accident.
        await vi.waitFor(async () => {
          const [row] = await db.select().from(schema.gradingJobs);
          expect(row?.state).toBe('queued');
          expect(row?.leaseUntil).toBeNull();
          // Bumped for the same reason `reclaimExpiredLeases` bumps it: the
          // fencing token must move, so a judge that somehow comes back
          // still holding this grade cannot write onto the retry.
          expect(row?.attempt).toBe(2);
        }, 15_000);

        // And the student's submission carries no verdict at all — an
        // abandoned attempt is a retry, not a result.
        const [submission] = await db
          .select()
          .from(submissions)
          .where(eq(submissions.id, seeded.submissionId));
        expect(submission?.verdict).toBeNull();
        expect(submission?.state).not.toBe('errored');
      } finally {
        worker.stop();
        await Promise.race([run, new Promise((r) => setTimeout(r, 1000))]);
      }
    });
  }, 180_000);
});

async function seed(db: Db, store: JobStore): Promise<{ submissionId: number; jobId: number }> {
  const [user] = await db
    .insert(schema.users)
    .values({ username: 'jd', email: 'jd@e.com', passwordHash: 'x', displayName: 'JD' })
    .returning();
  const [language] = await db
    .insert(schema.languages)
    .values({ key: 'cpp17', name: 'C++17', extension: 'cpp' })
    .returning();
  const [problem] = await db
    .insert(problems)
    .values({ code: 'aplusb', name: 'A+B', statement: 's', createdBy: user!.id })
    .returning();
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
  const jobId = await store.enqueue({ revisionId: revision!.id, packageHash: 'h', submissionId: submission!.id });
  return { submissionId: submission!.id, jobId };
}
