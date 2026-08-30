/**
 * The admin operations dashboard (D47), against a real database.
 *
 * Every panel is a query written by hand in SQL, which is exactly the kind
 * of code a unit test with a fake database cannot check: the interesting
 * failures here are `filter (where …)` clauses that select the wrong rows,
 * a lease comparison the wrong way round, and a `substring` off by one.
 * So the panels are tested against Postgres with rows deliberately placed on
 * both sides of every boundary.
 *
 * `withTestDb` runs each test inside one transaction, which means `now()` is
 * frozen at its start — a property this suite RELIES on: a row inserted here
 * and a row backdated by an hour are exactly one hour apart, with no clock
 * skew between the seed and the assertion.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import { problems, problemRevisions, submissions } from '@duckoj/db/guarded';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { DashboardService, type RedisHealth } from '../src/authz/dashboard.access.js';
import { RateLimiter } from '../src/common/rate-limiter.js';
import type { Actor } from '../src/authz/actor.js';
import {
  insertGradedSubmission,
  insertUser,
  registerAndLogin,
  seedProblemAndLanguage,
} from './submissions.fixtures.js';

const UP: RedisHealth = { reachable: async () => true };
const DOWN: RedisHealth = { reachable: async () => false };

function admin(userId = 1): Actor {
  return { userId, globalRole: 'admin', via: 'session', scopes: [] };
}
function plainUser(userId = 2): Actor {
  return { userId, globalRole: 'user', via: 'session', scopes: [] };
}

/** A `grading_jobs` row in whatever state the panel under test needs. */
async function seedJob(
  db: Db,
  opts: {
    state: 'queued' | 'leased' | 'done' | 'failed';
    workerId?: string;
    leaseSeconds?: number;
    submissionId?: number;
    ageSeconds?: number;
  },
): Promise<number> {
  const [revision] = await db
    .select({ id: problemRevisions.id, hash: problemRevisions.packageHash })
    .from(problemRevisions)
    .limit(1);
  const rows = await db.execute<{ id: number }>(sql`
    insert into grading_jobs (revision_id, package_hash, state, worker_id, lease_until, submission_id, created_at)
    values (${revision!.id}, ${revision!.hash}, ${opts.state}, ${opts.workerId ?? null},
            ${opts.leaseSeconds === undefined ? null : sql`now() + make_interval(secs => ${opts.leaseSeconds}::double precision)`},
            ${opts.submissionId ?? null},
            now() - make_interval(secs => ${opts.ageSeconds ?? 0}::double precision))
    returning id
  `);
  return Number(rows[0]!.id);
}

async function seedProblemAndUser(db: Db): Promise<{ userId: number; problemId: number }> {
  await seedProblemAndLanguage(db);
  const user = await insertUser(db, 'dash-user');
  const [problem] = await db.select({ id: problems.id }).from(problems).where(eq(problems.code, 'aplusb'));
  return { userId: user.id, problemId: problem!.id };
}

describe('GET /admin/dashboard — the queue panel', () => {
  it('splits leased into running and expired, and never double-counts', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      await seedJob(db, { state: 'queued', ageSeconds: 300 });
      await seedJob(db, { state: 'queued', ageSeconds: 30 });
      await seedJob(db, { state: 'leased', leaseSeconds: 60, workerId: 'w#1' });
      await seedJob(db, { state: 'leased', leaseSeconds: -5, workerId: 'w#2' });
      await seedJob(db, { state: 'failed' });
      await seedJob(db, { state: 'done' });

      const { queue } = await new DashboardService(db, UP).snapshot(admin());
      expect(queue).toMatchObject({ queued: 2, running: 1, expiredLeases: 1, failed: 1 });
      // The OLDEST queued job, not the newest and not the average.
      expect(queue.oldestQueuedSeconds).toBe(300);
    });
  }, 120_000);

  it('reports a null age rather than a zero when nothing is queued', async () => {
    // Zero would read as "a job queued this instant", which is the opposite
    // of an empty queue and the difference between calm and alarming.
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      await seedJob(db, { state: 'done' });
      const { queue } = await new DashboardService(db, UP).snapshot(admin());
      expect(queue.oldestQueuedSeconds).toBeNull();
      expect(queue.queued).toBe(0);
    });
  }, 120_000);
});

