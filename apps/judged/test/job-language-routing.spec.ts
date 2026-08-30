/**
 * D68's database half: a heterogeneous judge fleet.
 *
 * `JobStore.claim` filters by what the fleet can grade, `markBlocked` says
 * out loud why a queued job is not moving, and `recordJudgeNode` records
 * which judge took it — the node↔job join D47 explicitly did not have.
 *
 * Against a real Postgres, because every property here lives in SQL: the
 * outer joins that must not drop a language-less job, `FOR UPDATE OF
 * grading_jobs` (which Postgres rejects outright if written as a bare `FOR
 * UPDATE` over those joins), and `is distinct from` over a nullable column.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { schema, type Db } from '@duckoj/db';
import { problems, problemRevisions, submissions } from '@duckoj/db/guarded';
import { JobStore } from '../src/job-store.js';
import { withTestDb } from './db.harness.js';

interface Fixture {
  store: JobStore;
  /** Enqueues one job for a submission in `languageKey`, and answers its job id. */
  enqueue(languageKey: string): Promise<number>;
  /** Enqueues a job with no submission at all — the future invocation kind. */
  enqueueLanguageless(): Promise<number>;
  blockedReason(jobId: number): Promise<string | null>;
  judgeNodeName(jobId: number): Promise<string | null>;
}

async function fixture(db: Db): Promise<Fixture> {
  const store = new JobStore(db);
  const [user] = await db
    .insert(schema.users)
    .values({ username: 'lr', email: 'lr@e.com', passwordHash: 'x', displayName: 'L' })
    .returning();
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
  const languageIds = new Map<string, number>();
  for (const key of ['cpp17', 'python3']) {
    const [language] = await db
      .insert(schema.languages)
      .values({ key, name: key, extension: key === 'cpp17' ? 'cpp' : 'py' })
      .returning();
    languageIds.set(key, language!.id);
  }

  return {
    store,
    async enqueue(languageKey) {
      const [submission] = await db
        .insert(submissions)
        .values({
          userId: user!.id,
          problemId: problem!.id,
          revisionId: revision!.id,
          languageId: languageIds.get(languageKey)!,
          source: 'int main(){}',
        })
        .returning();
      return store.enqueue({
        revisionId: revision!.id,
        packageHash: 'h',
        submissionId: submission!.id,
      });
    },
    enqueueLanguageless() {
      return store.enqueue({ revisionId: revision!.id, packageHash: 'h', submissionId: null });
    },
    async blockedReason(jobId) {
      const rows = await db.execute<{ blocked_reason: string | null }>(
        sql`select blocked_reason from grading_jobs where id = ${jobId}`,
      );
      return rows[0]?.blocked_reason ?? null;
    },
    async judgeNodeName(jobId) {
      const rows = await db.execute<{ name: string | null }>(sql`
        select judge_nodes.name from grading_jobs
          left join judge_nodes on judge_nodes.id = grading_jobs.judge_node_id
         where grading_jobs.id = ${jobId}
      `);
      return rows[0]?.name ?? null;
    },
  };
}

describe('claim, filtered by what the fleet can grade', () => {
  it('skips a job no connected judge can run, and takes the next one instead', async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      // Oldest first: the python job would win every claim if the filter
      // were applied after the pick instead of inside it — which is exactly
      // the starvation D68 rules out.
      const python = await f.enqueue('python3');
      const cpp = await f.enqueue('cpp17');

      const claimed = await f.store.claim('worker-a', ['cpp17']);

      expect(claimed?.id).toBe(cpp);
      expect(claimed?.languageKey).toBe('cpp17');
      const rows = await db.execute<{ state: string }>(
        sql`select state from grading_jobs where id = ${python}`,
      );
      expect(rows[0]?.state).toBe('queued');
    });
  }, 120_000);

  it('claims anything when the caller names no languages (a driver that declares none)', async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const python = await f.enqueue('python3');

      expect((await f.store.claim('worker-a'))?.id).toBe(python);
    });
  }, 120_000);

  it('claims a job that has no language at all, whatever the fleet speaks', async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const jobId = await f.enqueueLanguageless();

      // Even with an empty fleet vocabulary: a job nobody recorded a
      // language for must not become unclaimable forever.
      expect((await f.store.claim('worker-a', []))?.id).toBe(jobId);
    });
  }, 120_000);

  it('clears blocked_reason on the claim itself', async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const jobId = await f.enqueue('python3');
      await f.store.markBlocked(['cpp17']);
      expect(await f.blockedReason(jobId)).toContain('python3');

      await f.store.claim('worker-a', ['python3', 'cpp17']);

      expect(await f.blockedReason(jobId)).toBeNull();
    });
  }, 120_000);
});

