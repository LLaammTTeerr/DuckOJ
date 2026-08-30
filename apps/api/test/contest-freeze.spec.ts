/**
 * The scoreboard freeze window over HTTP and through `ContestAccessService`
 * (D22).
 *
 * No clock is injected here and none needs to be: every contest is seeded
 * relative to `Date.now()`, so the wall clock lands wherever the test wants
 * it. The clock injection lives one layer down, in
 * `packages/contest-formats/test/freeze.spec.ts`, which is where the boundary
 * arithmetic is pinned.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import { contests } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import type { ContestInput } from '@duckoj/contest-formats';
import { Scoreboard } from '@duckoj/contracts';
import { ContestAccessService } from '../src/authz/contest.access.js';
import { uncachedScoreboards } from './scoreboard.fixtures.js';
import type { Actor } from '../src/authz/actor.js';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { seedGoldenContest } from './contest-golden.fixtures.js';
import { insertUser, registerAndLogin } from './submissions.fixtures.js';

const MINUTE = 60_000;

function actorFor(userId: number, globalRole: Actor['globalRole'] = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

const VALID = {
  key: 'freeze-open',
  name: 'Freeze Open',
  startTime: '2026-03-01T09:00:00.000Z',
  endTime: '2026-03-01T10:00:00.000Z',
  format: 'icpc',
};

/**
 * A 60-minute contest with a 20-minute freeze, positioned so that `endsInMs`
 * decides which side of the freeze the wall clock is on. One participant, two
 * problems: `<key>-a` solved 40 minutes before the end, `<key>-b` solved five
 * minutes before it — inside a freeze that starts 20 minutes before it.
 */
function freezeContest(key: string, endsInMs: number): ContestInput {
  const end = Date.now() + endsInMs;
  const iso = (offsetFromEnd: number): string => new Date(end + offsetFromEnd).toISOString();
  return {
    format: 'default',
    format_config: null,
    contest: {
      key,
      start_time: iso(-60 * MINUTE),
      end_time: iso(0),
      time_limit_seconds: null,
      points_precision: 3,
      frozen_last_minutes: 20,
    },
    problems: [
      { code: `${key}-a`, points: 100, partial: false, problem_partial: false },
      { code: `${key}-b`, points: 100, partial: false, problem_partial: false },
    ],
    participants: [{ name: `${key}-alice`, real_start: iso(-60 * MINUTE), virtual: 0 }],
    submissions: [
      {
        participant: `${key}-alice`,
        problem: `${key}-a`,
        date: iso(-40 * MINUTE),
        result: 'AC',
        status: 'D',
        cases: [{ batch: null, case: 1, points: 10, total: 10, status: 'AC' }],
      },
      {
        participant: `${key}-alice`,
        problem: `${key}-b`,
        date: iso(-5 * MINUTE),
        result: 'AC',
        status: 'D',
        cases: [{ batch: null, case: 1, points: 10, total: 10, status: 'AC' }],
      },
    ],
  };
}

async function creatorOf(db: Db, contestId: number): Promise<number> {
  const [row] = await db
    .select({ createdBy: contests.createdBy })
    .from(contests)
    .where(eq(contests.id, contestId))
    .limit(1);
  return row!.createdBy!;
}

