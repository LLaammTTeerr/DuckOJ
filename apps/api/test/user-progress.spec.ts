/**
 * F16 part B — the student progress page (D83).
 *
 * Three layers, in `contest-similarity.spec.ts`'s order: the one pure
 * decision (what a streak is), then the aggregates over a real database,
 * then the two routes — where what must NOT appear is the half that matters.
 * A private problem's tag on a public profile and a live contest's AC in
 * anybody's bars are the two leaks this feature could have had.
 */
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  contestParticipations,
  contestProblems,
  contestSubmissions,
  contests,
  orgMembers,
  organizations,
  problemRevisions,
  problemSetItems,
  problemSets,
  problemTags,
  problems,
  submissions,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import {
  ProgressService,
  addDays,
  resolveTimeZone,
  streakOf,
  todayIn,
} from '../src/authz/progress.access.js';
import type { Actor } from '../src/authz/actor.js';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { insertUser, registerAndLogin, userIdOf } from './submissions.fixtures.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/* ------------------------------------------------------------ the streak */

describe('streakOf (D83)', () => {
  it('counts the run that ends today', () => {
    expect(streakOf(['2026-08-28', '2026-08-29', '2026-08-30'], '2026-08-30')).toEqual({
      current: 3,
      longest: 3,
      lastDate: '2026-08-30',
    });
  });

  it('keeps a streak alive when the last AC was yesterday', () => {
    // Nobody has submitted yet today, and a streak that died at midnight
    // would punish every reader before their first submission of the day.
    expect(streakOf(['2026-08-28', '2026-08-29'], '2026-08-30').current).toBe(2);
  });

  it('drops to zero once a day is missed, keeping the longest run', () => {
    const streak = streakOf(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-20'], '2026-08-30');
    expect(streak.current).toBe(0);
    expect(streak.longest).toBe(3);
    expect(streak.lastDate).toBe('2026-08-20');
  });

  it('breaks a run on a single missing day', () => {
    expect(streakOf(['2026-08-28', '2026-08-30'], '2026-08-30')).toEqual({
      current: 1,
      longest: 1,
      lastDate: '2026-08-30',
    });
  });

  it('says nothing rather than zero about somebody who has never solved anything', () => {
    expect(streakOf([], '2026-08-30')).toEqual({ current: 0, longest: 0, lastDate: null });
  });

  it('crosses a month boundary', () => {
    expect(streakOf(['2026-07-31', '2026-08-01'], '2026-08-01').current).toBe(2);
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('the account zone (D57)', () => {
  it('falls back to ICT for an account that has chosen nothing', () => {
    expect(resolveTimeZone(null)).toBe('Asia/Ho_Chi_Minh');
    expect(resolveTimeZone('Europe/Paris')).toBe('Europe/Paris');
    // A value written before `UpdateMeRequest` validated the column must not
    // 500 somebody's own page.
    expect(resolveTimeZone('Nowhere/Fake')).toBe('Asia/Ho_Chi_Minh');
  });

  it('reads a late-evening UTC instant as the next day in Vietnam', () => {
    const at = new Date('2026-08-30T20:00:00Z');
    expect(todayIn('Asia/Ho_Chi_Minh', at)).toBe('2026-08-31');
    expect(todayIn('UTC', at)).toBe('2026-08-30');
  });
});

/* ------------------------------------------------------------ the fixtures */

interface World {
  studentId: number;
  publicProblemId: number;
  privateProblemId: number;
  contestProblemId: number;
  unratedProblemId: number;
  languageId: number;
  revisionOf: Map<number, number>;
}

async function seedWorld(db: Db, prefix: string, student: string): Promise<World> {
  const [language] = await db
    .insert(schema.languages)
    .values({ key: `${prefix}-cpp17`, name: 'C++17', extension: 'cpp' })
    .returning({ id: schema.languages.id });
  await db.insert(schema.packages).values({ hash: `${prefix}-pkg`, sizeBytes: 1, fileCount: 1 });
  const owner = await insertUser(db, `${prefix}-owner`);
  const studentId = await userIdOf(db, student);

  const revisionOf = new Map<number, number>();
  async function makeProblem(
    code: string,
    visibility: 'public' | 'private',
    difficulty: number | null,
    tagSlugs: string[],
  ): Promise<number> {
    const [problem] = await db
      .insert(problems)
      .values({
        code: `${prefix}-${code}`,
        name: `Bài ${code}`,
        statement: 'Cho $a+b$.',
        visibility,
        difficulty,
        createdBy: owner.id,
      })
      .returning({ id: problems.id });
    const [revision] = await db
      .insert(problemRevisions)
      .values({
        problemId: problem!.id,
        version: 1,
        packageHash: `${prefix}-pkg`,
        state: 'published',
        createdBy: owner.id,
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
    revisionOf.set(problem!.id, revision!.id);
    for (const slug of tagSlugs) {
      const [tag] = await db
        .select({ id: schema.tags.id })
        .from(schema.tags)
        .where(eq(schema.tags.slug, slug));
      await db.insert(problemTags).values({ problemId: problem!.id, tagId: tag!.id });
    }
    return problem!.id;
  }

  return {
    studentId,
    languageId: language!.id,
    revisionOf,
    publicProblemId: await makeProblem('open', 'public', 3, ['quy-hoach-dong']),
    privateProblemId: await makeProblem('secret', 'private', 7, ['do-thi']),
    contestProblemId: await makeProblem('live', 'public', 5, ['cay']),
    unratedProblemId: await makeProblem('unrated', 'public', null, ['so-hoc']),
  };
}

async function handIn(
  db: Db,
  world: World,
  problemId: number,
  verdict: 'AC' | 'WA',
  createdAt: Date,
): Promise<number> {
  const [row] = await db
    .insert(submissions)
    .values({
      userId: world.studentId,
      problemId,
      revisionId: world.revisionOf.get(problemId)!,
      languageId: world.languageId,
      source: 'int main(){}',
      state: 'done',
      verdict,
      points: verdict === 'AC' ? 100 : 0,
      maxPoints: 100,
      createdAt,
    })
    .returning({ id: submissions.id });
  return row!.id;
}

/** A contest whose window is still open, with the student sitting in it. */
async function seedLiveContest(
  db: Db,
  world: World,
  key: string,
  ownerId: number,
  submissionId: number,
): Promise<number> {
  const now = Date.now();
  const [contest] = await db
    .insert(contests)
    .values({
      key,
      name: 'Thi thử tỉnh',
      startTime: new Date(now - HOUR),
      endTime: new Date(now + HOUR),
      format: 'icpc',
      visibility: 'public',
      createdBy: ownerId,
    })
    .returning({ id: contests.id });
  const [cp] = await db
    .insert(contestProblems)
    .values({ contestId: contest!.id, problemId: world.contestProblemId, label: 'A', points: 100, order: 0 })
    .returning({ id: contestProblems.id });
  const [participation] = await db
    .insert(contestParticipations)
    .values({ contestId: contest!.id, userId: world.studentId, virtual: 0, startTime: new Date(now - HOUR) })
    .returning({ id: contestParticipations.id });
  await db.insert(contestSubmissions).values({
    participationId: participation!.id,
    contestProblemId: cp!.id,
    submissionId,
  });
  return contest!.id;
}

/* -------------------------------------------------------------- the routes */

describe('GET /users/{username}/progress and /users/me/progress (D83)', () => {
  it('counts problems, not submissions, and only public ones on a public profile', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'prog-bars');
        const world = await seedWorld(db, 'bars', 'prog-bars');
        const day = new Date(Date.now() - 3 * 24 * HOUR);
        // Three attempts at ONE problem: one problem attempted, one solved.
        await handIn(db, world, world.publicProblemId, 'WA', day);
        await handIn(db, world, world.publicProblemId, 'WA', day);
        await handIn(db, world, world.publicProblemId, 'AC', day);
        // A private problem they also solved — theirs to see, nobody else's.
        await handIn(db, world, world.privateProblemId, 'AC', day);
        // And a public one they have never got right: attempted is not solved.
        await handIn(db, world, world.unratedProblemId, 'WA', day);

        const pub = await agent.get('/api/v1/users/prog-bars/progress');
        expect(pub.status).toBe(200);
        expect(pub.body.byTag).toEqual([
          { slug: 'quy-hoach-dong', nameVi: 'Quy hoạch động', nameEn: 'Dynamic programming', attempted: 1, solved: 1 },
          { slug: 'so-hoc', nameVi: 'Số học', nameEn: 'Number theory', attempted: 1, solved: 0 },
        ]);
        // Unrated last: it is not a difficulty, and sorting it with the 1s
        // would claim it is the easiest kind of problem there is.
        expect(pub.body.byDifficulty).toEqual([
          { difficulty: 3, attempted: 1, solved: 1 },
          { difficulty: null, attempted: 1, solved: 0 },
        ]);
        // The private problem's tag would announce that it exists.
        expect(JSON.stringify(pub.body)).not.toContain('do-thi');

        const mine = await agent.get('/api/v1/users/me/progress').set('Cookie', cookie);
        expect(mine.status).toBe(200);
        expect(mine.body.byTag.map((bar: { slug: string }) => bar.slug)).toEqual([
          'do-thi',
          'quy-hoach-dong',
          'so-hoc',
        ]);
        expect(mine.body.byDifficulty).toEqual([
          { difficulty: 3, attempted: 1, solved: 1 },
          { difficulty: 7, attempted: 1, solved: 1 },
          { difficulty: null, attempted: 1, solved: 0 },
        ]);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('leaves a live contest AC out of the bars and the streak — and in the heatmap', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'prog-live');
        const world = await seedWorld(db, 'live', 'prog-live');
        const owner = await userIdOf(db, 'live-owner');
        const inContest = await handIn(db, world, world.contestProblemId, 'AC', new Date());
        await seedLiveContest(db, world, 'progressive', owner, inContest);

        const mine = await agent.get('/api/v1/users/me/progress').set('Cookie', cookie);
        expect(mine.status).toBe(200);
        // D49's window exclusion — on the reader's OWN page, because a
        // per-viewer rule could not be cached and D23 never masks a
        // submitter from themselves.
        expect(mine.body.byTag).toEqual([]);
        expect(mine.body.byDifficulty).toEqual([]);
        expect(mine.body.streak).toEqual({ current: 0, longest: 0, lastDate: null });
        // Existence is never hidden (D23), and the calendar is existence.
        expect(mine.body.heatmap.days).toHaveLength(1);
        expect(mine.body.heatmap.days[0].count).toBe(1);
        // Their own verdict is their own — never masked from its submitter.
        expect(mine.body.recent).toHaveLength(1);
        expect(mine.body.recent[0].verdict).toBe('AC');
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('buckets a day by the account’s zone, not UTC', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'prog-tz');
        const world = await seedWorld(db, 'tz', 'prog-tz');
        await db
          .update(schema.users)
          .set({ timezone: 'Asia/Ho_Chi_Minh' })
          .where(eq(schema.users.id, world.studentId));
        // 20:00 UTC yesterday is 03:00 ICT today — the day the person who
        // wrote it would name.
        const yesterdayUtc = addDays(todayIn('UTC', new Date()), -1);
        await handIn(db, world, world.publicProblemId, 'AC', new Date(`${yesterdayUtc}T20:00:00Z`));

        const mine = await agent.get('/api/v1/users/me/progress').set('Cookie', cookie);
        expect(mine.body.heatmap.timezone).toBe('Asia/Ho_Chi_Minh');
        expect(mine.body.heatmap.days).toEqual([
          { date: addDays(yesterdayUtc, 1), count: 1 },
        ]);
        expect(mine.body.heatmap.to).toBe(todayIn('Asia/Ho_Chi_Minh', new Date()));

        // The same instant, read from a zone behind UTC, is the day before.
        await db
          .update(schema.users)
          .set({ timezone: 'America/New_York' })
          .where(eq(schema.users.id, world.studentId));
        const shifted = await agent.get('/api/v1/users/me/progress').set('Cookie', cookie);
        expect(shifted.body.heatmap.days).toEqual([{ date: yesterdayUtc, count: 1 }]);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('lists the contests you are sitting and the homework you owe — and nobody else’s', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'prog-due');
        const world = await seedWorld(db, 'due', 'prog-due');
        const owner = await userIdOf(db, 'due-owner');
        const inContest = await handIn(db, world, world.contestProblemId, 'AC', new Date());
        await seedLiveContest(db, world, 'progdue', owner, inContest);

        // A contest that has already ended: joined, and over.
        const [past] = await db
          .insert(contests)
          .values({
            key: 'progpast',
            name: 'Đã xong',
            startTime: new Date(Date.now() - 4 * HOUR),
            endTime: new Date(Date.now() - 2 * HOUR),
            format: 'icpc',
            visibility: 'public',
            createdBy: owner,
          })
          .returning({ id: contests.id });
        await db.insert(contestParticipations).values({
          contestId: past!.id,
          userId: world.studentId,
          virtual: 0,
          startTime: new Date(Date.now() - 4 * HOUR),
        });

        const [mySchool] = await db
          .insert(organizations)
          .values({ slug: 'thpt-a', name: 'THPT A', visibility: 'public' })
          .returning({ id: organizations.id });
        const [otherSchool] = await db
          .insert(organizations)
          .values({ slug: 'thpt-b', name: 'THPT B', visibility: 'public' })
          .returning({ id: organizations.id });
        await db.insert(orgMembers).values({ orgId: mySchool!.id, userId: world.studentId });
        // Somebody else belongs to the other school, so "this set has no
        // members" cannot be what keeps it off the page — membership must be
        // checked against THIS reader.
        const stranger = await insertUser(db, 'due-stranger');
        await db.insert(orgMembers).values({ orgId: otherSchool!.id, userId: stranger.id });

        async function assign(orgId: number, slug: string, deadline: Date): Promise<number> {
          const [set] = await db
            .insert(problemSets)
            .values({ orgId, slug, name: `Tuần ${slug}`, deadline, createdBy: owner })
            .returning({ id: problemSets.id });
          await db.insert(problemSetItems).values([
            { setId: set!.id, problemId: world.publicProblemId, order: 0, points: 100 },
            { setId: set!.id, problemId: world.privateProblemId, order: 1, points: 100 },
          ]);
          return set!.id;
        }
        await assign(mySchool!.id, 'tuan-1', new Date(Date.now() + 48 * HOUR));
        await assign(mySchool!.id, 'tuan-0', new Date(Date.now() - 48 * HOUR));
        await assign(otherSchool!.id, 'tuan-x', new Date(Date.now() + 48 * HOUR));
        await handIn(db, world, world.publicProblemId, 'AC', new Date(Date.now() - HOUR));
        // The second problem of the set was attempted and not solved: a
        // completion count that read "attempted" would say 2 of 2.
        await handIn(db, world, world.privateProblemId, 'WA', new Date(Date.now() - HOUR));

        const mine = await agent.get('/api/v1/users/me/progress').set('Cookie', cookie);
        expect(mine.body.upcomingContests.map((c: { key: string }) => c.key)).toEqual(['progdue']);
        expect(mine.body.homework).toHaveLength(1);
        expect(mine.body.homework[0]).toMatchObject({
          orgSlug: 'thpt-a',
          slug: 'tuan-1',
          total: 2,
          solved: 1,
        });
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('is signed-in only for `me`, public for a username, and 404s an unknown one', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        await registerAndLogin(agent, 'prog-gate');
        await seedWorld(db, 'gate', 'prog-gate');
        const server = request(app.getHttpServer());
        expect((await server.get('/api/v1/users/me/progress')).status).toBe(401);
        const anon = await server.get('/api/v1/users/prog-gate/progress');
        expect(anon.status).toBe(200);
        // The public shape carries nothing the owner's page adds.
        expect(Object.keys(anon.body).sort()).toEqual(['byDifficulty', 'byTag', 'heatmap']);
        const missing = await server.get('/api/v1/users/nobody-at-all/progress');
        expect(missing.status).toBe(404);
        expect(missing.body.code).toBe('user_not_found');
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('answers an untouched account with empty bars rather than a 404', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'prog-empty');
        const actor: Actor = {
          userId: await userIdOf(db, 'prog-empty'),
          globalRole: 'user',
          via: 'session',
          scopes: [],
        };
        const progress = await app.get(ProgressService).myProgress(actor);
        expect(progress.byTag).toEqual([]);
        expect(progress.heatmap.days).toEqual([]);
        expect(progress.homework).toEqual([]);
        const over = await agent.get('/api/v1/users/me/progress').set('Cookie', cookie);
        expect(over.status).toBe(200);
        expect(over.body.recent).toEqual([]);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

/** Kept honest: the two tables the bars read must stay joined by problem. */
describe('the touched-problem aggregate', () => {
  it('counts a problem once however many tags it carries', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const student = await insertUser(db, 'multi-tag');
        const world = await seedWorld(db, 'multi', 'multi-tag');
        void student;
        const [tag] = await db
          .select({ id: schema.tags.id })
          .from(schema.tags)
          .where(eq(schema.tags.slug, 'tham-lam'));
        await db.insert(problemTags).values({ problemId: world.publicProblemId, tagId: tag!.id });
        await handIn(db, world, world.publicProblemId, 'AC', new Date(Date.now() - HOUR));

        const progress = await app.get(ProgressService).progressFor('multi-tag');
        expect(progress.byTag).toEqual([
          { slug: 'quy-hoach-dong', nameVi: 'Quy hoạch động', nameEn: 'Dynamic programming', attempted: 1, solved: 1 },
          { slug: 'tham-lam', nameVi: 'Tham lam', nameEn: 'Greedy', attempted: 1, solved: 1 },
        ]);
        expect(progress.byDifficulty).toEqual([{ difficulty: 3, attempted: 1, solved: 1 }]);
        expect(
          await db
            .select({ id: problemTags.problemId })
            .from(problemTags)
            .where(and(eq(problemTags.problemId, world.publicProblemId))),
        ).toHaveLength(2);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});
