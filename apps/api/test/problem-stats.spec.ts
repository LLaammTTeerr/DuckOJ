/**
 * Phase F6 — problem statistics (D49).
 *
 * The load-bearing claim is the exclusion: a submission joins the statistics
 * only once its contest participation window has CLOSED, uniformly for every
 * viewer. This file seeds the whole participation matrix — practice, live,
 * live with a time limit, virtual, spectating, and a finished contest — and
 * asserts the one predicate marks exactly the open ones, the same agreement
 * shape `submission-freeze.spec.ts` established for the freeze.
 */
import request from 'supertest';
import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  contestParticipations,
  contestProblems,
  contestSubmissions,
  contests,
  problems,
  submissions,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { ProblemAccessService } from '../src/authz/problem.access.js';
import { buildApp } from './app.harness.js';
import { bypassCache } from './cache.harness.js';
import { withTestDb } from './db.harness.js';
import { ensureRedisUrl } from './redis.harness.js';
import {
  insertUser,
  seedProblemAndLanguage,
  seedProblemWithSourceAccess,
} from './submissions.fixtures.js';
import type { Actor } from '../src/authz/actor.js';
import type { PackageStore } from '../src/packages/package.store.js';

const MINUTE = 60_000;

/** Mirrors `problem-reads.spec.ts`'s: nothing here touches a package. */
const UNUSED_STORE: PackageStore = {
  has: () => Promise.reject(new Error('unexpected package store access in this test')),
  put: () => Promise.reject(new Error('unexpected package store access in this test')),
  get: () => Promise.reject(new Error('unexpected package store access in this test')),
  delete: () => Promise.reject(new Error('unexpected package store access in this test')),
};

function actorFor(userId: number): Actor {
  return { userId, globalRole: 'user', scopes: ['problems:read'], via: 'session' };
}

