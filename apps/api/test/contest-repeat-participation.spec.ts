/**
 * One person, several participations in one contest — and the scoreboard that
 * has to describe them (D36).
 *
 * The schema has always permitted it (`UNIQUE (contest_id, user_id, virtual)`
 * keys on the attempt, not the person) and 4d's `join` makes it routine: a
 * virtual join is deliberately not idempotent, and a live entrant may replay
 * the contest virtually once it has ended. `mapContest` used to refuse that
 * state with `409 contest_duplicate_participant`, which turned one competitor
 * pressing "join" twice into a scoreboard nobody could read again.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { contestParticipations, contestProblems, contests, ratingEvents } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import type { ContestInput } from '@duckoj/contest-formats';
import { ContestAccessService } from '../src/authz/contest.access.js';
import { RatingService } from '../src/authz/rating.service.js';
import { uncachedScoreboards } from './scoreboard.fixtures.js';
import { seedGoldenContest } from './contest-golden.fixtures.js';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import {
  insertUser,
  registerAndLogin,
  seedProblemAndLanguage,
  seedProblemWithSourceAccess,
  userIdOf,
} from './submissions.fixtures.js';

const MINUTE = 60_000;
const CONTEST_OWNER = 'repeat-owner';

async function seedContest(
  db: Db,
  opts: { key: string; problemId: number; startsInMs: number; endsInMs: number },
): Promise<number> {
  const now = Date.now();
  const owner = await userIdOf(db, CONTEST_OWNER);
  const [contest] = await db
    .insert(contests)
    .values({
      key: opts.key,
      name: opts.key,
      startTime: new Date(now + opts.startsInMs),
      endTime: new Date(now + opts.endsInMs),
      format: 'icpc',
      visibility: 'public',
      createdBy: owner,
    })
    .returning({ id: contests.id });
  await db.insert(contestProblems).values({
    contestId: contest!.id,
    problemId: opts.problemId,
    label: 'A',
    points: 100,
    order: 0,
  });
  return contest!.id;
}

async function baseline(db: Db, code: string) {
  await seedProblemAndLanguage(db);
  await insertUser(db, CONTEST_OWNER);
  return seedProblemWithSourceAccess(db, { code, visibility: 'public' });
}

describe('a competitor holding more than one participation', () => {
  it('still has a readable scoreboard, with one row per attempt', async () => {
    await withTestDb(async (db) => {
      const problem = await baseline(db, 'repeat-a');
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'repeater');
        await seedContest(db, {
          key: 'repeat-c',
          problemId: problem.id,
          startsInMs: -120 * MINUTE,
          endsInMs: -60 * MINUTE,
        });

        // Two virtual attempts — exactly what `join`'s own doc comment says a
        // second virtual join is for.
        const first = await agent.post('/contests/repeat-c/join');
        const second = await agent.post('/contests/repeat-c/join');
        expect(first.body.virtual).toBe(1);
        expect(second.body.virtual).toBe(2);

        const board = await agent.get('/contests/repeat-c/scoreboard');
        expect(board.status).toBe(200);
        const rows = board.body.ranking as { participant: string; virtual: number }[];
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.virtual).sort()).toEqual([1, 2]);
        // The row still names the person, not a synthesised key: the web links
        // it to `/users/{name}` and the rating fold reads it.
        for (const row of rows) expect(row.participant).toBe('repeater');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('attributes each submission to the attempt it was made in, never merging them', async () => {
    await withTestDb(async (db) => {
      const problem = await baseline(db, 'repeat-b');
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'live-then-virtual');
        const contestId = await seedContest(db, {
          key: 'both-c',
          problemId: problem.id,
          startsInMs: -MINUTE,
          endsInMs: 60 * MINUTE,
        });

        // Live: joined and submitted while the contest ran.
        const live = await agent.post('/contests/both-c/join');
        expect(live.body.virtual).toBe(0);
        const submitted = await agent.post('/submissions').send({
          problemCode: 'repeat-b',
          languageKey: 'cpp17',
          source: 'int main(){}',
          contestKey: 'both-c',
        });
        expect(submitted.status).toBe(201);

        // A second attempt by the same person, its window deliberately
        // overlapping the first's so the two are told apart by identity alone
        // and not by the window filter. Seeded rather than joined: `join`
        // only mints a virtual attempt once the contest has ended, and moving
        // the contest's window would void the submission above (m4) and hide
        // the misattribution this test is about.
        await db.insert(contestParticipations).values({
          contestId,
          userId: await userIdOf(db, 'live-then-virtual'),
          virtual: 1,
          startTime: new Date(Date.now() - MINUTE),
        });

        const board = await agent.get('/contests/both-c/scoreboard');
        expect(board.status).toBe(200);
        const rows = board.body.ranking as { virtual: number; submission_count: number }[];
        expect(rows).toHaveLength(2);
        // The live attempt owns the one submission; the fresh virtual attempt
        // owns none. Keyed by name, both rows would have reported the same
        // count — the silent misattribution the old 409 existed to prevent.
        const byVirtual = new Map(rows.map((row) => [row.virtual, row.submission_count]));
        expect(byVirtual.get(0)).toBe(1);
        expect(byVirtual.get(1)).toBe(0);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

/**
 * D36's blast radius on the one caller that folds a board with no viewer:
 * `RatingService`. Before D36 a rated contest holding a duplicate
 * participation threw from `mapContest`, and because `replayInto` folds EVERY
 * rated contest in one transaction, that one contest wedged
 * `POST /admin/contests/{key}/rate` for all of them.
 */
describe('the rating replay over a contest with a repeat participant', () => {
  const RATED_START = '2026-03-01T09:00:00Z';

  /** `scores[i]` fixes participant `i`'s rank — the rating suite's own shape. */
  function contestOf(key: string, scores: number[]): ContestInput {
    const names = scores.map((_, i) => `${key}-p${String(i)}`);
    return {
      format: 'default',
      format_config: null,
      contest: {
        key,
        start_time: RATED_START,
        end_time: '2026-03-01T14:00:00Z',
        time_limit_seconds: null,
        points_precision: 3,
        frozen_last_minutes: 0,
      },
      problems: [{ code: `${key}-a`, points: 100, partial: true, problem_partial: true }],
      participants: names.map((name) => ({ name, real_start: RATED_START, virtual: 0 })),
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

  it('rates the live attempt once, and the virtual one not at all', async () => {
    await withTestDb(async (db) => {
      const scores = [100, 90, 80, 70, 60, 50, 40, 30, 20];
      const { contestId } = await seedGoldenContest(db, contestOf('rr', scores));
      await db.update(contests).set({ isRated: true }).where(eq(contests.id, contestId));

      // The winner replays their own contest virtually, months later. This is
      // what `join` produces, and it used to make the whole replay throw.
      const [winner] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.username, 'rr-p0'));
      await db.insert(contestParticipations).values({
        contestId,
        userId: winner!.id,
        virtual: 1,
        startTime: new Date('2026-06-01T09:00:00Z'),
      });

      const rating = new RatingService(db, new ContestAccessService(db, uncachedScoreboards()));
      expect(await rating.replayAll()).toBe(1);

      const events = await db.select({ userId: ratingEvents.userId }).from(ratingEvents);
      expect(events).toHaveLength(scores.length);
      // Exactly one event for the person holding two participations:
      // `rankedFieldFor` keeps only `virtual === 0`, so a virtual replay can
      // neither earn a rating nor enter the field twice.
      expect(events.filter((row) => row.userId === winner!.id)).toHaveLength(1);
    });
  }, 120_000);
});
