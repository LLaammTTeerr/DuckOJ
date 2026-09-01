import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { problems, problemRevisions, submissions, submissionCases } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { summariseCases } from '@duckoj/contest-formats';
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
  // Migration 0042 seeds the language catalogue (F-39/D154), so `cpp17`
  // exists in every migrated database and inserting it here is now a unique
  // violation on `languages_key_idx`. Read it instead: after 0042 the
  // catalogue is schema-seeded data, not something a fixture owns.
  const [language] = await db
    .select()
    .from(schema.languages)
    .where(eq(schema.languages.key, 'cpp17'));
  const [problem] = await db
    .insert(problems)
    .values({ code: 'aplusb', name: 'A+B', statement: 's', createdBy: user!.id })
    .returning();
  await db.insert(schema.packages).values({ hash: 'h', sizeBytes: 1, fileCount: 1 });
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

  it("summarises the attempt's cases onto the submission when it finishes (D165)", async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish: vi.fn(async () => {}) } as never);
      const { submissionId, job } = await seedSubmissionAndJob(db, store);

      // Two loose cases and a two-case batch, with fractional points spread
      // across magnitudes: the loose pair sums IN ORDER, the batch takes
      // min(points) and max(total). Integer points would make the sum
      // associative and could not tell a wrong order from a right one.
      const cases = [
        { groupIndex: 0, caseIndex: 0, points: 1e-4, maxPoints: 20 },
        { groupIndex: 0, caseIndex: 1, points: 1e-4, maxPoints: 20 },
        { groupIndex: 1, caseIndex: 2, points: 2 ** 40, maxPoints: 30 },
        { groupIndex: 1, caseIndex: 3, points: 7 / 3, maxPoints: 40 },
      ];
      for (const testCase of cases) {
        await writer.apply(job, {
          type: 'caseResult',
          groupIndex: testCase.groupIndex,
          caseIndex: testCase.caseIndex,
          verdict: 'AC',
          skipped: false,
          flags: [],
          timeMs: 1,
          memoryKb: 1,
          points: testCase.points,
          maxPoints: testCase.maxPoints,
          feedback: '',
        });
      }
      await writer.apply(job, {
        type: 'finished',
        verdict: 'AC',
        points: 1,
        maxPoints: 1,
        timeMs: 3,
        memoryKb: 900,
      });

      const [row] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
      // Compared against the reference summariser over the same cases in the
      // same order, field by field with `Object.is` — the fold divides by
      // these numbers, and a scoreboard a fraction of a point out is a wrong
      // scoreboard (D36).
      const expected = summariseCases(
        cases.map((testCase) => ({
          batch: testCase.groupIndex,
          case: testCase.caseIndex,
          points: testCase.points,
          total: testCase.maxPoints,
          status: 'AC',
        })),
      );
      const stored = row?.subtaskSummary as typeof expected | null | undefined;
      expect(stored).toBeDefined();
      expect(stored).not.toBeNull();
      expect(stored!.length).toBe(expected.length);
      for (const [index, want] of expected.entries()) {
        const got = stored![index]!;
        expect(got.batch).toBe(want.batch);
        for (const key of ['minPoints', 'maxTotal', 'sumPoints', 'sumTotal'] as const) {
          expect(
            Object.is(got[key], want[key]),
            `group ${String(index)} ${key}: stored ${String(got[key])} vs ${String(want[key])}`,
          ).toBe(true);
        }
      }
      // And the loose sum really is order-sensitive on this input, so the
      // assertion above is testing something.
      expect(1e-4 + 1e-4 + 2 ** 40).not.toBe(2 ** 40 + 1e-4 + 1e-4);
    });
  }, 120_000);

  it('summarises an empty attempt as an empty list, never as null (D165)', async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish: vi.fn(async () => {}) } as never);
      const { submissionId, job } = await seedSubmissionAndJob(db, store);

      await writer.apply(job, { type: 'compileError', message: 'no' });

      const [row] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
      // Null means "ask the case rows"; a compile error has none and never
      // will, so a null here would send the fold to the residue read forever.
      expect(row?.subtaskSummary).toEqual([]);
    });
  }, 120_000);

  it('summarises the latest attempt only, when an earlier one left rows behind (D165)', async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish: vi.fn(async () => {}) } as never);
      const { submissionId, job } = await seedSubmissionAndJob(db, store);

      await writer.apply(job, {
        type: 'caseResult',
        groupIndex: 0,
        caseIndex: 0,
        verdict: 'WA',
        skipped: false,
        flags: [],
        timeMs: 1,
        memoryKb: 1,
        points: 11,
        maxPoints: 20,
        feedback: '',
      });
      await writer.apply(job, {
        type: 'finished',
        verdict: 'WA',
        points: 11,
        maxPoints: 20,
        timeMs: 1,
        memoryKb: 1,
      });

      // A reclaim bumps the attempt without deleting the first attempt's rows
      // — the regrade path, not the rejudge path.
      await db.execute(sql`update grading_jobs set lease_until = now() - interval '1 second'`);
      const second = (await store.claim('worker-b'))!;
      await writer.apply(second, {
        type: 'caseResult',
        groupIndex: 0,
        caseIndex: 0,
        verdict: 'AC',
        skipped: false,
        flags: [],
        timeMs: 1,
        memoryKb: 1,
        points: 20,
        maxPoints: 20,
        feedback: '',
      });
      await writer.apply(second, {
        type: 'finished',
        verdict: 'AC',
        points: 20,
        maxPoints: 20,
        timeMs: 1,
        memoryKb: 1,
      });

      const [row] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
      // 20, not 11 and not 31: both attempts' rows are in the table and the
      // fold reads the highest attempt, so the summary must too.
      expect(row?.subtaskSummary).toEqual([
        { batch: 0, minPoints: 20, maxTotal: 20, sumPoints: 20, sumTotal: 20 },
      ]);
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

      // Force a real database failure: `case_verdict` is a Postgres enum, so
      // writing a case result that claims a verdict outside its member list
      // is rejected by Postgres itself — not by `onConflictDoNothing`, which
      // only absorbs a conflict on the identity index, not an invalid enum
      // literal. `'ZZ'` (not `'CE'`, since Task 1 added that as a real
      // member) is the poison value here for exactly that reason.
      const badEvent = {
        type: 'caseResult',
        groupIndex: 0,
        caseIndex: 0,
        verdict: 'ZZ',
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

  it('records a compile error as verdict CE with the compile log preserved', async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish: vi.fn(async () => {}) } as never);
      const { submissionId, job } = await seedSubmissionAndJob(db, store);

      const log = "error: expected ';' before '}' token";

      await writer.apply(job, { type: 'compileError', message: log });

      const [row] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
      // A compile error is a graded outcome the submitter caused, not a
      // judge-side failure: it lands on `done`, not `errored`.
      expect(row?.state).toBe('done');
      expect(row?.verdict).toBe('CE');
      // The whole point of distinguishing CE from IE is that the person
      // fixing their code gets to see why it didn't compile.
      expect(row?.compileOutput).toBe(log);
      expect(row?.compileOutput).not.toHaveLength(0);
    });
  }, 120_000);

  it('keeps a genuine internal error on verdict IE, distinct from a compile error', async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish: vi.fn(async () => {}) } as never);
      const { submissionId, job } = await seedSubmissionAndJob(db, store);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Guards against a "simplification" that maps every judge-side
      // failure to the same verdict: a test that only proves compileError
      // -> CE would still pass if internalError were mapped to CE too.
      await writer.apply(job, { type: 'internalError', message: 'boom' });

      const [row] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
      expect(row?.verdict).toBe('IE');
      expect(row?.verdict).not.toBe('CE');

      errorSpy.mockRestore();
    });
  }, 120_000);

  /**
   * Final review's **m7**, closed.
   *
   * `apply` checks `isCurrentAttempt` once — a separate SELECT — and then
   * inserts case rows. Every `submissions` UPDATE folds the attempt into its
   * own WHERE (`fencedById`), but the `submission_cases` INSERT did not: it
   * was check-then-act, and `RejudgeService.requeueAll` bumps `attempt` on the
   * same `grading_jobs` row and DELETEs the old case rows. A stale insert
   * landing in that gap re-creates rows for the superseded attempt, and
   * `getVisible` picks the attempt by `max(attempt)` — so until the re-claim
   * reports its first case, the UI shows the OLD per-case verdicts beside a
   * `queued` submission.
   *
   * Deterministic, not a race: the check is stubbed to have already passed,
   * and the supersession is applied in the gap it leaves.
   */
  it('does not insert case rows for an attempt superseded between the check and the insert', async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish: vi.fn(async () => {}) } as never);
      const { submissionId, job } = await seedSubmissionAndJob(db, store);

      // The check has already passed — this is the state `apply` is in when
      // it reaches the insert.
      vi.spyOn(store, 'isCurrentAttempt').mockResolvedValue(true);
      // …and a rejudge lands in the gap.
      await db.execute(
        sql`update grading_jobs set attempt = attempt + 1 where id = ${job.id}`,
      );

      await writer.apply(job, {
        type: 'caseResult',
        groupIndex: 0,
        caseIndex: 0,
        verdict: 'AC',
        skipped: false,
        flags: [],
        timeMs: 1,
        memoryKb: 1,
        points: 10,
        maxPoints: 10,
        feedback: '',
      });

      const rows = await db
        .select()
        .from(submissionCases)
        .where(eq(submissionCases.submissionId, submissionId));
      expect(rows).toEqual([]);
    });
  }, 120_000);

  it('still inserts the case row for the current attempt', async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish: vi.fn(async () => {}) } as never);
      const { submissionId, job } = await seedSubmissionAndJob(db, store);

      await writer.apply(job, {
        type: 'caseResult',
        groupIndex: 0,
        caseIndex: 0,
        verdict: 'AC',
        skipped: false,
        flags: [],
        timeMs: 1,
        memoryKb: 1,
        points: 10,
        maxPoints: 10,
        feedback: '',
      });

      const rows = await db
        .select()
        .from(submissionCases)
        .where(eq(submissionCases.submissionId, submissionId));
      expect(rows).toHaveLength(1);
    });
  }, 120_000);

  it('records the judge node a dispatched event names, joining job to node (D68)', async () => {
    await withTestDb(async (db) => {
      const publish = vi.fn(async () => {});
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish } as never);
      const { job } = await seedSubmissionAndJob(db, store);
      await db
        .insert(schema.judgeNodes)
        .values({ name: 'judge-2', tokenHash: 'hash-2', driver: 'dmoj' });

      await writer.apply(job, { type: 'dispatched', node: 'judge-2' });

      const rows = await db.execute<{ name: string | null }>(sql`
        select judge_nodes.name from grading_jobs
          left join judge_nodes on judge_nodes.id = grading_jobs.judge_node_id
         where grading_jobs.id = ${job.id}
      `);
      expect(rows[0]?.name).toBe('judge-2');
    });
  }, 120_000);

  it('writes no node when the driver names none — an in-process driver must not invent one', async () => {
    await withTestDb(async (db) => {
      const publish = vi.fn(async () => {});
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish } as never);
      const { job } = await seedSubmissionAndJob(db, store);

      await writer.apply(job, { type: 'dispatched' });

      const rows = await db.execute<{ judge_node_id: number | null }>(
        sql`select judge_node_id from grading_jobs where id = ${job.id}`,
      );
      expect(rows[0]?.judge_node_id).toBeNull();
    });
  }, 120_000);
});
