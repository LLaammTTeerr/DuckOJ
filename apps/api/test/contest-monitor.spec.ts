/**
 * F23 — the organiser live monitor (D95).
 *
 * Visibility comes before everything, exactly as `contest-similarity.spec.ts`
 * orders it: a contest the caller may not see 404s, one they may see but do
 * not run 403s, and only then is there a snapshot to assert on. After that,
 * the four claims the panel actually makes — the per-problem numbers, the
 * queue scoped to THIS contest, the feed's bound and its unfrozen verdicts,
 * and the two numbers that come from outside the contest (presence, D80
 * refusals).
 */
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  contestClarifications,
  contestParticipations,
  contestProblems,
  contestSubmissions,
  contests,
  problemRevisions,
  problems,
  submissions,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { CONTEST_PRESENCE, type ContestPresence } from '../src/realtime/contest-presence.js';
import { SCOREBOARD_CACHE_STORE } from '../src/authz/scoreboard.cache.js';
import type { ScoreboardCacheStore } from '../src/authz/scoreboard.cache.js';
import { REFUSAL_PREFIX } from '../src/common/rate-limiter.js';
import { SUBMISSION_PURPOSE } from '../src/authz/submission.access.js';
import { buildApp, type BuildAppOptions } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { insertUser, registerAndLogin, userIdOf } from './submissions.fixtures.js';

const MINUTE = 60 * 1000;

interface Seeded {
  contestId: number;
  ownerId: number;
  problemIds: number[];
  revisionIds: number[];
  contestProblemIds: number[];
  participationIds: Map<string, number>;
  languageId: number;
  submissionIds: number[];
}

/**
 * One contest, two problems, three competitors, and whatever submissions the
 * caller asks for.
 *
 * `endTime` is deliberately in the FUTURE and `frozenLastMinutes` is set, so
 * every assertion below runs inside a freeze window: D22 hands the people who
 * run a contest the live view, and a fixture that finished an hour ago would
 * have proved nothing about that.
 */
async function seedMonitorContest(
  db: Db,
  key: string,
  ownerId: number,
  opts: { visibility?: 'public' | 'private' } = {},
): Promise<Seeded> {
  const now = Date.now();
  const [language] = await db
    .insert(schema.languages)
    .values({ key: `${key}-cpp`, name: 'C++17', extension: 'cpp' })
    .returning({ id: schema.languages.id });

  await db.insert(schema.packages).values({ hash: `${key}-pkg`, sizeBytes: 1, fileCount: 1 });

  const problemIds: number[] = [];
  const revisionIds: number[] = [];
  for (const label of ['a', 'b']) {
    const [problem] = await db
      .insert(problems)
      .values({
        code: `${key}-${label}`,
        name: `Bài ${label.toUpperCase()}`,
        statement: 'Cho $a+b$.',
        visibility: 'public',
        createdBy: ownerId,
      })
      .returning({ id: problems.id });
    const [revision] = await db
      .insert(problemRevisions)
      .values({
        problemId: problem!.id,
        version: 1,
        packageHash: `${key}-pkg`,
        state: 'published',
        createdBy: ownerId,
        timeMs: 1000,
        memoryKb: 256_000,
        testCount: 5,
        totalPoints: 100,
        checkerKind: 'wcmp',
      })
      .returning({ id: problemRevisions.id });
    await db
      .update(problems)
      .set({ currentRevisionId: revision!.id })
      .where(eq(problems.id, problem!.id));
    problemIds.push(problem!.id);
    revisionIds.push(revision!.id);
  }

  const [contest] = await db
    .insert(contests)
    .values({
      key,
      name: 'Thi thử tỉnh',
      startTime: new Date(now - 60 * MINUTE),
      endTime: new Date(now + 60 * MINUTE),
      frozenLastMinutes: 120,
      format: 'icpc',
      visibility: opts.visibility ?? 'public',
      createdBy: ownerId,
    })
    .returning({ id: contests.id });

  const contestProblemIds: number[] = [];
  for (const [index, problemId] of problemIds.entries()) {
    const [row] = await db
      .insert(contestProblems)
      .values({
        contestId: contest!.id,
        problemId,
        label: index === 0 ? 'A' : 'B',
        points: 100,
        order: index,
      })
      .returning({ id: contestProblems.id });
    contestProblemIds.push(row!.id);
  }

  const participationIds = new Map<string, number>();
  for (const username of ['an', 'binh', 'cuong']) {
    const user = await insertUser(db, `${key}-${username}`);
    const [row] = await db
      .insert(contestParticipations)
      .values({
        contestId: contest!.id,
        userId: user.id,
        virtual: 0,
        startTime: new Date(now - 55 * MINUTE),
      })
      .returning({ id: contestParticipations.id });
    participationIds.set(username, row!.id);
  }

  return {
    contestId: contest!.id,
    ownerId,
    problemIds,
    revisionIds,
    contestProblemIds,
    participationIds,
    languageId: language!.id,
    submissionIds: [],
  };
}

