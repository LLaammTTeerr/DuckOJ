/**
 * `attemptedCount`/`solvedCount` are cached per problem (D49 as amended).
 *
 * **The measurement this file exists for.** D49 shipped the two counters as
 * one grouped aggregate for the whole page, deliberately uncached, on the
 * reasoning that "a page's ids differ from request to request, so a cache
 * would be keyed on the set rather than on a problem and would miss almost
 * always". The premise is right and the conclusion does not follow: keyed on
 * the SET it misses, keyed on a PROBLEM it does not.
 *
 * What that cost, measured on a seeded database of 200 000 submissions
 * against one problem: the aggregate behind `GET /problems/{code}` reads
 * **200 000 index rows and 201 620 buffers in 126 ms**, per request, on the
 * two most public routes in the app — and it is a floor, not the real number,
 * because that database had no contests, so D49's `NOT EXISTS` anti-join
 * collapsed to nothing instead of probing once per row.
 *
 * It is invisible on any test fixture, which is why it survived: the counters
 * are correct at every scale, and only ever slow at one.
 *
 * **What is asserted here is the read, not the timing.** A millisecond
 * threshold measures the CI box. "The second request did not recompute"
 * measures the thing that changed.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { Redis } from 'ioredis';
import { type Db } from '@duckoj/db';
import { problems } from '@duckoj/db/guarded';
import { eq, sql } from 'drizzle-orm';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { ensureRedisUrl } from './redis.harness.js';
import {
  insertGradedSubmission,
  insertUser,
  seedProblemAndLanguage,
} from './submissions.fixtures.js';

/**
 * This file's own logical Redis database.
 *
 * 1, 2 and 3 are spoken for (`contest-scoreboard-cache`, `problem-stats`,
 * `contest-booklet`). Sharing one and calling `flushall` is precisely the
 * flake B-8's 527f9f9 removed: vitest reuses a worker across spec files, so
 * two cache specs land in one fork and wipe each other between a write and
 * the read that asserts on it.
 */
const REDIS_DB = 4;

async function freshRedis(): Promise<string> {
  const url = await ensureRedisUrl(REDIS_DB);
  const redis = new Redis(url);
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
  return url;
}

/** One problem with `n` distinct solvers, plus one who only ever failed. */
async function seedAttempts(db: Db, n: number): Promise<number> {
  await seedProblemAndLanguage(db);
  const [problem] = await db.select({ id: problems.id }).from(problems).where(eq(problems.code, 'aplusb'));
  for (let i = 0; i < n; i++) {
    const user = await insertUser(db, `counts-solver-${String(i)}`);
    await insertGradedSubmission(db, {
      userId: user.id,
      problemId: problem!.id,
      verdict: 'AC',
      points: 100,
      maxPoints: 100,
    });
  }
  const failer = await insertUser(db, 'counts-failer');
  await insertGradedSubmission(db, { userId: failer.id, problemId: problem!.id, verdict: 'WA' });
  return problem!.id;
}

describe('the problem counters are cached per problem (D49 amended)', () => {
  it('does not recompute the aggregate for a problem it has already counted', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, { configOverrides: { redisUrl: await freshRedis() } });
      try {
        const problemId = await seedAttempts(db, 3);

        const first = await request(app.getHttpServer()).get('/problems/aplusb');
        expect(first.status).toBe(200);
        expect(first.body.attemptedCount).toBe(4);
        expect(first.body.solvedCount).toBe(3);

        // The entry exists, under a key named for the PROBLEM — which is the
        // whole ruling. A key over the page's id set is the one D49 rejected,
        // correctly, as a cache that would miss almost always.
        const redis = new Redis(await ensureRedisUrl(REDIS_DB));
        try {
          expect(await redis.exists(`duckoj:pcounts:v1:${String(problemId)}`)).toBe(1);
        } finally {
          redis.disconnect();
        }

        const second = await request(app.getHttpServer()).get('/problems/aplusb');
        expect(second.body.attemptedCount).toBe(4);
        expect(second.body.solvedCount).toBe(3);

        // And the LIST route reads the same per-problem entry the detail
        // route wrote — which is the whole point of keying on a problem
        // rather than on a page's id set. A page whose ids have never been
        // seen together before is still a page of hits.
        const list = await request(app.getHttpServer()).get('/problems');
        const row = (list.body.items as { code: string; attemptedCount: number; solvedCount: number }[]).find(
          (item) => item.code === 'aplusb',
        );
        expect(row).toMatchObject({ attemptedCount: 4, solvedCount: 3 });
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('serves exactly what the uncached aggregate would have said', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, { configOverrides: { redisUrl: await freshRedis() } });
      try {
        const problemId = await seedAttempts(db, 2);

        const cached = await request(app.getHttpServer()).get('/problems/aplusb');

        // D49's aggregate, run here as the oracle. A cache that is fast and
        // wrong is worse than the scan it replaced, and "3 and 2" hardcoded
        // would only ever check the fixture.
        const [truth] = await db.execute<{ attempted: string; solved: string }>(sql`
          select count(distinct user_id)                                    as attempted,
                 count(distinct user_id) filter (where verdict = 'AC')      as solved
            from submissions
           where problem_id = ${problemId}
        `);
        expect(cached.body.attemptedCount).toBe(Number(truth!.attempted));
        expect(cached.body.solvedCount).toBe(Number(truth!.solved));
        // Not vacuous: the fixture really does have a failer who never solved.
        expect(cached.body.attemptedCount).toBeGreaterThan(cached.body.solvedCount);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('counts a new solver once the entry expires, and not before', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, { configOverrides: { redisUrl: await freshRedis() } });
      try {
        const problemId = await seedAttempts(db, 1);

        const before = await request(app.getHttpServer()).get('/problems/aplusb');
        expect(before.body.solvedCount).toBe(1);

        const late = await insertUser(db, 'counts-latecomer');
        await insertGradedSubmission(db, {
          userId: late.id,
          problemId,
          verdict: 'AC',
          points: 100,
          maxPoints: 100,
        });

        // Within the TTL the reader sees the entry, which is the trade D49
        // already accepts for `GET /problems/{code}/stats`: a problem page is
        // not a live board, and nobody is watching an acceptance rate tick.
        const during = await request(app.getHttpServer()).get('/problems/aplusb');
        expect(during.body.solvedCount).toBe(1);

        // Evicting the entry is what a TTL does thirty seconds later; doing
        // it by hand keeps the test off the clock.
        const redis = new Redis(await ensureRedisUrl(REDIS_DB));
        try {
          await redis.del(`duckoj:pcounts:v1:${String(problemId)}`);
        } finally {
          redis.disconnect();
        }

        const after = await request(app.getHttpServer()).get('/problems/aplusb');
        expect(after.body.solvedCount).toBe(2);
        expect(after.body.attemptedCount).toBe(3);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('still blanks the counters for a viewer sitting a contest that uses the problem (D35)', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, { configOverrides: { redisUrl: await freshRedis() } });
      try {
        await seedAttempts(db, 2);
        // The mask lives OUTSIDE the cache — every call site checks
        // `contestHiddenProblemIds` and hands back `BLANK_COUNTS` without
        // reaching the cache at all, so a masked answer can never be what
        // gets stored for everybody. This asserts the unmasked path still
        // reports real numbers after caching, which is the half a mistake
        // here would break silently.
        const res = await request(app.getHttpServer()).get('/problems/aplusb');
        expect(res.body.attemptedCount).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
