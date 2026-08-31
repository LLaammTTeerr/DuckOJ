/**
 * The scoreboard cache over HTTP, against a real Redis (D25).
 *
 * `scoreboard-cache.spec.ts` pins the key derivation and the coalescing in
 * isolation. This file pins the two claims that only the whole stack can
 * make: that a cached read is byte-for-byte the read it replaced, and that a
 * write which changes the board drops the entry rather than waiting out the
 * 2 s TTL.
 *
 * Every OTHER spec in this suite runs with `TEST_CONFIG.redisUrl` pointing at
 * a deliberately unreachable port, so they all exercise the bypass — which is
 * why nothing else here had to change when the cache landed.
 */
import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { contestParticipations, contestProblems, contests } from '@duckoj/db/guarded';
import type { Db } from '@duckoj/db';
import { SCOREBOARD_CACHE_STORE } from '../src/authz/scoreboard.cache.js';
import { buildApp } from './app.harness.js';
import { longLivedCacheStore } from './cache.harness.js';
import { withTestDb } from './db.harness.js';
import { ensureRedisUrl } from './redis.harness.js';
import {
  registerAndLogin,
  seedProblemAndLanguage,
  seedProblemWithSourceAccess,
  userIdOf,
} from './submissions.fixtures.js';

const MINUTE = 60_000;

/**
 * A running, public contest owned by `ownerId` that freezes for its last 20
 * minutes and ends in ten — so the wall clock is inside the freeze, and the
 * public board and the owner's board genuinely differ.
 */
async function seedRunningContest(
  db: Db,
  key: string,
  ownerId: number,
  problemId: number,
): Promise<number> {
  const now = Date.now();
  const [contest] = await db
    .insert(contests)
    .values({
      key,
      name: key,
      startTime: new Date(now - 50 * MINUTE),
      endTime: new Date(now + 10 * MINUTE),
      format: 'icpc',
      frozenLastMinutes: 20,
      visibility: 'public',
      createdBy: ownerId,
    })
    .returning({ id: contests.id });
  await db
    .insert(contestProblems)
    .values({ contestId: contest!.id, problemId, label: 'A', points: 100, order: 0 });
  return contest!.id;
}

async function join(db: Db, contestId: number, userId: number): Promise<void> {
  await db
    .insert(contestParticipations)
    .values({ contestId, userId, virtual: 0, startTime: new Date(Date.now() - 50 * MINUTE) });
}

/**
 * A live Redis, emptied first. The container is shared across this file (see
 * `redis.harness.ts`), while each test gets its own database whose `contests`
 * ids restart at 1 — so without the flush, test two would read test one's
 * board out of the cache under exactly the same key.
 */
const REDIS_DB = 1;

async function freshRedis(): Promise<string> {
  // `flushdb` on this file's OWN logical database, never `flushall`: the
  // container is shared with `problem-stats` and `contest-booklet`, and a
  // global wipe from one of them lands between another's write and its read.
  const url = await ensureRedisUrl(REDIS_DB);
  const redis = new Redis(url);
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
  return url;
}

async function withCachingApp(
  db: Db,
  body: (app: INestApplication) => Promise<void>,
): Promise<void> {
  const url = await freshRedis();
  const app = await buildApp(db, {
    configOverrides: { redisUrl: url },
    // The real store, with the 2 s expiry raised off the wall clock — see
    // `cache.harness.ts`. Everything this file asserts (the key, the
    // coalescing, the `del` on an edit) is unaffected; what it stops
    // asserting is that two HTTP round trips finish inside two seconds on a
    // machine running the whole workspace's tests at once (B-35).
    overrides: [{ provide: SCOREBOARD_CACHE_STORE, useValue: longLivedCacheStore(url) }],
  });
  try {
    await body(app);
  } finally {
    // Closing is not optional here: it is what runs the store's
    // `onModuleDestroy`, and an ioredis connection left open keeps vitest's
    // event loop alive after the last assertion.
    await app.close();
  }
}