/** One submission into the contest, optionally with a grading job still open. */
async function handIn(
  db: Db,
  key: string,
  seeded: Seeded,
  args: {
    username: string;
    problemIndex: number;
    state?: 'queued' | 'done';
    verdict?: 'AC' | 'WA' | null;
    queuedJob?: boolean;
    jobCreatedAt?: Date;
  },
): Promise<number> {
  const userId = await userIdOf(db, `${key}-${args.username}`);
  const [submission] = await db
    .insert(submissions)
    .values({
      userId,
      problemId: seeded.problemIds[args.problemIndex]!,
      revisionId: seeded.revisionIds[args.problemIndex]!,
      languageId: seeded.languageId,
      source: 'int main(){}',
      state: args.state ?? 'done',
      verdict: args.verdict ?? null,
      points: args.verdict === 'AC' ? 100 : 0,
      maxPoints: 100,
    })
    .returning({ id: submissions.id });
  await db.insert(contestSubmissions).values({
    participationId: seeded.participationIds.get(args.username)!,
    contestProblemId: seeded.contestProblemIds[args.problemIndex]!,
    submissionId: submission!.id,
  });
  if (args.queuedJob) {
    await db.insert(schema.gradingJobs).values({
      submissionId: submission!.id,
      revisionId: seeded.revisionIds[args.problemIndex]!,
      packageHash: `${key}-pkg`,
      state: 'queued',
      ...(args.jobCreatedAt ? { createdAt: args.jobCreatedAt } : {}),
    });
  }
  seeded.submissionIds.push(submission!.id);
  return submission!.id;
}

/** A presence store answering with exactly these user ids. */
function presenceOf(userIds: number[]): ContestPresence {
  return {
    seen: () => Promise.resolve(),
    recent: () => Promise.resolve(userIds),
  };
}

/** A `ScoreboardCacheStore` backed by a Map — the real read-through path. */
function memoryStore(): ScoreboardCacheStore {
  const entries = new Map<string, string>();
  return {
    get: (k) => Promise.resolve(entries.get(k) ?? null),
    set: (k, v) => {
      entries.set(k, v);
      return Promise.resolve();
    },
    del: (keys) => {
      for (const k of keys) entries.delete(k);
      return Promise.resolve();
    },
  };
}

function withPresence(userIds: number[]): BuildAppOptions {
  return { overrides: [{ provide: CONTEST_PRESENCE, useValue: presenceOf(userIds) }] };
}