/** A graded submission with the timing the fastest table reads. */
async function submit(
  db: Db,
  opts: {
    userId: number;
    problemId: number;
    verdict: 'AC' | 'WA' | 'TLE' | 'CE';
    timeMs?: number;
    memoryKb?: number;
    createdAt?: Date;
    languageKey?: string;
  },
): Promise<number> {
  const [language] = await db
    .select({ id: schema.languages.id })
    .from(schema.languages)
    .where(eq(schema.languages.key, opts.languageKey ?? 'cpp17'));
  const [problem] = await db
    .select({ currentRevisionId: problems.currentRevisionId })
    .from(problems)
    .where(eq(problems.id, opts.problemId));
  const [row] = await db
    .insert(submissions)
    .values({
      userId: opts.userId,
      problemId: opts.problemId,
      revisionId: problem!.currentRevisionId!,
      languageId: language!.id,
      source: 'src',
      state: 'done',
      verdict: opts.verdict,
      points: opts.verdict === 'AC' ? 100 : 0,
      maxPoints: 100,
      timeMs: opts.timeMs ?? 100,
      memoryKb: opts.memoryKb ?? 1024,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning({ id: submissions.id });
  return row!.id;
}

/**
 * A contest holding `problemId`, one participation of the given shape, and
 * `submissionId` routed into it.
 */
async function routeIntoContest(
  db: Db,
  opts: {
    key: string;
    problemId: number;
    userId: number;
    submissionId: number;
    startedMinutesAgo: number;
    durationMinutes: number;
    virtual?: number;
    timeLimitSeconds?: number | null;
  },
): Promise<number> {
  const owner = await insertUser(db, `${opts.key}-owner`, 'admin');
  const start = new Date(Date.now() - opts.startedMinutesAgo * MINUTE);
  const [contest] = await db
    .insert(contests)
    .values({
      key: opts.key,
      name: opts.key,
      startTime: start,
      endTime: new Date(start.getTime() + opts.durationMinutes * MINUTE),
      format: 'icpc',
      visibility: 'public',
      createdBy: owner.id,
      ...(opts.timeLimitSeconds === undefined ? {} : { timeLimitSeconds: opts.timeLimitSeconds }),
    })
    .returning({ id: contests.id });
  const [contestProblem] = await db
    .insert(contestProblems)
    .values({ contestId: contest!.id, problemId: opts.problemId, label: 'A', points: 100, order: 0 })
    .returning({ id: contestProblems.id });
  const [participation] = await db
    .insert(contestParticipations)
    .values({ contestId: contest!.id, userId: opts.userId, virtual: opts.virtual ?? 0, startTime: start })
    .returning({ id: contestParticipations.id });
  await db
    .insert(contestSubmissions)
    .values({
      participationId: participation!.id,
      contestProblemId: contestProblem!.id,
      submissionId: opts.submissionId,
    });
  return contest!.id;
}

describe('ProblemStats (D49)', () => {
  it('counts submissions, people, verdicts and languages, and reports a submission acceptance rate', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const problem = await seedProblemWithSourceAccess(db, { code: 'stats-basic' });
      const a = await insertUser(db, 'stats-a');
      const b = await insertUser(db, 'stats-b');
      await submit(db, { userId: a.id, problemId: problem.id, verdict: 'WA' });
      await submit(db, { userId: a.id, problemId: problem.id, verdict: 'AC' });
      await submit(db, { userId: b.id, problemId: problem.id, verdict: 'WA' });
      await submit(db, { userId: b.id, problemId: problem.id, verdict: 'TLE' });

      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
      const { stats } = await service.getStats(null, 'stats-basic');

      expect(stats.totalSubmissions).toBe(4);
      expect(stats.attemptedUsers).toBe(2);
      expect(stats.solvedUsers).toBe(1);
      // A SUBMISSION rate — one AC out of four attempts — not one solver
      // out of two people.
      expect(stats.acceptanceRate).toBeCloseTo(0.25);
      expect(stats.verdicts).toEqual([
        { key: 'WA', count: 2 },
        { key: 'AC', count: 1 },
        { key: 'TLE', count: 1 },
      ]);
      expect(stats.languages).toEqual([{ key: 'cpp17', count: 4 }]);
    });
  }, 120_000);

  it('reports a null acceptance rate for a problem nobody has attempted', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      await seedProblemWithSourceAccess(db, { code: 'stats-empty' });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
      const { stats } = await service.getStats(null, 'stats-empty');
      // `null`, never 0: "nobody has tried" is not "nobody succeeded".
      expect(stats.acceptanceRate).toBeNull();
      expect(stats.firstSolver).toBeNull();
      expect(stats.fastest).toEqual([]);
    });
  }, 120_000);

  it('lists the fastest ACs one row per person, and names the first solver', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const problem = await seedProblemWithSourceAccess(db, { code: 'stats-fast' });
      const slow = await insertUser(db, 'stats-slow');
      const quick = await insertUser(db, 'stats-quick');
      // The first solver is the SLOW one: earliest, not fastest.
      const firstId = await submit(db, {
        userId: slow.id,
        problemId: problem.id,
        verdict: 'AC',
        timeMs: 900,
        createdAt: new Date(Date.now() - 10 * MINUTE),
      });
      // The slower one FIRST, so a `DISTINCT ON` that fell back to id order
      // (or to "their earliest AC") would pick the wrong row rather than
      // accidentally picking the right one.
      await submit(db, { userId: quick.id, problemId: problem.id, verdict: 'AC', timeMs: 400 });
      // One person's second row must not appear at all — a student
      // resubmitting eleven times would otherwise own the whole table.
      await submit(db, { userId: quick.id, problemId: problem.id, verdict: 'AC', timeMs: 50 });

      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
      const { stats } = await service.getStats(null, 'stats-fast');

      expect(stats.fastest.map((row) => [row.username, row.timeMs])).toEqual([
        ['stats-quick', 50],
        ['stats-slow', 900],
      ]);
      expect(stats.firstSolver?.username).toBe('stats-slow');
      expect(stats.firstSolver?.submissionId).toBe(firstId);
    });
  }, 120_000);

  it('excludes every submission whose contest window is still open, and includes it once closed', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const problem = await seedProblemWithSourceAccess(db, { code: 'stats-window' });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      // Practice — always counted.
      const practice = await insertUser(db, 'stats-practice');
      await submit(db, { userId: practice.id, problemId: problem.id, verdict: 'AC', timeMs: 10 });
      expect((await service.getStats(null, 'stats-window')).stats.totalSubmissions).toBe(1);

      // Every shape of an OPEN window, one after another. None may move the
      // totals, and none may put a name in the fastest table.
      const shapes = [
        { key: 'w-live', startedMinutesAgo: 10, durationMinutes: 300, virtual: 0 },
        { key: 'w-live-tl', startedMinutesAgo: 10, durationMinutes: 300, virtual: 0, timeLimitSeconds: 3600 },
        { key: 'w-virtual', startedMinutesAgo: 5, durationMinutes: 300, virtual: 1 },
        { key: 'w-spectate', startedMinutesAgo: 10, durationMinutes: 300, virtual: -1 },
      ];
      for (const shape of shapes) {
        const user = await insertUser(db, `u-${shape.key}`);
        const id = await submit(db, { userId: user.id, problemId: problem.id, verdict: 'AC', timeMs: 5 });
        await routeIntoContest(db, { ...shape, problemId: problem.id, userId: user.id, submissionId: id });
      }
      const during = await service.getStats(null, 'stats-window');
      expect(during.stats.totalSubmissions).toBe(1);
      expect(during.stats.attemptedUsers).toBe(1);
      expect(during.stats.fastest.map((row) => row.username)).toEqual(['stats-practice']);

      // A FINISHED contest's submission counts like any other.
      const closedUser = await insertUser(db, 'u-closed');
      const closedId = await submit(db, { userId: closedUser.id, problemId: problem.id, verdict: 'AC', timeMs: 1 });
      await routeIntoContest(db, {
        key: 'w-closed',
        problemId: problem.id,
        userId: closedUser.id,
        submissionId: closedId,
        startedMinutesAgo: 600,
        durationMinutes: 300,
      });
      const after = await service.getStats(null, 'stats-window');
      expect(after.stats.totalSubmissions).toBe(2);
      expect(after.stats.fastest.map((row) => row.username)).toEqual(['u-closed', 'stats-practice']);
    });
  }, 180_000);

  it('excludes an open window for the contest\'s own creator and for an admin too', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const problem = await seedProblemWithSourceAccess(db, { code: 'stats-uniform' });
      const entrant = await insertUser(db, 'stats-entrant');
      const id = await submit(db, { userId: entrant.id, problemId: problem.id, verdict: 'AC' });
      await routeIntoContest(db, {
        key: 'uniform',
        problemId: problem.id,
        userId: entrant.id,
        submissionId: id,
        startedMinutesAgo: 10,
        durationMinutes: 300,
      });
      const admin = await insertUser(db, 'stats-admin', 'admin');
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      // Uniform for EVERY viewer — that is what makes the response
      // viewer-independent and the one cache key sound.
      for (const actor of [null, actorFor(entrant.id), { ...actorFor(admin.id), globalRole: 'admin' as const }]) {
        const { stats } = await service.getStats(actor, 'stats-uniform');
        expect(stats.totalSubmissions).toBe(0);
      }
    });
  }, 120_000);

  it('blanks the statistics for a viewer sitting a running contest that uses the problem (D35)', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const problem = await seedProblemWithSourceAccess(db, { code: 'stats-hidden' });
      const solver = await insertUser(db, 'stats-hidden-solver');
      await submit(db, { userId: solver.id, problemId: problem.id, verdict: 'AC' });
      // A DIFFERENT person's submission, in a contest the viewer is sitting.
      const sitter = await insertUser(db, 'stats-sitter');
      const id = await submit(db, { userId: sitter.id, problemId: problem.id, verdict: 'WA' });
      await routeIntoContest(db, {
        key: 'sitting',
        problemId: problem.id,
        userId: sitter.id,
        submissionId: id,
        startedMinutesAgo: 10,
        durationMinutes: 300,
      });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      // Blanked to exactly the shape an untouched problem returns — never a
      // distinguishable "hidden" state, which would itself confirm the
      // problem is in the contest they are sitting.
      const sat = await service.getStats(actorFor(sitter.id), 'stats-hidden');
      expect(sat.stats).toEqual({
        totalSubmissions: 0,
        attemptedUsers: 0,
        solvedUsers: 0,
        acceptanceRate: null,
        verdicts: [],
        languages: [],
        fastest: [],
        firstSolver: null,
      });
      // …while everyone else still reads the real thing.
      expect((await service.getStats(null, 'stats-hidden')).stats.totalSubmissions).toBe(1);
    });
  }, 120_000);
});