describe('GET /admin/dashboard — the judge panel', () => {
  it('calls a judge offline once it has been silent past the bridge\'s own limit', async () => {
    await withTestDb(async (db) => {
      await db.insert(schema.judgeNodes).values([
        { name: 'judge-live', tokenHash: 'a'.repeat(64), driver: 'dmoj' },
        { name: 'judge-stale', tokenHash: 'b'.repeat(64), driver: 'dmoj' },
        { name: 'judge-never', tokenHash: 'c'.repeat(64), driver: 'dmoj' },
      ]);
      await db.execute(sql`update judge_nodes set last_seen = now() - interval '10 seconds' where name = 'judge-live'`);
      await db.execute(sql`update judge_nodes set last_seen = now() - interval '200 seconds' where name = 'judge-stale'`);

      const { judges } = await new DashboardService(db, UP).snapshot(admin());
      expect(judges.map((j) => [j.name, j.online])).toEqual([
        ['judge-live', true],
        ['judge-never', false],
        ['judge-stale', false],
      ]);
      // A judge that has never handshaken has no timestamp to show, and
      // that is not the same as one that checked in at the epoch.
      expect(judges.find((j) => j.name === 'judge-never')?.lastSeen).toBeNull();
    });
  }, 120_000);
});

describe('GET /admin/dashboard — the worker panel', () => {
  it('names the submission a worker holds a live lease on, and counts its last hour', async () => {
    await withTestDb(async (db) => {
      const { userId, problemId } = await seedProblemAndUser(db);
      const live = await insertGradedSubmission(db, { userId, problemId });
      const recent = await insertGradedSubmission(db, { userId, problemId, verdict: 'AC', points: 100, maxPoints: 100 });
      const recentIe = await insertGradedSubmission(db, { userId, problemId, verdict: 'IE' });
      const old = await insertGradedSubmission(db, { userId, problemId, verdict: 'AC', points: 100, maxPoints: 100 });
      await db.update(submissions).set({ judgedAt: sql`now() - interval '5 minutes'` }).where(eq(submissions.id, recent));
      await db.update(submissions).set({ judgedAt: sql`now() - interval '5 minutes'` }).where(eq(submissions.id, recentIe));
      // Just outside the window — the one row that proves the window exists.
      await db.update(submissions).set({ judgedAt: sql`now() - interval '61 minutes'` }).where(eq(submissions.id, old));

      const jobId = await seedJob(db, { state: 'leased', leaseSeconds: 45, workerId: 'judged-1#1', submissionId: live });
      await seedJob(db, { state: 'done', workerId: 'judged-1#1', submissionId: recent });
      await seedJob(db, { state: 'done', workerId: 'judged-1#1', submissionId: recentIe });
      await seedJob(db, { state: 'done', workerId: 'judged-1#1', submissionId: old });
      // A second worker with an EXPIRED lease holds nothing: the panel says
      // what is being graded now, not what was claimed once.
      await seedJob(db, { state: 'leased', leaseSeconds: -1, workerId: 'judged-1#2', submissionId: live });

      const { workers } = await new DashboardService(db, UP).snapshot(admin());
      expect(workers).toEqual([
        {
          workerId: 'judged-1#1',
          currentSubmissionId: live,
          currentJobId: jobId,
          gradedLastHour: 2,
          internalErrorsLastHour: 1,
        },
        {
          workerId: 'judged-1#2',
          currentSubmissionId: null,
          currentJobId: null,
          gradedLastHour: 0,
          internalErrorsLastHour: 0,
        },
      ]);
    });
  }, 120_000);

  it('lists a worker that finished work this hour but is holding nothing now', async () => {
    await withTestDb(async (db) => {
      // Migration 0025 answers "what is it grading" and "what did it finish"
      // with two separate queries, because one unbounded join over all of
      // `grading_jobs` and all of `submissions` is what the dashboard used to
      // run every fifteen seconds. Merging two result sets introduces a
      // failure the single query could not have: a worker present in only ONE
      // of them being dropped. This is that case in the direction the panel
      // above does not cover — throughput, nothing in flight — and its mirror
      // (`judged-1#2`: in flight, no throughput) is asserted there.
      const { userId, problemId } = await seedProblemAndUser(db);
      const graded = await insertGradedSubmission(db, { userId, problemId, verdict: 'AC', points: 100, maxPoints: 100 });
      await db.update(submissions).set({ judgedAt: sql`now() - interval '5 minutes'` }).where(eq(submissions.id, graded));
      await seedJob(db, { state: 'done', workerId: 'judged-2#1', submissionId: graded });

      const { workers } = await new DashboardService(db, UP).snapshot(admin());
      expect(workers).toEqual([
        {
          workerId: 'judged-2#1',
          currentSubmissionId: null,
          currentJobId: null,
          gradedLastHour: 1,
          internalErrorsLastHour: 0,
        },
      ]);
    });
  }, 120_000);
});