describe('a scoreboard inside its freeze window', () => {
  it('hides the late submissions from an ordinary viewer and counts them as pending', async () => {
    await withTestDb(async (db) => {
      // Ends in ten minutes, freezes twenty before that: now is inside.
      const { contestId, key } = await seedGoldenContest(db, freezeContest('fz1', 10 * MINUTE));
      const service = new ContestAccessService(db, uncachedScoreboards());

      const board = await service.getScoreboard(null, key);

      expect(board.frozen).toBe(true);
      expect(board.frozenAt).not.toBeNull();
      const alice = board.ranking[0]!;
      expect(alice.score).toBe(100);
      expect(alice.pending).toEqual({ 'fz1-b': 1 });
      expect(contestId).toBeGreaterThan(0);
    });
  }, 120_000);

  it('shows the contest creator the live board', async () => {
    await withTestDb(async (db) => {
      const { contestId, key } = await seedGoldenContest(db, freezeContest('fz2', 10 * MINUTE));
      const service = new ContestAccessService(db, uncachedScoreboards());

      const board = await service.getScoreboard(actorFor(await creatorOf(db, contestId)), key);

      expect(board.frozen).toBe(false);
      expect(board.ranking[0]!.score).toBe(200);
      expect(board.ranking[0]!.pending).toBeUndefined();
    });
  }, 120_000);

  it('shows a global admin the live board', async () => {
    await withTestDb(async (db) => {
      const { key } = await seedGoldenContest(db, freezeContest('fz3', 10 * MINUTE));
      const admin = await insertUser(db, 'fz3-admin');
      await db
        .update(schema.users)
        .set({ globalRole: 'admin' })
        .where(eq(schema.users.id, admin.id));
      const service = new ContestAccessService(db, uncachedScoreboards());

      const board = await service.getScoreboard(actorFor(admin.id, 'admin'), key);

      expect(board.frozen).toBe(false);
      expect(board.ranking[0]!.score).toBe(200);
    });
  }, 120_000);

  it('never freezes the board the rating replay folds', async () => {
    await withTestDb(async (db) => {
      const { contestId } = await seedGoldenContest(db, freezeContest('fz4', 10 * MINUTE));
      const service = new ContestAccessService(db, uncachedScoreboards());

      // D22: `scoreboardForSystem` passes no clock, so a rating replay run
      // during a contest's freeze folds the real scores rather than zeros.
      const board = await service.scoreboardForSystem(contestId);

      expect(board.frozen).toBe(false);
      expect(board.ranking[0]!.score).toBe(200);
    });
  }, 120_000);

  it('unfreezes for everyone once the contest has ended', async () => {
    await withTestDb(async (db) => {
      // Ended five minutes ago: past the freeze instant AND past the end.
      const { key } = await seedGoldenContest(db, freezeContest('fz5', -5 * MINUTE));
      const service = new ContestAccessService(db, uncachedScoreboards());

      const board = await service.getScoreboard(null, key);

      expect(board.frozen).toBe(false);
      expect(board.ranking[0]!.score).toBe(200);
      expect(board.ranking[0]!.pending).toBeUndefined();
    });
  }, 120_000);

  it('serves `frozen`, `frozenAt` and `pending` over HTTP, in the contract shape', async () => {
    await withTestDb(async (db) => {
      const { key } = await seedGoldenContest(db, freezeContest('fz6', 10 * MINUTE));
      const app = await buildApp(db);
      try {
        const res = await request(app.getHttpServer()).get(`/api/v1/contests/${key}/scoreboard`);

        expect(res.status).toBe(200);
        expect(res.body.frozen).toBe(true);
        expect(res.body.ranking[0].pending).toEqual({ 'fz6-b': 1 });
        // The contract is hand-written and could drift from the package it
        // describes; parsing a real response is what stops that.
        expect(() => Scoreboard.parse(res.body)).not.toThrow();
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

/** Registers `username`, promotes it to `setter`, and returns its agent. */
async function setterAgent(app: INestApplication, db: Db, username: string) {
  const agent = request.agent(app.getHttpServer());
  await registerAndLogin(agent, username);
  await db
    .update(schema.users)
    .set({ globalRole: 'setter' })
    .where(eq(schema.users.username, username));
  return agent;
}

describe('writing a freeze window', () => {

  it('accepts and stores a freeze window shorter than the contest', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await setterAgent(app, db, 'fzw-setter');
        const res = await agent.post('/api/v1/contests').send({ ...VALID, frozenLastMinutes: 15 });

        expect(res.status).toBe(201);
        expect(res.body.frozenLastMinutes).toBe(15);
        const [row] = await db.select().from(contests);
        expect(row!.frozenLastMinutes).toBe(15);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses a freeze window as long as the contest, and stores nothing', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await setterAgent(app, db, 'fzw2-setter');
        // The contest runs 60 minutes; a 60-minute freeze hides all of it.
        const res = await agent.post('/api/v1/contests').send({ ...VALID, frozenLastMinutes: 60 });

        expect(res.status).toBe(422);
        expect(res.body.code).toBe('contest_freeze_too_long');
        expect(await db.select().from(contests)).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('validates an edit against the MERGED state — shrinking under a stored freeze is refused', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await setterAgent(app, db, 'fzw3-setter');
        const created = await agent.post('/api/v1/contests').send({ ...VALID, frozenLastMinutes: 45 });
        expect(created.status).toBe(201);

        // The body says nothing about the freeze; the stored 45 minutes is
        // what makes this 30-minute contest impossible.
        const res = await agent
          .patch(`/api/v1/contests/${VALID.key}`)
          .send({ endTime: '2026-03-01T09:30:00.000Z' });

        expect(res.status).toBe(422);
        expect(res.body.code).toBe('contest_freeze_too_long');
        const [row] = await db.select().from(contests);
        expect(row!.endTime.toISOString()).toBe(VALID.endTime);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('lets an edit set a freeze window on a contest that had none', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await setterAgent(app, db, 'fzw4-setter');
        await agent.post('/api/v1/contests').send(VALID);

        const res = await agent.patch(`/api/v1/contests/${VALID.key}`).send({ frozenLastMinutes: 30 });

        expect(res.status).toBe(200);
        expect(res.body.frozenLastMinutes).toBe(30);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