describe('problem list counters (D49)', () => {
  it('carries solved/attempted on every row in one aggregate, blanked for a D35-hidden viewer', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const problem = await seedProblemWithSourceAccess(db, { code: 'counts-p' });
      const a = await insertUser(db, 'counts-a');
      const b = await insertUser(db, 'counts-b');
      await submit(db, { userId: a.id, problemId: problem.id, verdict: 'AC' });
      await submit(db, { userId: a.id, problemId: problem.id, verdict: 'WA' });
      await submit(db, { userId: b.id, problemId: problem.id, verdict: 'WA' });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const page = await service.listVisible(null, { limit: 25 });
      const row = page.items.find((item) => item.code === 'counts-p');
      expect(row?.attemptedCount).toBe(2);
      expect(row?.solvedCount).toBe(1);
      // The detail agrees with the list — one derivation, not two.
      const detail = await service.getVisible(null, 'counts-p');
      expect(detail.attemptedCount).toBe(2);
      expect(detail.solvedCount).toBe(1);

      const sitter = await insertUser(db, 'counts-sitter');
      const id = await submit(db, { userId: sitter.id, problemId: problem.id, verdict: 'WA' });
      await routeIntoContest(db, {
        key: 'counts-contest',
        problemId: problem.id,
        userId: sitter.id,
        submissionId: id,
        startedMinutesAgo: 10,
        durationMinutes: 300,
      });
      // The counters exclude the open window for everyone, exactly as the
      // statistics do — the sitter's WA does not move anybody's row.
      const still = await service.listVisible(null, { limit: 25 });
      expect(still.items.find((item) => item.code === 'counts-p')?.attemptedCount).toBe(2);

      const masked = await service.listVisible(actorFor(sitter.id), { limit: 25 });
      const maskedRow = masked.items.find((item) => item.code === 'counts-p');
      expect(maskedRow?.attemptedCount).toBe(0);
      expect(maskedRow?.solvedCount).toBe(0);
    });
  }, 180_000);
});