describe('GET /admin/dashboard — the failures panel', () => {
  it('carries infrastructure failures newest first and leaves a wrong answer out', async () => {
    await withTestDb(async (db) => {
      const { userId, problemId } = await seedProblemAndUser(db);
      await insertGradedSubmission(db, { userId, problemId, verdict: 'AC', points: 100, maxPoints: 100 });
      // A WA is the system working, not a failure.
      await db.insert(submissions).values({
        userId, problemId,
        revisionId: (await db.select({ id: problems.currentRevisionId }).from(problems).where(eq(problems.id, problemId)))[0]!.id!,
        languageId: (await db.select({ id: schema.languages.id }).from(schema.languages))[0]!.id,
        source: 'wa', state: 'done', verdict: 'WA', points: 0, maxPoints: 100,
      });
      const firstIe = await insertGradedSubmission(db, { userId, problemId, verdict: 'IE' });
      const secondIe = await insertGradedSubmission(db, { userId, problemId, verdict: 'IE' });

      const { recentFailures } = await new DashboardService(db, UP).snapshot(admin());
      expect(recentFailures.map((f) => f.submissionId)).toEqual([secondIe, firstIe]);
      expect(recentFailures[0]).toMatchObject({
        problemCode: 'aplusb',
        username: 'dash-user',
        verdict: 'IE',
        state: 'errored',
      });
    });
  }, 120_000);

  it('carries at most twenty, however many there are', async () => {
    await withTestDb(async (db) => {
      const { userId, problemId } = await seedProblemAndUser(db);
      for (let i = 0; i < 25; i++) {
        await insertGradedSubmission(db, { userId, problemId, verdict: 'IE' });
      }
      const { recentFailures } = await new DashboardService(db, UP).snapshot(admin());
      expect(recentFailures).toHaveLength(20);
    });
  }, 120_000);
});

describe('GET /admin/dashboard — the refusals panel', () => {
  it('groups the last hour by the bare purpose, busiest first', async () => {
    await withTestDb(async (db) => {
      const limiter = new RateLimiter(db);
      // Two refusals of one purpose, one of another, and an admitted
      // attempt that must not appear anywhere.
      await limiter.allow('password_reset', 'a@b.com', 1, 3_600_000);
      await limiter.allow('password_reset', 'a@b.com', 1, 3_600_000);
      await limiter.allow('password_reset', 'a@b.com', 1, 3_600_000);
      await limiter.allow('email_verification', '7', 0, 3_600_000);

      const { refusalsLastHour } = await new DashboardService(db, DOWN).snapshot(admin());
      expect(refusalsLastHour).toEqual([
        { purpose: 'password_reset', count: 2 },
        { purpose: 'email_verification', count: 1 },
      ]);
    });
  }, 120_000);

  it('forgets a refusal older than the hour', async () => {
    await withTestDb(async (db) => {
      const limiter = new RateLimiter(db);
      await limiter.allow('login', 'x', 0, 3_600_000);
      await db.execute(sql`update rate_events set created_at = now() - interval '61 minutes'`);
      const { refusalsLastHour } = await new DashboardService(db, DOWN).snapshot(admin());
      expect(refusalsLastHour).toEqual([]);
    });
  }, 120_000);
});