describe('GET /contests/{key}/monitor — who may look (D95)', () => {
  it('refuses an anonymous caller with 401', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, withPresence([]));
      try {
        const owner = await insertUser(db, 'mon-anon-owner');
        await seedMonitorContest(db, 'monanon', owner.id);
        const res = await request(app.getHttpServer()).get('/contests/monanon/monitor');
        expect(res.status).toBe(401);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('404s a contest the caller may not see, and 403s one they may see but do not run', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, withPresence([]));
      try {
        const owner = await insertUser(db, 'mon-vis-owner');
        await seedMonitorContest(db, 'monhidden', owner.id, { visibility: 'private' });
        await seedMonitorContest(db, 'monshown', owner.id, { visibility: 'public' });

        const agent = request.agent(app.getHttpServer());
        const cookie = await registerAndLogin(agent, 'monoutsider');

        const hidden = await agent.get('/contests/monhidden/monitor').set('Cookie', cookie);
        expect(hidden.status).toBe(404);
        expect(hidden.body.code).toBe('contest_not_found');

        // Visible, and still not theirs to watch. 403 rather than 404 is the
        // similarity report's shape: the caller has already reached the
        // contest, so its existence is theirs to know.
        const shown = await agent.get('/contests/monshown/monitor').set('Cookie', cookie);
        expect(shown.status).toBe(403);
        expect(shown.body.code).toBe('contest_forbidden');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('serves the contest’s creator, and a global admin who did not create it', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, withPresence([]));
      try {
        const agent = request.agent(app.getHttpServer());
        const ownerCookie = await registerAndLogin(agent, 'monowner');
        const ownerId = await userIdOf(db, 'monowner');
        await seedMonitorContest(db, 'monboth', ownerId);

        const mine = await agent.get('/contests/monboth/monitor').set('Cookie', ownerCookie);
        expect(mine.status).toBe(200);

        const adminAgent = request.agent(app.getHttpServer());
        const adminCookie = await registerAndLogin(adminAgent, 'monadmin');
        await db
          .update(schema.users)
          .set({ globalRole: 'admin' })
          .where(eq(schema.users.username, 'monadmin'));
        const theirs = await adminAgent.get('/contests/monboth/monitor').set('Cookie', adminCookie);
        expect(theirs.status).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('GET /contests/{key}/monitor — what it shows (D95)', () => {
  it('counts attempts, accepted attempts and DISTINCT solvers per problem, and lists an untouched problem as zeros', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, withPresence([]));
      try {
        const agent = request.agent(app.getHttpServer());
        const cookie = await registerAndLogin(agent, 'moncounts');
        const ownerId = await userIdOf(db, 'moncounts');
        const seeded = await seedMonitorContest(db, 'moncounts', ownerId);

        // Problem A: an solves it on their second try, binh solves it once,
        // cuong never does. Four attempts, three accepted rows across two
        // people — `submitted` and `solvers` must not be the same number.
        await handIn(db, 'moncounts', seeded, { username: 'an', problemIndex: 0, verdict: 'WA' });
        await handIn(db, 'moncounts', seeded, { username: 'an', problemIndex: 0, verdict: 'AC' });
        await handIn(db, 'moncounts', seeded, { username: 'an', problemIndex: 0, verdict: 'AC' });
        await handIn(db, 'moncounts', seeded, { username: 'binh', problemIndex: 0, verdict: 'AC' });
        await handIn(db, 'moncounts', seeded, { username: 'cuong', problemIndex: 0, verdict: 'WA' });

        const res = await agent.get('/contests/moncounts/monitor').set('Cookie', cookie);
        expect(res.status).toBe(200);
        expect(res.body.problems).toHaveLength(2);
        expect(res.body.problems[0]).toMatchObject({
          code: 'moncounts-a',
          label: 'A',
          submitted: 5,
          accepted: 3,
          solvers: 2,
          pending: 0,
        });
        // Problem B is in the contest and nobody has touched it: a row of
        // zeros, never an absence, or the table renumbers itself the first
        // time somebody submits.
        expect(res.body.problems[1]).toMatchObject({
          code: 'moncounts-b',
          submitted: 0,
          accepted: 0,
          solvers: 0,
          pending: 0,
        });
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('scopes the queue to this contest, ages the oldest job, and reports null for an empty queue', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, withPresence([]));
      try {
        const agent = request.agent(app.getHttpServer());
        const cookie = await registerAndLogin(agent, 'monqueue');
        const ownerId = await userIdOf(db, 'monqueue');
        const watched = await seedMonitorContest(db, 'monqueue', ownerId);
        const other = await seedMonitorContest(db, 'monother', ownerId);

        const empty = await agent.get('/contests/monqueue/monitor').set('Cookie', cookie);
        expect(empty.body.queue).toEqual({ depth: 0, oldestPendingSeconds: null });

        await handIn(db, 'monqueue', watched, {
          username: 'an',
          problemIndex: 0,
          state: 'queued',
          queuedJob: true,
          jobCreatedAt: new Date(Date.now() - 5 * MINUTE),
        });
        await handIn(db, 'monqueue', watched, {
          username: 'binh',
          problemIndex: 0,
          state: 'queued',
          queuedJob: true,
        });
        // Another contest's backlog, which must not appear in this one's.
        await handIn(db, 'monother', other, {
          username: 'an',
          problemIndex: 0,
          state: 'queued',
          queuedJob: true,
        });

        const res = await agent.get('/contests/monqueue/monitor').set('Cookie', cookie);
        expect(res.body.queue.depth).toBe(2);
        expect(res.body.queue.oldestPendingSeconds).toBeGreaterThanOrEqual(290);
        expect(res.body.problems[0].pending).toBe(2);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('feeds the newest fifty, newest first, with real verdicts inside a freeze window', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, withPresence([]));
      try {
        const agent = request.agent(app.getHttpServer());
        const cookie = await registerAndLogin(agent, 'monfeed');
        const ownerId = await userIdOf(db, 'monfeed');
        const seeded = await seedMonitorContest(db, 'monfeed', ownerId);

        // Alternating between the two problems, deliberately: the feed's
        // outer `order by` only does any work when the per-problem laterals
        // it merges have interleaved ids, and a fixture that submitted to one
        // problem would pass with no outer ordering at all.
        // 120 rather than 55: with fewer than fifty per problem the lateral's
        // own `limit` never bites, and a fixture that cannot make it bite
        // cannot tell a top-50-per-problem from a read-everything.
        for (let i = 0; i < 120; i += 1) {
          await handIn(db, 'monfeed', seeded, {
            username: 'an',
            problemIndex: i % 2,
            verdict: i % 2 === 0 ? 'AC' : 'WA',
          });
        }
        const newest = seeded.submissionIds.at(-1)!;

        const res = await agent.get('/contests/monfeed/monitor').set('Cookie', cookie);
        expect(res.body.feed).toHaveLength(50);
        expect(res.body.feed[0]).toMatchObject({
          submissionId: newest,
          username: 'monfeed-an',
          // i = 119 is odd, so the newest went to problem B.
          problemCode: 'monfeed-b',
          problemLabel: 'B',
          state: 'done',
        });
        // The fixture's contest is INSIDE its own freeze window. D22 gives the
        // people who run a contest the live view, so the verdicts are real —
        // nulls here would mean the mask had leaked into the one screen that
        // exists to see through it.
        expect(res.body.feed[0].verdict).toBe('WA');
        expect(res.body.feed.every((row: { verdict: string | null }) => row.verdict !== null)).toBe(
          true,
        );
        // Newest first, strictly.
        const ids = res.body.feed.map((row: { submissionId: number }) => row.submissionId);
        expect([...ids].sort((a: number, b: number) => b - a)).toEqual(ids);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('counts the questions nobody has answered, lists the newest five of them, and ignores announcements', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, withPresence([]));
      try {
        const agent = request.agent(app.getHttpServer());
        const cookie = await registerAndLogin(agent, 'monqa');
        const ownerId = await userIdOf(db, 'monqa');
        const seeded = await seedMonitorContest(db, 'monqa', ownerId);
        const asker = await userIdOf(db, 'monqa-an');

        for (let i = 0; i < 7; i += 1) {
          await db.insert(contestClarifications).values({
            contestId: seeded.contestId,
            askedBy: asker,
            question: `Câu hỏi ${String(i)}`,
            visibility: 'private',
          });
        }
        // An answered question and an announcement (D31: same table, no
        // question) — neither is work anybody still owes.
        await db.insert(contestClarifications).values({
          contestId: seeded.contestId,
          askedBy: asker,
          question: 'Đã trả lời',
          answer: 'Rồi',
          answeredBy: ownerId,
          answeredAt: new Date(),
          visibility: 'public',
        });
        await db.insert(contestClarifications).values({
          contestId: seeded.contestId,
          askedBy: ownerId,
          answer: 'Thông báo chung',
          visibility: 'public',
        });

        const res = await agent.get('/contests/monqa/monitor').set('Cookie', cookie);
        expect(res.body.clarifications.unanswered).toBe(7);
        expect(res.body.clarifications.latest).toHaveLength(5);
        expect(res.body.clarifications.latest[0]).toMatchObject({
          question: 'Câu hỏi 6',
          askedBy: 'monqa-an',
          problemCode: null,
        });
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('counts a judge as online only while it has been heard from, and the D80 refusals of the last ten minutes', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, withPresence([]));
      try {
        const agent = request.agent(app.getHttpServer());
        const cookie = await registerAndLogin(agent, 'monjudge');
        const ownerId = await userIdOf(db, 'monjudge');
        await seedMonitorContest(db, 'monjudge', ownerId);

        await db.insert(schema.judgeNodes).values([
          { name: 'live', tokenHash: 'mon-h1', driver: 'dmoj', lastSeen: new Date() },
          {
            name: 'silent',
            tokenHash: 'mon-h2',
            driver: 'dmoj',
            lastSeen: new Date(Date.now() - 10 * MINUTE),
          },
          { name: 'never', tokenHash: 'mon-h3', driver: 'dmoj', lastSeen: null },
        ]);

        await db.insert(schema.rateEvents).values([
          { purpose: `${REFUSAL_PREFIX}${SUBMISSION_PURPOSE}`, key: 'user:1' },
          { purpose: `${REFUSAL_PREFIX}${SUBMISSION_PURPOSE}`, key: 'user:2' },
          // An admitted attempt, and a refusal of something else. Neither is
          // a submission the limiter turned away.
          { purpose: SUBMISSION_PURPOSE, key: 'user:3' },
          { purpose: `${REFUSAL_PREFIX}login`, key: 'user:4' },
        ]);

        const res = await agent.get('/contests/monjudge/monitor').set('Cookie', cookie);
        expect(res.body.judges).toEqual({ total: 3, online: 1 });
        expect(res.body.submitRefusalsLast10Min).toBe(2);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('counts only connected users who actually hold a participation in THIS contest', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        const cookie = await registerAndLogin(agent, 'monwho');
        const ownerId = await userIdOf(db, 'monwho');
        await seedMonitorContest(db, 'monwho', ownerId);
        const an = await userIdOf(db, 'monwho-an');
        const binh = await userIdOf(db, 'monwho-binh');
        // A competitor of a DIFFERENT contest, connected at the same moment.
        // Without them the count could be unscoped and still answer 0 for
        // everybody who holds no participation anywhere.
        await seedMonitorContest(db, 'monwhoelse', ownerId);
        const elsewhere = await userIdOf(db, 'monwhoelse-an');

        // Rebuilt per case rather than parameterised: the presence store is a
        // constructor dependency, and the point of the test is what a
        // DIFFERENT set of connected users produces.
        for (const [connected, expected] of [
          [[], 0],
          [[an], 1],
          [[an, an], 1],
          [[an, binh], 2],
          // Connected, but competing in nothing here — the organiser
          // themselves, a stray id, and somebody sitting a different contest.
          [[ownerId, 999_999], 0],
          [[elsewhere], 0],
          [[an, elsewhere], 1],
        ] as const) {
          const scoped = await buildApp(db, withPresence([...connected]));
          try {
            // The session lives in the database both apps share, so the
            // organiser's cookie authenticates against either one.
            const res = await request(scoped.getHttpServer())
              .get('/contests/monwho/monitor')
              .set('Cookie', cookie);
            expect(res.body.participantsOnline).toBe(expected);
          } finally {
            await scoped.close();
          }
        }
      } finally {
        await app.close();
      }
    });
  }, 240_000);
});

describe('the monitor cache (D95)', () => {
  it('serves the same snapshot for the whole TTL, and folds again once it is gone', async () => {
    await withTestDb(async (db) => {
      const store = memoryStore();
      const app = await buildApp(db, {
        overrides: [
          { provide: SCOREBOARD_CACHE_STORE, useValue: store },
          { provide: CONTEST_PRESENCE, useValue: presenceOf([]) },
        ],
      });
      try {
        const agent = request.agent(app.getHttpServer());
        const cookie = await registerAndLogin(agent, 'moncache');
        const ownerId = await userIdOf(db, 'moncache');
        const seeded = await seedMonitorContest(db, 'moncache', ownerId);

        const first = await agent.get('/contests/moncache/monitor').set('Cookie', cookie);
        expect(first.body.problems[0].submitted).toBe(0);

        // A submission the cache must NOT show yet: `generatedAt` proves the
        // second response is the first one, byte for byte, rather than a
        // fresh fold that happened to agree.
        await handIn(db, 'moncache', seeded, { username: 'an', problemIndex: 0, verdict: 'AC' });
        const second = await agent.get('/contests/moncache/monitor').set('Cookie', cookie);
        expect(second.body.generatedAt).toBe(first.body.generatedAt);
        expect(second.body.problems[0].submitted).toBe(0);

        // Dropping the entry is what a TTL does, without waiting five seconds
        // for it.
        await store.del([`duckoj:monitor:v1:${String(seeded.contestId)}`]);
        const third = await agent.get('/contests/moncache/monitor').set('Cookie', cookie);
        expect(third.body.generatedAt).not.toBe(first.body.generatedAt);
        expect(third.body.problems[0].submitted).toBe(1);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
