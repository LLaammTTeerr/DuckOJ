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
import { TEST_CONFIG } from './app.harness.js';
import type { AppConfig } from '../src/config/config.schema.js';
import type { Mailer } from '../src/mail/mailer.js';
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

/**
 * F-40 — the mail panel reports CONFIGURATION, and opens no connection, so a
 * transport that does nothing is a complete stand-in for every case except
 * `sendTestMail`, which has its own fixtures below.
 */
const NO_MAIL: Mailer = { kind: 'log', send: () => Promise.resolve() };

/** The service under test, with the two dependencies these panels ignore. */
function dashboard(
  db: Db,
  redis: RedisHealth = UP,
  config: AppConfig = TEST_CONFIG,
  mailer: Mailer = NO_MAIL,
): DashboardService {
  return new DashboardService(db, redis, config, mailer);
}

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
    judgeNodeId?: number;
    blockedReason?: string;
  },
): Promise<number> {
  const [revision] = await db
    .select({ id: problemRevisions.id, hash: problemRevisions.packageHash })
    .from(problemRevisions)
    .limit(1);
  const rows = await db.execute<{ id: number }>(sql`
    insert into grading_jobs (revision_id, package_hash, state, worker_id, lease_until, submission_id, created_at,
                              judge_node_id, blocked_reason)
    values (${revision!.id}, ${revision!.hash}, ${opts.state}, ${opts.workerId ?? null},
            ${opts.leaseSeconds === undefined ? null : sql`now() + make_interval(secs => ${opts.leaseSeconds}::double precision)`},
            ${opts.submissionId ?? null},
            now() - make_interval(secs => ${opts.ageSeconds ?? 0}::double precision),
            ${opts.judgeNodeId ?? null}, ${opts.blockedReason ?? null})
    returning id
  `);
  return Number(rows[0]!.id);
}

/** A `judge_nodes` row; the hash only has to be unique and hex-shaped. */
async function seedNode(db: Db, name: string, hashChar: string): Promise<number> {
  const [node] = await db
    .insert(schema.judgeNodes)
    .values({ name, tokenHash: hashChar.repeat(64), driver: 'dmoj' })
    .returning({ id: schema.judgeNodes.id });
  return node!.id;
}

async function seedProblemAndUser(db: Db): Promise<{ userId: number; problemId: number }> {
  await seedProblemAndLanguage(db);
  const user = await insertUser(db, 'dash-user');
  const [problem] = await db
    .select({ id: problems.id })
    .from(problems)
    .where(eq(problems.code, 'aplusb'));
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

      const { queue } = await dashboard(db).snapshot(admin());
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
      const { queue } = await dashboard(db).snapshot(admin());
      expect(queue.oldestQueuedSeconds).toBeNull();
      expect(queue.queued).toBe(0);
    });
  }, 120_000);
});

