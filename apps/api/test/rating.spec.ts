/**
 * Phase 4f — the rating fold.
 *
 * The acceptance criterion is §7.1: `rating_event` must be reproducible from
 * nothing. If it is not, every later correction is guesswork — which is why
 * the table is a materialized result and never an input.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { asc, eq } from 'drizzle-orm';
import { contestParticipations, contests, ratingEvents } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import type { ContestInput } from '@duckoj/contest-formats';
import { RatingService } from '../src/authz/rating.service.js';
import { ContestAccessService } from '../src/authz/contest.access.js';
import { uncachedScoreboards } from './scoreboard.fixtures.js';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { seedGoldenContest } from './contest-golden.fixtures.js';
import { registerAndLogin } from './submissions.fixtures.js';

const START = '2026-03-01T09:00:00Z';

/**
 * A contest where `scores[i]` is participant `i`'s points, so ranks are under
 * the test's control. One problem, one submission each, unbatched.
 */
function contestOf(
  key: string,
  scores: number[],
  endTime = '2026-03-01T14:00:00Z',
  /** Share a roster across contests, so a rating carries from one to the next. */
  roster = key,
): ContestInput {
  const names = scores.map((_, i) => `${roster}-p${String(i)}`);
  return {
    format: 'default',
    format_config: null,
    contest: {
      key,
      start_time: START,
      end_time: endTime,
      time_limit_seconds: null,
      points_precision: 3,
      frozen_last_minutes: 0,
    },
    problems: [{ code: `${key}-a`, points: 100, partial: true, problem_partial: true }],
    participants: names.map((name) => ({ name, real_start: START, virtual: 0 })),
    submissions: names.map((name, i) => ({
      participant: name,
      problem: `${key}-a`,
      date: '2026-03-01T10:00:00Z',
      result: scores[i]! > 0 ? 'AC' : 'WA',
      status: 'D',
      cases: [{ batch: null, case: 1, points: scores[i]!, total: 100, status: 'AC' }],
    })),
  };
}

/** Scores that put eight distinct people in a strict order. */
const EIGHT = [100, 90, 80, 70, 60, 50, 40, 30];

function service(db: Db): RatingService {
  return new RatingService(db, new ContestAccessService(db, uncachedScoreboards()));
}

async function markRated(db: Db, key: string): Promise<void> {
  await db.update(contests).set({ isRated: true }).where(eq(contests.key, key));
}

async function eventRows(db: Db) {
  return db
    .select({
      contestId: ratingEvents.contestId,
      userId: ratingEvents.userId,
      rank: ratingEvents.rank,
      ratingBefore: ratingEvents.ratingBefore,
      ratingAfter: ratingEvents.ratingAfter,
      rdAfter: ratingEvents.rdAfter,
      volatilityAfter: ratingEvents.volatilityAfter,
    })
    .from(ratingEvents)
    .orderBy(asc(ratingEvents.contestId), asc(ratingEvents.userId));
}

describe('the replay is reproducible', () => {
  it('regenerates identical rating_event rows from an empty table', async () => {
    await withTestDb(async (db) => {
      await seedGoldenContest(db, contestOf('r1', EIGHT));
      await markRated(db, 'r1');
      const rating = service(db);

      await rating.replayAll();
      const first = await eventRows(db);
      expect(first).toHaveLength(8);

      // The acceptance criterion (§7.1). `rating_event` is a result, so
      // deleting it must cost nothing that cannot be recomputed.
      await db.delete(ratingEvents);
      await rating.replayAll();
      expect(await eventRows(db)).toEqual(first);
    });
  }, 120_000);

  it('is stable across repeated replays without clearing anything', async () => {
    await withTestDb(async (db) => {
      await seedGoldenContest(db, contestOf('r2', EIGHT));
      await markRated(db, 'r2');
      const rating = service(db);
      await rating.replayAll();
      const first = await eventRows(db);
      await rating.replayAll();
      await rating.replayAll();
      expect(await eventRows(db)).toEqual(first);
    });
  }, 120_000);
});