describe('GET /problems/{code}/stats', () => {
  it('404s a problem the caller may not see', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        await seedProblemWithSourceAccess(db, { code: 'stats-private', visibility: 'private' });
        const res = await request(app.getHttpServer()).get('/problems/stats-private/stats');
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('problem_not_found');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('serves the statistics and caches them for 30 s', async () => {
    await withTestDb(async (db) => {
      const url = await ensureRedisUrl();
      const redis = new Redis(url);
      try {
        await redis.flushall();
      } finally {
        redis.disconnect();
      }
      const app = await buildApp(db, { configOverrides: { redisUrl: url } });
      try {
        await seedProblemAndLanguage(db);
        const problem = await seedProblemWithSourceAccess(db, { code: 'stats-http' });
        const user = await insertUser(db, 'stats-http-user');
        await submit(db, { userId: user.id, problemId: problem.id, verdict: 'AC', timeMs: 7 });

        const first = await request(app.getHttpServer()).get('/problems/stats-http/stats');
        expect(first.status).toBe(200);
        expect(first.headers['x-stats-cache']).toBe('miss');
        expect(first.body.fastest).toEqual([
          expect.objectContaining({ username: 'stats-http-user', timeMs: 7 }),
        ]);
        // Transport metadata rides a header, never the body (D25).
        expect(first.body).not.toHaveProperty('cache');

        const second = await request(app.getHttpServer()).get('/problems/stats-http/stats');
        expect(second.headers['x-stats-cache']).toBe('hit');
        expect(second.body).toEqual(first.body);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});