describe('GET /admin/dashboard — the judge panel', () => {
  it("calls a judge offline once it has been silent past the bridge's own limit", async () => {
    await withTestDb(async (db) => {
      await db.insert(schema.judgeNodes).values([
        { name: 'judge-live', tokenHash: 'a'.repeat(64), driver: 'dmoj' },
        { name: 'judge-stale', tokenHash: 'b'.repeat(64), driver: 'dmoj' },
        { name: 'judge-never', tokenHash: 'c'.repeat(64), driver: 'dmoj' },
      ]);
      await db.execute(
        sql`update judge_nodes set last_seen = now() - interval '10 seconds' where name = 'judge-live'`,
      );
      await db.execute(
        sql`update judge_nodes set last_seen = now() - interval '200 seconds' where name = 'judge-stale'`,
      );

      const { judges } = await dashboard(db).snapshot(admin());
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

/**
 * F11 wrote `grading_jobs.judge_node_id` (migration 0027, D68) and nothing
 * read it: the dashboard could say a queue was deep and a fleet was up, but
 * not WHICH machine was carrying the contest — the question a second judge
 * exists to make askable. The two counts here are the per-node twins of the
 * worker panel's: what it is grading now, and what it finished this hour.
 *
 * The judge panel is where they belong rather than the worker panel, because
 * a judge and a worker are still different things (D47): one is a machine
 * that grades, the other one of judged's claim loops. 0027 joined jobs to
 * the MACHINE, so the machine's row is where its throughput goes.
 */
describe('GET /admin/dashboard — what each judge is carrying (D68, 0027)', () => {
  it("counts a node's live grades and its last hour, per node", async () => {
    await withTestDb(async (db) => {
      const { userId, problemId } = await seedProblemAndUser(db);
      const one = await seedNode(db, 'judge-1', 'a');
      const two = await seedNode(db, 'judge-2', 'b');

      const live = await insertGradedSubmission(db, { userId, problemId });
      const recent = await insertGradedSubmission(db, {
        userId,
        problemId,
        verdict: 'AC',
        points: 100,
        maxPoints: 100,
      });
      const old = await insertGradedSubmission(db, {
        userId,
        problemId,
        verdict: 'AC',
        points: 100,
        maxPoints: 100,
      });
      await db
        .update(submissions)
        .set({ judgedAt: sql`now() - interval '5 minutes'` })
        .where(eq(submissions.id, recent));
      await db
        .update(submissions)
        .set({ judgedAt: sql`now() - interval '61 minutes'` })
        .where(eq(submissions.id, old));

      // judge-1: one grade in flight, one finished inside the hour, one
      // outside it. The last is the row that proves the window is real.
      await seedJob(db, {
        state: 'leased',
        leaseSeconds: 45,
        workerId: 'w#1',
        submissionId: live,
        judgeNodeId: one,
      });
      await seedJob(db, { state: 'done', workerId: 'w#1', submissionId: recent, judgeNodeId: one });
      await seedJob(db, { state: 'done', workerId: 'w#1', submissionId: old, judgeNodeId: one });
      // judge-2 holds a LAPSED lease: the node is not grading it any more,
      // whatever the row says — the same reading the worker panel takes.
      await seedJob(db, {
        state: 'leased',
        leaseSeconds: -1,
        workerId: 'w#2',
        submissionId: live,
        judgeNodeId: two,
      });

      const { judges } = await dashboard(db).snapshot(admin());
      expect(judges.map((j) => [j.name, j.gradingNow, j.gradedLastHour])).toEqual([
        ['judge-1', 1, 1],
        ['judge-2', 0, 0],
      ]);
    });
  }, 120_000);

  /**
   * F-39. `judge_nodes.capabilities` had been written by the bridge on every
   * handshake since D68 and read by nothing, so this panel could show that a
   * judge was online and idle while a queue full of Python submissions waited
   * for an executor it had never announced — which is the shape of the bug
   * that cost this deployment two weeks.
   */
  it('shows the executors a judge announced, and says so when it announced none', async () => {
    await withTestDb(async (db) => {
      await seedNode(db, 'judge-announced', 'a');
      await seedNode(db, 'judge-silent', 'b');
      await db
        .update(schema.judgeNodes)
        .set({ capabilities: { executors: ['PY3', 'CPP17'], languages: ['python3', 'cpp17'] } })
        .where(eq(schema.judgeNodes.name, 'judge-announced'));

      const { judges } = await dashboard(db).snapshot(admin());

      // Sorted, so two judges announcing the same set read the same.
      expect(judges.find((j) => j.name === 'judge-announced')?.executors).toEqual(['CPP17', 'PY3']);
      // `[]` for a judge that has never handshaken — "announced nothing",
      // which is not the same claim as "can run nothing", and is why the web
      // renders it as a word rather than as an empty cell.
      expect(judges.find((j) => j.name === 'judge-silent')?.executors).toEqual([]);
    });
  }, 120_000);

  it('survives a capabilities column that is not the shape it expects', async () => {
    await withTestDb(async (db) => {
      await seedNode(db, 'judge-odd', 'a');
      // `capabilities` is unconstrained jsonb written by whatever driver
      // connected. A dashboard that 500s because one judge announced
      // something strange is worse than one that reports nothing for it.
      await db
        .update(schema.judgeNodes)
        .set({ capabilities: { executors: 'CPP17' } })
        .where(eq(schema.judgeNodes.name, 'judge-odd'));

      const { judges } = await dashboard(db).snapshot(admin());

      expect(judges[0]?.executors).toEqual([]);
    });
  }, 120_000);

  it('leaves a job no driver could name off every node rather than guessing one', async () => {
    await withTestDb(async (db) => {
      const { userId, problemId } = await seedProblemAndUser(db);
      await seedNode(db, 'judge-1', 'a');
      const live = await insertGradedSubmission(db, { userId, problemId });
      // `judge_node_id` is null for every in-process driver (D68). A count
      // that quietly attributed those to the one node on the fleet would be
      // worse than no count at all.
      await seedJob(db, { state: 'leased', leaseSeconds: 45, workerId: 'w#1', submissionId: live });

      const { judges } = await dashboard(db).snapshot(admin());
      expect(judges).toHaveLength(1);
      expect(judges[0]).toMatchObject({ name: 'judge-1', gradingNow: 0, gradedLastHour: 0 });
    });
  }, 120_000);
});

/**
 * `blocked_reason` (D68) is a nullable text column on a job that is still
 * `queued` — "nobody connected can run this language". Until now the only
 * way to read it was psql: the dashboard showed a queue that would not move
 * and no reason, which is precisely the shape an operator cannot diagnose.
 */
describe('GET /admin/dashboard — blocked jobs (D68)', () => {
  it('counts queued jobs by the reason they are stuck, busiest first', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      await seedJob(db, {
        state: 'queued',
        blockedReason: 'no connected judge supports language py3',
      });
      await seedJob(db, {
        state: 'queued',
        blockedReason: 'no connected judge supports language py3',
      });
      await seedJob(db, {
        state: 'queued',
        blockedReason: 'no connected judge supports language java',
      });
      // Queued for ordinary reasons — waiting is not being blocked.
      await seedJob(db, { state: 'queued' });
      // A blocked job that has since been claimed is no longer blocked; the
      // claim clears the reason, and a stale row must not be counted.
      await seedJob(db, {
        state: 'leased',
        leaseSeconds: 60,
        blockedReason: 'no connected judge supports language py3',
      });

      const { blockedJobs, queue } = await dashboard(db).snapshot(admin());
      expect(blockedJobs).toEqual([
        { reason: 'no connected judge supports language py3', count: 2 },
        { reason: 'no connected judge supports language java', count: 1 },
      ]);
      // Blocked is a REASON on a queued job, not a state of its own: the
      // queue count still carries all four.
      expect(queue.queued).toBe(4);
    });
  }, 120_000);

  it('reports nothing blocked as an empty list, not as a null reason', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      await seedJob(db, { state: 'queued' });
      const { blockedJobs } = await dashboard(db).snapshot(admin());
      expect(blockedJobs).toEqual([]);
    });
  }, 120_000);
});