describe('GET /contests/:key/scoreboard, cached', () => {
  it('answers the second read from the cache with the identical body', async () => {
    await withTestDb(async (db) => {
      await withCachingApp(db, async (app) => {
        await seedProblemAndLanguage(db);
        const problem = await seedProblemWithSourceAccess(db, { code: 'sbc1-p' });
        const owner = request.agent(app.getHttpServer());
        await registerAndLogin(owner, 'sbc1-owner');
        const contestId = await seedRunningContest(
          db,
          'sbc1',
          await userIdOf(db, 'sbc1-owner'),
          problem.id,
        );
        const rival = request.agent(app.getHttpServer());
        await registerAndLogin(rival, 'sbc1-rival');
        await join(db, contestId, await userIdOf(db, 'sbc1-rival'));

        const first = await request(app.getHttpServer()).get('/api/v1/contests/sbc1/scoreboard');
        const second = await request(app.getHttpServer()).get('/api/v1/contests/sbc1/scoreboard');

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(first.headers['x-scoreboard-cache']).toBe('miss');
        expect(second.headers['x-scoreboard-cache']).toBe('hit');
        expect(second.body).toEqual(first.body);
        // The cache state is transport metadata and stays out of the board.
        expect(second.body).not.toHaveProperty('cache');
      });
    });
  }, 180_000);

  it('caches the privileged board apart from the frozen public one', async () => {
    await withTestDb(async (db) => {
      await withCachingApp(db, async (app) => {
        await seedProblemAndLanguage(db);
        const problem = await seedProblemWithSourceAccess(db, { code: 'sbc2-p' });
        const owner = request.agent(app.getHttpServer());
        await registerAndLogin(owner, 'sbc2-owner');
        const contestId = await seedRunningContest(
          db,
          'sbc2',
          await userIdOf(db, 'sbc2-owner'),
          problem.id,
        );
        const rival = request.agent(app.getHttpServer());
        await registerAndLogin(rival, 'sbc2-rival');
        await join(db, contestId, await userIdOf(db, 'sbc2-rival'));

        const anonymous = await request(app.getHttpServer()).get('/api/v1/contests/sbc2/scoreboard');
        expect(anonymous.headers['x-scoreboard-cache']).toBe('miss');
        expect(anonymous.body.frozen).toBe(true);

        // A shared key would serve the owner the frozen board a public read
        // just cached — the one mistake a scoreboard cache must not make.
        const privileged = await owner.get('/api/v1/contests/sbc2/scoreboard');
        expect(privileged.headers['x-scoreboard-cache']).toBe('miss');
        expect(privileged.body.frozen).toBe(false);

        expect((await owner.get('/api/v1/contests/sbc2/scoreboard')).headers['x-scoreboard-cache']).toBe(
          'hit',
        );
        expect(
          (await request(app.getHttpServer()).get('/api/v1/contests/sbc2/scoreboard')).headers[
            'x-scoreboard-cache'
          ],
        ).toBe('hit');
      });
    });
  }, 180_000);

  it('drops the cached board when the contest itself is edited', async () => {
    await withTestDb(async (db) => {
      await withCachingApp(db, async (app) => {
        await seedProblemAndLanguage(db);
        const problem = await seedProblemWithSourceAccess(db, { code: 'sbc4-p' });
        const owner = request.agent(app.getHttpServer());
        await registerAndLogin(owner, 'sbc4-owner');
        const contestId = await seedRunningContest(
          db,
          'sbc4',
          await userIdOf(db, 'sbc4-owner'),
          problem.id,
        );
        const rival = request.agent(app.getHttpServer());
        await registerAndLogin(rival, 'sbc4-rival');
        await join(db, contestId, await userIdOf(db, 'sbc4-rival'));

        await request(app.getHttpServer()).get('/api/v1/contests/sbc4/scoreboard');
        expect(
          (await request(app.getHttpServer()).get('/api/v1/contests/sbc4/scoreboard')).headers[
            'x-scoreboard-cache'
          ],
        ).toBe('hit');

        // A rename moves no boundary, so this read lands on the SAME key the
        // hit above came from — which is the only reason it proves the edit
        // dropped the entry rather than merely re-keying it.
        const renamed = await owner.patch('/api/v1/contests/sbc4').send({ name: 'Renamed' });
        expect(renamed.status).toBe(200);

        expect(
          (await request(app.getHttpServer()).get('/api/v1/contests/sbc4/scoreboard')).headers[
            'x-scoreboard-cache'
          ],
        ).toBe('miss');
      });
    });
  }, 180_000);

  it('drops the cached board when a participant is disqualified', async () => {
    await withTestDb(async (db) => {
      await withCachingApp(db, async (app) => {
        await seedProblemAndLanguage(db);
        const problem = await seedProblemWithSourceAccess(db, { code: 'sbc3-p' });
        const owner = request.agent(app.getHttpServer());
        await registerAndLogin(owner, 'sbc3-owner');
        const contestId = await seedRunningContest(
          db,
          'sbc3',
          await userIdOf(db, 'sbc3-owner'),
          problem.id,
        );
        const rival = request.agent(app.getHttpServer());
        await registerAndLogin(rival, 'sbc3-rival');
        await join(db, contestId, await userIdOf(db, 'sbc3-rival'));

        expect(
          (await request(app.getHttpServer()).get('/api/v1/contests/sbc3/scoreboard')).headers[
            'x-scoreboard-cache'
          ],
        ).toBe('miss');
        const cached = await request(app.getHttpServer()).get('/api/v1/contests/sbc3/scoreboard');
        expect(cached.headers['x-scoreboard-cache']).toBe('hit');
        expect(cached.body.ranking[0].is_disqualified).toBe(false);

        const patched = await owner
          .patch('/api/v1/contests/sbc3/participants/sbc3-rival')
          .send({ disqualified: true });
        expect(patched.status).toBe(200);

        // Without the invalidation this is a `hit` on the pre-write board for
        // up to two more seconds — which is what the TTL alone would buy, and
        // is not what a disqualification during a contest should look like.
        const after = await request(app.getHttpServer()).get('/api/v1/contests/sbc3/scoreboard');
        expect(after.headers['x-scoreboard-cache']).toBe('miss');
        expect(after.body.ranking[0].is_disqualified).toBe(true);
      });
    });
  }, 180_000);
});