describe('markBlocked', () => {
  it('marks a queued job whose language nothing speaks, naming the language', async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const python = await f.enqueue('python3');
      const cpp = await f.enqueue('cpp17');

      expect(await f.store.markBlocked(['cpp17'])).toEqual([python]);

      expect(await f.blockedReason(python)).toBe('no connected judge supports language python3');
      expect(await f.blockedReason(cpp)).toBeNull();
    });
  }, 120_000);

  it('unmarks a job the moment a judge that speaks its language arrives', async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const python = await f.enqueue('python3');
      await f.store.markBlocked(['cpp17']);

      expect(await f.store.markBlocked(['cpp17', 'python3'])).toEqual([python]);

      expect(await f.blockedReason(python)).toBeNull();
    });
  }, 120_000);

  it('changes nothing, and says so, on a steady queue', async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await f.enqueue('python3');
      await f.store.markBlocked(['cpp17']);

      // Idempotent: a loop calling this every few seconds must not report a
      // change every time, or the log becomes a heartbeat nobody reads.
      expect(await f.store.markBlocked(['cpp17'])).toEqual([]);
    });
  }, 120_000);

  it('leaves a leased job alone — only a queued job can be blocked', async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const python = await f.enqueue('python3');
      await f.store.claim('worker-a');

      expect(await f.store.markBlocked(['cpp17'])).toEqual([]);
      expect(await f.blockedReason(python)).toBeNull();
    });
  }, 120_000);
});

describe('recordJudgeNode', () => {
  it('records which node took the attempt', async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const jobId = await f.enqueue('cpp17');
      await db
        .insert(schema.judgeNodes)
        .values({ name: 'judge-2', tokenHash: 'hash-2', driver: 'dmoj' });
      const claimed = await f.store.claim('worker-a', ['cpp17']);

      expect(await f.store.recordJudgeNode(jobId, claimed!.attempt, 'judge-2')).toBe(true);

      expect(await f.judgeNodeName(jobId)).toBe('judge-2');
    });
  }, 120_000);

  it('refuses a superseded attempt, so a late dispatch cannot relabel the retry', async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const jobId = await f.enqueue('cpp17');
      for (const name of ['judge-1', 'judge-2']) {
        await db
          .insert(schema.judgeNodes)
          .values({ name, tokenHash: `hash-${name}`, driver: 'dmoj' });
      }
      const first = await f.store.claim('worker-a', ['cpp17']);
      await f.store.recordJudgeNode(jobId, first!.attempt, 'judge-1');
      await db.execute(sql`update grading_jobs set lease_until = now() - interval '1 second'`);
      const second = await f.store.claim('worker-b', ['cpp17']);
      await f.store.recordJudgeNode(jobId, second!.attempt, 'judge-2');

      expect(await f.store.recordJudgeNode(jobId, first!.attempt, 'judge-1')).toBe(false);

      expect(await f.judgeNodeName(jobId)).toBe('judge-2');
    });
  }, 120_000);

  it('leaves a known node in place when asked to record one that does not exist', async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const jobId = await f.enqueue('cpp17');
      await db
        .insert(schema.judgeNodes)
        .values({ name: 'judge-1', tokenHash: 'hash-1', driver: 'dmoj' });
      const claimed = await f.store.claim('worker-a', ['cpp17']);
      await f.store.recordJudgeNode(jobId, claimed!.attempt, 'judge-1');

      expect(await f.store.recordJudgeNode(jobId, claimed!.attempt, 'ghost')).toBe(false);

      expect(await f.judgeNodeName(jobId)).toBe('judge-1');
    });
  }, 120_000);
});