describe('GET /admin/dashboard — the worker panel', () => {
  it('names the submission a worker holds a live lease on, and counts its last hour', async () => {
    await withTestDb(async (db) => {
      const { userId, problemId } = await seedProblemAndUser(db);
      const live = await insertGradedSubmission(db, { userId, problemId });
      const recent = await insertGradedSubmission(db, {
        userId,
        problemId,
        verdict: 'AC',
        points: 100,
        maxPoints: 100,
      });
      const recentIe = await insertGradedSubmission(db, { userId, problemId, verdict: 'IE' });
      const old = await insertGradedSubmission(db, {
        userId,
        problemId,
        verdict: 'AC',
        points: 100,
        maxPoints: 100,
      });
      await db
        .update(submissions)
        .set({ judgedAt: sql`now() - interval '5 minutes'` })
        .where(eq(submissions.id, recent));
      await db
        .update(submissions)
        .set({ judgedAt: sql`now() - interval '5 minutes'` })
        .where(eq(submissions.id, recentIe));
      // Just outside the window — the one row that proves the window exists.
      await db
        .update(submissions)
        .set({ judgedAt: sql`now() - interval '61 minutes'` })
        .where(eq(submissions.id, old));

      const jobId = await seedJob(db, {
        state: 'leased',
        leaseSeconds: 45,
        workerId: 'judged-1#1',
        submissionId: live,
      });
      await seedJob(db, { state: 'done', workerId: 'judged-1#1', submissionId: recent });
      await seedJob(db, { state: 'done', workerId: 'judged-1#1', submissionId: recentIe });
      await seedJob(db, { state: 'done', workerId: 'judged-1#1', submissionId: old });
      // A second worker with an EXPIRED lease holds nothing: the panel says
      // what is being graded now, not what was claimed once.
      await seedJob(db, {
        state: 'leased',
        leaseSeconds: -1,
        workerId: 'judged-1#2',
        submissionId: live,
      });

      const { workers } = await dashboard(db).snapshot(admin());
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
      const graded = await insertGradedSubmission(db, {
        userId,
        problemId,
        verdict: 'AC',
        points: 100,
        maxPoints: 100,
      });
      await db
        .update(submissions)
        .set({ judgedAt: sql`now() - interval '5 minutes'` })
        .where(eq(submissions.id, graded));
      await seedJob(db, { state: 'done', workerId: 'judged-2#1', submissionId: graded });

      const { workers } = await dashboard(db).snapshot(admin());
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
      await insertGradedSubmission(db, {
        userId,
        problemId,
        verdict: 'AC',
        points: 100,
        maxPoints: 100,
      });
      // A WA is the system working, not a failure.
      await db.insert(submissions).values({
        userId,
        problemId,
        revisionId: (
          await db
            .select({ id: problems.currentRevisionId })
            .from(problems)
            .where(eq(problems.id, problemId))
        )[0]!.id!,
        languageId: (await db.select({ id: schema.languages.id }).from(schema.languages))[0]!.id,
        source: 'wa',
        state: 'done',
        verdict: 'WA',
        points: 0,
        maxPoints: 100,
      });
      const firstIe = await insertGradedSubmission(db, { userId, problemId, verdict: 'IE' });
      const secondIe = await insertGradedSubmission(db, { userId, problemId, verdict: 'IE' });

      const { recentFailures } = await dashboard(db).snapshot(admin());
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
      const { recentFailures } = await dashboard(db).snapshot(admin());
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

      const { refusalsLastHour } = await dashboard(db, DOWN).snapshot(admin());
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
      const { refusalsLastHour } = await dashboard(db, DOWN).snapshot(admin());
      expect(refusalsLastHour).toEqual([]);
    });
  }, 120_000);
});