describe('who is rated', () => {
  it('filters the field before applying the threshold, not after', async () => {
    await withTestDb(async (db) => {
      // Twelve participants, of whom five submitted. Filtering first leaves a
      // five-person field and the contest is not rated; testing the threshold
      // first sees twelve and rates it. That is the whole difference between
      // the two orderings, and nothing else in this suite separates them.
      const input = contestOf('r3', [100, 90, 80, 70, 60]);
      for (let i = 5; i < 12; i += 1) {
        input.participants.push({ name: `r3-absent${String(i)}`, real_start: START, virtual: 0 });
      }
      await seedGoldenContest(db, input);
      await markRated(db, 'r3');

      expect(await service(db).replayAll()).toBe(0);
      expect(await eventRows(db)).toHaveLength(0);
    });
  }, 120_000);

  it('rates a field of exactly eight that contains a tie', async () => {
    await withTestDb(async (db) => {
      // The threshold counts people, not distinct ranks.
      await seedGoldenContest(db, contestOf('r4', [100, 90, 90, 70, 60, 50, 40, 30]));
      await markRated(db, 'r4');
      expect(await service(db).replayAll()).toBe(1);

      const rows = await eventRows(db);
      expect(rows).toHaveLength(8);
      const tied = rows.filter((row) => row.rank === 2);
      expect(tied).toHaveLength(2);
      expect(tied[0]!.ratingAfter).toBe(tied[1]!.ratingAfter);
    });
  }, 120_000);

  it('excludes virtual, disqualified and non-submitting entrants', async () => {
    await withTestDb(async (db) => {
      const input = contestOf('r5', [...EIGHT, 20, 10]);
      // A virtual entrant and a disqualified one, both of whom submitted.
      input.participants[8]!.virtual = 1;
      input.participants[9]!.is_disqualified = true;
      // …and one who registered and never submitted.
      input.participants.push({ name: 'r5-ghost', real_start: START, virtual: 0 });
      await seedGoldenContest(db, input);
      await markRated(db, 'r5');
      await service(db).replayAll();

      const rated = await db
        .select({ username: schema.users.username })
        .from(ratingEvents)
        .innerJoin(schema.users, eq(schema.users.id, ratingEvents.userId));
      const names = rated.map((row) => row.username);
      expect(names).toHaveLength(8);
      expect(names).not.toContain('r5-p8');
      expect(names).not.toContain('r5-p9');
      expect(names).not.toContain('r5-ghost');
    });
  }, 120_000);

  it('starts a first-timer at the Glicko-2 default', async () => {
    await withTestDb(async (db) => {
      await seedGoldenContest(db, contestOf('r6', EIGHT));
      await markRated(db, 'r6');
      await service(db).replayAll();
      for (const row of await eventRows(db)) {
        expect(row.ratingBefore).toBe(1500);
      }
    });
  }, 120_000);
});

