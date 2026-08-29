/**
 * The three rating defects the 2026-08 sweep found, pinned:
 * a failed replay must not leave the flag flipped (the poisoned-pipeline
 * bug), overlapping replays must serialise (stale-fold-commits-last), and
 * the history route resolves usernames like its profile sibling.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { contests } from '@duckoj/db/guarded';
import { createDb, type Db } from '@duckoj/db';
import type { ContestInput } from '@duckoj/contest-formats';
import { RatingService } from '../src/authz/rating.service.js';
import { ContestAccessService } from '../src/authz/contest.access.js';
import { uncachedScoreboards } from './scoreboard.fixtures.js';
import { withTestDb, testDbUrl } from './db.harness.js';
import { seedGoldenContest } from './contest-golden.fixtures.js';
import type { Actor } from '../src/authz/actor.js';

const ADMIN: Actor = { userId: 1, globalRole: 'admin', via: 'session', scopes: [] };
const START = '2026-03-01T09:00:00Z';

function contestOf(key: string, endTime: string, format = 'default'): ContestInput {
  const names = Array.from({ length: 8 }, (_, i) => `${key}-p${String(i)}`);
  return {
    format,
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
      result: 'AC',
      status: 'D',
      cases: [{ batch: null, case: 1, points: 100 - i, total: 100, status: 'AC' }],
    })),
  };
}

function service(db: Db): RatingService {
  return new RatingService(db, new ContestAccessService(db, uncachedScoreboards()));
}

describe('setRated atomicity', () => {
  it('a replay that throws rolls the flag back, and the pipeline keeps working', async () => {
    await withTestDb(async (db) => {
      // An ioi16 contest whose problem has NO published revision: its
      // scoreboard throws contest_problem_missing_dataset. seedGoldenContest
      // publishes revisions, so un-publish afterwards.
      await seedGoldenContest(db, contestOf('poison', '2026-03-01T14:00:00Z', 'ioi16'));
      await db.execute(
        // Strip the published revision out from under the contest's problem.
        (await import('drizzle-orm')).sql`update problem_revisions set state = 'draft'`,
      );
      await seedGoldenContest(db, contestOf('healthy', '2026-03-02T14:00:00Z'));

      const rating = service(db);
      await expect(rating.setRated(ADMIN, 'poison', true)).rejects.toMatchObject({
        code: 'contest_problem_missing_dataset',
      });
      // The flag must NOT survive the failed replay.
      const [poison] = await db.select().from(contests).where(eq(contests.key, 'poison'));
      expect(poison!.isRated).toBe(false);
      // And the pipeline is not wedged: rating a healthy contest works.
      const { contestsRated } = await rating.setRated(ADMIN, 'healthy', true);
      expect(contestsRated).toBe(1);
    });
  }, 120_000);
});

describe('replay serialisation', () => {
  it('two concurrent setRated calls both land in rating_events', async () => {
    const url = await testDbUrl();
    const { db, close } = createDb(url);
    try {
      await seedGoldenContest(db, contestOf('ser-a', '2026-03-01T14:00:00Z'));
      await seedGoldenContest(db, contestOf('ser-b', '2026-03-02T14:00:00Z'));
      const rating = service(db);

      for (let i = 0; i < 3; i++) {
        await db.update(contests).set({ isRated: false });
        await db.execute((await import('drizzle-orm')).sql`delete from rating_event`);
        await Promise.all([
          rating.setRated(ADMIN, 'ser-a', true),
          rating.setRated(ADMIN, 'ser-b', true),
        ]);
        const events = await db.execute(
          (await import('drizzle-orm')).sql`select distinct contest_id from rating_event`,
        );
        expect(events.length, `iteration ${String(i)}: both contests must have events`).toBe(2);
      }
    } finally {
      await close();
    }
  }, 180_000);
});

describe('the replay lock itself', () => {
  it('setRated blocks while another session holds the replay lock — deterministically', async () => {
    // The interleaving the Promise.all test relies on is too narrow to force
    // reliably (the no-lock mutant survived it), so the lock is pinned
    // directly: a session holding it must stall setRated until release.
    const url = await testDbUrl();
    const { db, close } = createDb(url);
    try {
      await seedGoldenContest(db, contestOf('lock-a', '2026-03-01T14:00:00Z'));
      const rating = service(db);
      const { sql } = await import('drizzle-orm');
      // testDbUrl shares one committed database across this file's suites —
      // clear other suites' rated flags so the count below is this test's.
      await db.update(contests).set({ isRated: false });

      let releaseHold!: () => void;
      const holdReleased = new Promise<void>((resolve) => (releaseHold = resolve));
      let holdTaken!: () => void;
      const lockHeld = new Promise<void>((resolve) => (holdTaken = resolve));
      const holder = db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${0x72617465})`);
        holdTaken();
        await holdReleased;
      });

      await lockHeld;
      let done = false;
      const rated = rating.setRated(ADMIN, 'lock-a', true).then((r) => {
        done = true;
        return r;
      });
      // Give it ample time to finish IF it were not blocked.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(done, 'setRated must be blocked while the lock is held').toBe(false);

      releaseHold();
      await holder;
      const { contestsRated } = await rated;
      expect(done).toBe(true);
      expect(contestsRated).toBe(1);
    } finally {
      await close();
    }
  }, 120_000);
});

describe('historyFor resolves case-insensitively', () => {
  it('MixedCase lookup finds the lowercase user, like the profile route', async () => {
    await withTestDb(async (db) => {
      await seedGoldenContest(db, contestOf('case-c', '2026-03-01T14:00:00Z'));
      const rating = service(db);
      await rating.setRated(ADMIN, 'case-c', true);
      const lower = await rating.historyFor('case-c-p0');
      expect(lower).toHaveLength(1);
      const upper = await rating.historyFor('CASE-C-P0');
      expect(upper).toEqual(lower);
    });
  }, 120_000);
});