describe('GET /admin/dashboard — dependencies and runtime', () => {
  it('reports Redis as it found it, and the API worker count in effect', async () => {
    await withTestDb(async (db) => {
      const down = await dashboard(db, DOWN).snapshot(admin());
      expect(down.dependencies).toEqual({ database: 'up', redis: 'down' });
      const up = await dashboard(db).snapshot(admin());
      expect(up.dependencies.redis).toBe('up');
      expect(up.runtime.apiWorkers).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(up.runtime.apiWorkers)).toBe(true);
    });
  }, 120_000);

  it("admits it does not know judged's concurrency rather than guessing one", async () => {
    await withTestDb(async (db) => {
      const previous = process.env.JUDGED_CONCURRENCY;
      try {
        delete process.env.JUDGED_CONCURRENCY;
        expect(
          (await dashboard(db).snapshot(admin())).runtime.judgedConcurrency,
        ).toBeNull();
        process.env.JUDGED_CONCURRENCY = '3';
        expect(
          (await dashboard(db).snapshot(admin())).runtime.judgedConcurrency,
        ).toBe(3);
        // Garbage is "not told", not a 500: this knob does not govern the
        // process reading it.
        process.env.JUDGED_CONCURRENCY = 'lots';
        expect(
          (await dashboard(db).snapshot(admin())).runtime.judgedConcurrency,
        ).toBeNull();
      } finally {
        if (previous === undefined) delete process.env.JUDGED_CONCURRENCY;
        else process.env.JUDGED_CONCURRENCY = previous;
      }
    });
  }, 120_000);
});