describe('unrating replays forward', () => {
  it("changes the ratings of every contest that came after it", async () => {
    await withTestDb(async (db) => {
      // Two contests, A before B, with the order reversed in B so ratings
      // actually move in both.
      await seedGoldenContest(db, contestOf('ra', EIGHT, '2026-03-01T14:00:00Z'));
      await seedGoldenContest(db, contestOf('rb', [...EIGHT].reverse(), '2026-03-02T14:00:00Z', 'ra'));
      // The same eight people must be in both, or B has nothing to inherit.
      const aUsers = await db
        .select({ id: contestParticipations.userId })
        .from(contestParticipations)
        .innerJoin(contests, eq(contests.id, contestParticipations.contestId))
        .where(eq(contests.key, 'ra'));
      expect(aUsers).toHaveLength(8);

      await markRated(db, 'ra');
      await markRated(db, 'rb');
      const rating = service(db);
      await rating.replayAll();

      const [contestB] = await db.select({ id: contests.id }).from(contests).where(eq(contests.key, 'rb'));
      const before = (await eventRows(db)).filter((row) => row.contestId === contestB!.id);
      expect(before.length).toBeGreaterThan(0);
      // B's entrants did not start at the default, because A moved them first.
      expect(before.some((row) => row.ratingBefore !== 1500)).toBe(true);

      await db.update(contests).set({ isRated: false }).where(eq(contests.key, 'ra'));
      await rating.replayAll();

      const after = (await eventRows(db)).filter((row) => row.contestId === contestB!.id);
      // The bug this catches: recomputing only the unrated contest. B is
      // downstream, and B is where a real user's rating lives.
      expect(after.every((row) => row.ratingBefore === 1500)).toBe(true);
      expect(after).not.toEqual(before);
    });
  }, 120_000);

  it('lowers max_rating when the contest that produced the peak is unrated', async () => {
    await withTestDb(async (db) => {
      await seedGoldenContest(db, contestOf('rc', EIGHT, '2026-03-01T14:00:00Z'));
      await seedGoldenContest(db, contestOf('rd', [...EIGHT].reverse(), '2026-03-02T14:00:00Z', 'rc'));
      await markRated(db, 'rc');
      await markRated(db, 'rd');
      const rating = service(db);
      await rating.replayAll();

      // The winner of the first contest, who then came last in the second.
      const [peakUser] = await db
        .select({ id: schema.users.id, rating: schema.users.rating, maxRating: schema.users.maxRating })
        .from(schema.users)
        .where(eq(schema.users.username, 'rc-p0'));
      expect(peakUser!.maxRating!).toBeGreaterThan(peakUser!.rating!);

      await db.update(contests).set({ isRated: false }).where(eq(contests.key, 'rc'));
      await rating.replayAll();

      const [afterUser] = await db
        .select({ maxRating: schema.users.maxRating })
        .from(schema.users)
        .where(eq(schema.users.id, peakUser!.id));
      // Recomputed over the replayed history, not kept as a running maximum
      // against the old value — otherwise a peak survives that no longer
      // happened anywhere in the record.
      expect(afterUser!.maxRating!).toBeLessThan(peakUser!.maxRating!);
    });
  }, 120_000);
});

describe('the HTTP surface', () => {
  it('refuses a non-admin and serves a rating history', async () => {
    await withTestDb(async (db) => {
      await seedGoldenContest(db, contestOf('rh', EIGHT));
      const app = await buildApp(db);
      try {
        const plain = request.agent(app.getHttpServer());
        await registerAndLogin(plain, 'plainuser');
        expect((await plain.post('/api/v1/admin/contests/rh/rate')).status).toBe(403);

        const admin = request.agent(app.getHttpServer());
        await registerAndLogin(admin, 'ratingadmin');
        await db
          .update(schema.users)
          .set({ globalRole: 'admin' })
          .where(eq(schema.users.username, 'ratingadmin'));

        const rated = await admin.post('/api/v1/admin/contests/rh/rate');
        expect(rated.status).toBe(200);
        expect(rated.body.contestsRated).toBe(1);

        const history = await request(app.getHttpServer()).get('/api/v1/users/rh-p0/rating');
        expect(history.status).toBe(200);
        expect(history.body.items).toHaveLength(1);
        expect(history.body.nextCursor).toBeNull();
        expect(history.body.items[0].delta).toBe(
          history.body.items[0].ratingAfter - history.body.items[0].ratingBefore,
        );
        expect(history.body.items[0].delta).toBeGreaterThan(0);

        // The cached rating on the user follows the events.
        const [cached] = await db
          .select({ rating: schema.users.rating, maxRating: schema.users.maxRating })
          .from(schema.users)
          .where(eq(schema.users.username, 'rh-p0'));
        expect(cached!.rating).toBeGreaterThan(1500);
        expect(cached!.maxRating).toBe(cached!.rating);

        // An unrated contest leaves no history behind.
        expect((await admin.post('/api/v1/admin/contests/rh/unrate')).status).toBe(200);
        expect((await request(app.getHttpServer()).get('/api/v1/users/rh-p0/rating')).body.items).toHaveLength(0);

        // …and the cache goes back to "never rated", rather than keeping a
        // number from a contest that no longer counts. This is the case the
        // wholesale reset exists for: a user with no events left is only
        // corrected by clearing first, never by the per-user rewrite, which
        // does not visit them at all.
        const [unrated] = await db
          .select({ rating: schema.users.rating, maxRating: schema.users.maxRating })
          .from(schema.users)
          .where(eq(schema.users.username, 'rh-p0'));
        expect(unrated!.rating).toBeNull();
        expect(unrated!.maxRating).toBeNull();
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('404s a rating history for an unknown user', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        expect((await request(app.getHttpServer()).get('/api/v1/users/nobody/rating')).status).toBe(404);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
