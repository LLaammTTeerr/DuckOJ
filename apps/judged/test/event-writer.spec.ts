import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { problems, problemRevisions, submissions, submissionCases } from '@qhhoj/db/guarded';
import { schema, type Db } from '@qhhoj/db';
import { EventWriter } from '../src/event-writer.js';
import { JobStore, type ClaimedJob } from '../src/job-store.js';
import { withTestDb } from './db.harness.js';

async function seedSubmissionAndJob(
  db: Db,
  store: JobStore,
): Promise<{ submissionId: number; job: ClaimedJob }> {
  const [user] = await db
    .insert(schema.users)
    .values({ username: 'w', email: 'w@e.com', passwordHash: 'x', displayName: 'W' })
    .returning();
  const [language] = await db
    .insert(schema.languages)
    .values({ key: 'cpp17', name: 'C++17', extension: 'cpp' })
    .returning();
  const [problem] = await db
    .insert(problems)
    .values({ code: 'aplusb', name: 'A+B', statement: 's' })
    .returning();
  await db.insert(schema.packages).values({ hash: 'h', sizeBytes: 1, fileCount: 1 });
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
      source: 'int main(){}',
    })
    .returning();

  await store.enqueue({
    revisionId: revision!.id,
    packageHash: 'h',
    submissionId: submission!.id,
  });
  const job = (await store.claim('worker-a'))!;
  return { submissionId: submission!.id, job };
}

describe('EventWriter', () => {
  it('records a finished event on the submission and publishes once', async () => {
    await withTestDb(async (db) => {
      const publish = vi.fn(async () => {});
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish } as never);
      const { submissionId, job } = await seedSubmissionAndJob(db, store);

      const applied = await writer.apply(job, {
        type: 'finished',
        verdict: 'AC',
        points: 1,
        maxPoints: 1,
        timeMs: 3,
        memoryKb: 900,
      });

      expect(applied).toBe(true);
      const [row] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
      expect(row?.state).toBe('done');
      expect(row?.verdict).toBe('AC');
      expect(publish).toHaveBeenCalledWith(submissionId);
    });
  }, 120_000);

  it('rejects an event from a superseded attempt and writes nothing', async () => {
    await withTestDb(async (db) => {
      const publish = vi.fn(async () => {});
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish } as never);
      const { submissionId, job } = await seedSubmissionAndJob(db, store);

      await db.execute(sql`update grading_jobs set lease_until = now() - interval '1 second'`);
      await store.claim('worker-b');

      const applied = await writer.apply(job, {
        type: 'finished',
        verdict: 'WA',
        points: 0,
        maxPoints: 1,
        timeMs: 3,
        memoryKb: 900,
      });

      expect(applied).toBe(false);
      const [row] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
      expect(row?.verdict).toBeNull();
      expect(publish).not.toHaveBeenCalled();
    });
  }, 120_000);

  it('writes a case result with its verdict, flags and skipped state', async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish: vi.fn(async () => {}) } as never);
      const { submissionId, job } = await seedSubmissionAndJob(db, store);

      await writer.apply(job, {
        type: 'caseResult',
        groupIndex: 0,
        caseIndex: 2,
        verdict: null,
        skipped: true,
        flags: ['SC'],
        timeMs: 0,
        memoryKb: 0,
        points: 0,
        maxPoints: 1,
        feedback: '',
      });

      const [row] = await db
        .select()
        .from(submissionCases)
        .where(eq(submissionCases.submissionId, submissionId));
      expect(row?.skipped).toBe(true);
      expect(row?.verdict).toBeNull();
      expect(row?.flags).toEqual(['SC']);
    });
  }, 120_000);

  it('moves the submission to "grading" on the first case result', async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish: vi.fn(async () => {}) } as never);
      const { submissionId, job } = await seedSubmissionAndJob(db, store);

      await writer.apply(job, { type: 'compiling' });
      let [row] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
      expect(row?.state).toBe('compiling');

      await writer.apply(job, {
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
      });

      [row] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
      // Without this, `state` jumps straight from `compiling` to `done` and
      // the UI shows "Compiling" for the submission's entire run.
      expect(row?.state).toBe('grading');
    });
  }, 120_000);

  it('tolerates a redelivered case result instead of duplicating it', async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish: vi.fn(async () => {}) } as never);
      const { submissionId, job } = await seedSubmissionAndJob(db, store);
      const event = {
        type: 'caseResult' as const,
        groupIndex: 0,
        caseIndex: 0,
        verdict: 'AC' as const,
        skipped: false,
        flags: [],
        timeMs: 1,
        memoryKb: 1,
        points: 1,
        maxPoints: 1,
        feedback: '',
      };

      await writer.apply(job, event);
      await writer.apply(job, event);

      const rows = await db
        .select()
        .from(submissionCases)
        .where(eq(submissionCases.submissionId, submissionId));
      expect(rows).toHaveLength(1);
    });
  }, 120_000);

  it('does not publish when the write itself fails', async () => {
    await withTestDb(async (db) => {
      const publish = vi.fn(async () => {});
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish } as never);
      const { job } = await seedSubmissionAndJob(db, store);

      // Force a real database failure: `case_verdict` is a Postgres enum with
      // no `CE` member (see the note on `compileError` above), so writing a
      // case result that claims one is rejected by Postgres itself — not by
      // `onConflictDoNothing`, which only absorbs a conflict on the
      // identity index, not an invalid enum literal.
      const badEvent = {
        type: 'caseResult',
        groupIndex: 0,
        caseIndex: 0,
        verdict: 'CE',
        skipped: false,
        flags: [],
        timeMs: 1,
        memoryKb: 1,
        points: 0,
        maxPoints: 1,
        feedback: '',
      } as never;

      const error: unknown = await writer.apply(job, badEvent).catch((e: unknown) => e);

      // Confirm this is a genuine driver error, not a guard we wrote:
      // postgres.js wraps the raw wire-protocol error as `.cause`.
      expect(error).toBeInstanceOf(Error);
      expect((error as { cause?: { message?: string } }).cause?.message).toMatch(
        /invalid input value for enum case_verdict/,
      );

      // A write that threw must never announce state that was never stored.
      expect(publish).not.toHaveBeenCalled();
    });
  }, 120_000);

  it('writes a generic message for internalError, keeping the judge traceback only in the log', async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish: vi.fn(async () => {}) } as never);
      const { submissionId, job } = await seedSubmissionAndJob(db, store);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const traceback =
        'Traceback (most recent call last):\n  File "/judge/executors/CPP17.py", line 42, in grade\nRuntimeError: sandbox exec failed';

      await writer.apply(job, { type: 'internalError', message: traceback });

      const [row] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
      expect(row?.state).toBe('errored');
      expect(row?.verdict).toBe('IE');
      // The client-facing field must never carry judge-internal detail.
      expect(row?.compileOutput).not.toContain('Traceback');
      expect(row?.compileOutput).not.toContain('CPP17.py');
      expect(row?.compileOutput).toBe(
        'Grading failed due to an internal judge error. This has been logged for investigation.',
      );

      // The raw detail must still reach an operator, just not the client.
      const logged = errorSpy.mock.calls.map((c) => c[0]).find((line) => typeof line === 'string');
      expect(logged).toBeDefined();
      expect(logged as string).toContain('Traceback');

      errorSpy.mockRestore();
    });
  }, 120_000);
});