describe('GET /admin/dashboard — the mail panel (F-40)', () => {
  const configured: AppConfig = {
    ...TEST_CONFIG,
    smtp: { host: 'smtp.resend.com', port: 465, secure: true, user: 'resend', password: 're_abc' },
    mailFrom: 'Tỉnh OJ <oj@so-gd.example>',
  };

  it('says plainly that an unconfigured deployment delivers nothing', async () => {
    await withTestDb(async (db) => {
      // TEST_CONFIG has no SMTP host — the shape of every stack this campaign
      // has deployed, and the one the province was being asked to trust.
      const { mail } = await dashboard(db).snapshot(admin());
      expect(mail).toEqual({
        transport: 'log',
        configured: false,
        host: null,
        port: null,
        secure: false,
        authenticated: false,
        from: TEST_CONFIG.mailFrom,
      });
    });
  }, 120_000);

  it('reports the host, port and TLS an operator set, so they can check them', async () => {
    await withTestDb(async (db) => {
      const smtp: Mailer = { kind: 'smtp', send: () => Promise.resolve() };
      const { mail } = await dashboard(db, UP, configured, smtp).snapshot(admin());
      expect(mail).toEqual({
        transport: 'smtp',
        configured: true,
        host: 'smtp.resend.com',
        port: 465,
        secure: true,
        authenticated: true,
        from: 'Tỉnh OJ <oj@so-gd.example>',
      });
    });
  }, 120_000);

  it('never carries the password anywhere in the response', async () => {
    await withTestDb(async (db) => {
      const smtp: Mailer = { kind: 'smtp', send: () => Promise.resolve() };
      const snapshot = await dashboard(db, UP, configured, smtp).snapshot(admin());
      // The whole response, not just the panel: a secret that leaked into
      // some other field would still be a secret on an admin's screen and in
      // their browser cache.
      expect(JSON.stringify(snapshot)).not.toContain('re_abc');
    });
  }, 120_000);

  it('opens no connection while polling — the panel is configuration only', async () => {
    await withTestDb(async (db) => {
      // A transport that throws if anything asks it to send. The dashboard
      // refreshes every 15 seconds; a panel that dialled would be traffic
      // against somebody else's relay four times a minute.
      const explodes: Mailer = {
        kind: 'smtp',
        send: () => {
          throw new Error('the dashboard poll opened an SMTP connection');
        },
      };
      await expect(
        dashboard(db, UP, configured, explodes).snapshot(admin()),
      ).resolves.toBeDefined();
    });
  }, 120_000);
});

describe('POST /admin/grading/reclaim', () => {
  it('requeues only the lapsed leases, and a second call finds nothing', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const lapsed = await seedJob(db, {
        state: 'leased',
        leaseSeconds: -30,
        workerId: 'judged-1#1',
      });
      await seedJob(db, { state: 'leased', leaseSeconds: 30, workerId: 'judged-1#2' });
      const service = dashboard(db);

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
      const service = dashboard(db);
      await expect(service.reclaimLeases(plainUser())).rejects.toMatchObject({
        code: 'admin_forbidden',
      });
      await expect(service.snapshot(plainUser())).rejects.toMatchObject({
        code: 'admin_forbidden',
      });
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
        await db
          .update(schema.users)
          .set({ globalRole: 'admin' })
          .where(eq(schema.users.username, 'dash-admin'));

        const res = await adminAgent.get('/api/v1/admin/dashboard');
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

        const reclaimed = await adminAgent.post('/api/v1/admin/grading/reclaim');
        expect(reclaimed.status).toBe(200);
        expect(reclaimed.body).toEqual({ reclaimed: 0, jobIds: [] });

        // F-40 — the mail panel travels with the rest of the snapshot, and
        // this app is built from TEST_CONFIG, which configures no SMTP.
        expect(res.body.mail).toEqual({
          transport: 'log',
          configured: false,
          host: null,
          port: null,
          secure: false,
          authenticated: false,
          from: TEST_CONFIG.mailFrom,
        });

        // D156 — and the test-mail action refuses honestly on that same
        // deployment: there is no transport to test, so 503 rather than a
        // button that reports success against a log line.
        const mailTest = await adminAgent
          .post('/api/v1/admin/mail/test')
          .send({ to: 'quantri@so-gd.example' });
        expect(mailTest.status).toBe(503);
        expect(mailTest.body.code).toBe('mail_unavailable');

        // A malformed address is refused by the pipe, before any of that.
        const badAddress = await adminAgent
          .post('/api/v1/admin/mail/test')
          .send({ to: 'not-an-address' });
        expect(badAddress.status).toBe(422);

        const plain = request.agent(app.getHttpServer());
        await registerAndLogin(plain, 'dash-plain');
        expect((await plain.get('/api/v1/admin/dashboard')).status).toBe(403);
        expect((await plain.post('/api/v1/admin/grading/reclaim')).status).toBe(403);
        expect(
          (await plain.post('/api/v1/admin/mail/test').send({ to: 'a@b.example' })).status,
        ).toBe(403);

        // Anonymous never gets as far as the admin check.
        expect((await request(app.getHttpServer()).get('/api/v1/admin/dashboard')).status).toBe(
          401,
        );
        expect(
          (await request(app.getHttpServer()).post('/api/v1/admin/grading/reclaim')).status,
        ).toBe(401);
        expect(
          (
            await request(app.getHttpServer())
              .post('/api/v1/admin/mail/test')
              .send({ to: 'a@b.example' })
          ).status,
        ).toBe(401);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