describe('GET /admin/dashboard — dependencies and runtime', () => {
  it('reports Redis as it found it, and the API worker count in effect', async () => {
    await withTestDb(async (db) => {
      const down = await new DashboardService(db, DOWN).snapshot(admin());
      expect(down.dependencies).toEqual({ database: 'up', redis: 'down' });
      const up = await new DashboardService(db, UP).snapshot(admin());
      expect(up.dependencies.redis).toBe('up');
      expect(up.runtime.apiWorkers).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(up.runtime.apiWorkers)).toBe(true);
    });
  }, 120_000);

  it('admits it does not know judged\'s concurrency rather than guessing one', async () => {
    await withTestDb(async (db) => {
      const previous = process.env.JUDGED_CONCURRENCY;
      try {
        delete process.env.JUDGED_CONCURRENCY;
        expect((await new DashboardService(db, UP).snapshot(admin())).runtime.judgedConcurrency).toBeNull();
        process.env.JUDGED_CONCURRENCY = '3';
        expect((await new DashboardService(db, UP).snapshot(admin())).runtime.judgedConcurrency).toBe(3);
        // Garbage is "not told", not a 500: this knob does not govern the
        // process reading it.
        process.env.JUDGED_CONCURRENCY = 'lots';
        expect((await new DashboardService(db, UP).snapshot(admin())).runtime.judgedConcurrency).toBeNull();
      } finally {
        if (previous === undefined) delete process.env.JUDGED_CONCURRENCY;
        else process.env.JUDGED_CONCURRENCY = previous;
      }
    });
  }, 120_000);
});

describe('POST /admin/grading/reclaim', () => {
  it('requeues only the lapsed leases, and a second call finds nothing', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const lapsed = await seedJob(db, { state: 'leased', leaseSeconds: -30, workerId: 'judged-1#1' });
      await seedJob(db, { state: 'leased', leaseSeconds: 30, workerId: 'judged-1#2' });
      const service = new DashboardService(db, UP);

      const first = await service.reclaimLeases(admin());
      expect(first).toEqual({ reclaimed: 1, jobIds: [lapsed] });
      expect(await service.reclaimLeases(admin())).toEqual({ reclaimed: 0, jobIds: [] });

      // And the dashboard now agrees with the button that pressed it.
      const { queue } = await service.snapshot(admin());
      expect(queue).toMatchObject({ queued: 1, running: 1, expiredLeases: 0 });
    });
  }, 120_000);

  it('refuses a non-admin', async () => {
    await withTestDb(async (db) => {
      const service = new DashboardService(db, UP);
      await expect(service.reclaimLeases(plainUser())).rejects.toMatchObject({ code: 'admin_forbidden' });
      await expect(service.snapshot(plainUser())).rejects.toMatchObject({ code: 'admin_forbidden' });
    });
  }, 120_000);
});

describe('the admin dashboard over HTTP', () => {
  it('serves an admin and refuses everyone else', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const adminAgent = request.agent(app.getHttpServer());
        await registerAndLogin(adminAgent, 'dash-admin');
        await db.update(schema.users).set({ globalRole: 'admin' }).where(eq(schema.users.username, 'dash-admin'));

        const res = await adminAgent.get('/admin/dashboard');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          queue: { queued: 0, running: 0, expiredLeases: 0, failed: 0, oldestQueuedSeconds: null },
          judges: [],
          workers: [],
          recentFailures: [],
          // TEST_CONFIG points Redis at a deliberately unreachable port.
          dependencies: { database: 'up', redis: 'down' },
        });
        expect(typeof res.body.generatedAt).toBe('string');

        const reclaimed = await adminAgent.post('/admin/grading/reclaim');
        expect(reclaimed.status).toBe(200);
        expect(reclaimed.body).toEqual({ reclaimed: 0, jobIds: [] });

        const plain = request.agent(app.getHttpServer());
        await registerAndLogin(plain, 'dash-plain');
        expect((await plain.get('/admin/dashboard')).status).toBe(403);
        expect((await plain.post('/admin/grading/reclaim')).status).toBe(403);

        // Anonymous never gets as far as the admin check.
        expect((await request(app.getHttpServer()).get('/admin/dashboard')).status).toBe(401);
        expect((await request(app.getHttpServer()).post('/admin/grading/reclaim')).status).toBe(401);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
