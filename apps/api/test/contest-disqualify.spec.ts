/**
 * Disqualification: who may do it, what it moves, and what the scoreboard
 * then does with it.
 *
 * The last part is the one worth stating plainly, because the brief's wording
 * ("the scoreboard lowering must exclude disqualified participants") admits a
 * reading this codebase deliberately does not take. `lower.ts` carries
 * `is_disqualified` through, `scoreboard.ts` sorts on it FIRST — every
 * disqualified row ranks below every qualified one, whatever it scored — and
 * `RatingService.rankedFieldFor` drops those rows from the rated field
 * entirely. Rows are not *removed* from the ranking, and must not be: the same
 * brief asks the web to render disqualified rows struck through with `[DQ]`,
 * which needs a row to render. "Excluded" here means excluded from standing,
 * not from the page. No golden contains a disqualified participant, so none of
 * this was pinned by anything before this file.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { contestParticipations, contestProblems, contests, ratingEvents } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import type { ContestInput } from '@duckoj/contest-formats';
import { computeContestScoreboard } from '@duckoj/contest-formats';
import { ContestAccessService } from '../src/authz/contest.access.js';
import { uncachedScoreboards } from './scoreboard.fixtures.js';
import { RatingService } from '../src/authz/rating.service.js';
import type { Actor } from '../src/authz/actor.js';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { seedGoldenContest } from './contest-golden.fixtures.js';
import {
  insertUser,
  registerAndLogin,
  seedProblemAndLanguage,
  seedProblemWithSourceAccess,
  userIdOf,
} from './submissions.fixtures.js';

const RATED_START = '2026-03-01T09:00:00Z';

/**
 * A rated-shaped contest where `scores[i]` fixes participant `i`'s rank —
 * the same helper `rating.spec.ts` uses, kept local rather than exported so
 * that file's fixtures stay its own.
 */
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

const MINUTE = 60_000;

function actorFor(userId: number, globalRole: Actor['globalRole'] = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

/** A finished, public contest owned by `ownerId`, with one problem. */
async function seedContest(db: Db, key: string, ownerId: number, problemId: number) {
  const now = Date.now();
  const [contest] = await db
    .insert(contests)
    .values({
      key,
      name: key,
      startTime: new Date(now - 120 * MINUTE),
      endTime: new Date(now - 60 * MINUTE),
      format: 'icpc',
      visibility: 'public',
      createdBy: ownerId,
    })
    .returning({ id: contests.id });
  await db
    .insert(contestProblems)
    .values({ contestId: contest!.id, problemId, label: 'A', points: 100, order: 0 });
  return contest!.id;
}

async function join(db: Db, contestId: number, userId: number, virtual: number): Promise<number> {
  const [row] = await db
    .insert(contestParticipations)
    .values({ contestId, userId, virtual, startTime: new Date(Date.now() - 90 * MINUTE) })
    .returning({ id: contestParticipations.id });
  return row!.id;
}

describe('PATCH /contests/:key/participants/:username', () => {
  it('lets the creator disqualify and reinstate, and moves every attempt together', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const owner = await insertUser(db, 'dq-owner');
      const cheat = await insertUser(db, 'dq-cheat');
      const problem = await seedProblemWithSourceAccess(db, { code: 'dq-p' });
      const contestId = await seedContest(db, 'dq-open', owner.id, problem.id);
      await join(db, contestId, cheat.id, 0);
      await join(db, contestId, cheat.id, 1);

      const service = new ContestAccessService(db, uncachedScoreboards());
      // Mixed case on purpose: usernames resolve case-insensitively
      // everywhere else, and this route must not be the exception.
      const dq = await service.setDisqualified(actorFor(owner.id), 'dq-open', 'DQ-Cheat', true);
      expect(dq.isDisqualified).toBe(true);
      // The summary is the highest `virtual` — the same one GET /me answers.
      expect(dq.virtual).toBe(1);

      const rows = await db
        .select({ isDisqualified: contestParticipations.isDisqualified })
        .from(contestParticipations)
        .where(
          and(
            eq(contestParticipations.contestId, contestId),
            eq(contestParticipations.userId, cheat.id),
          ),
        );
      expect(rows.map((row) => row.isDisqualified)).toEqual([true, true]);

      const back = await service.setDisqualified(actorFor(owner.id), 'dq-open', 'dq-cheat', false);
      expect(back.isDisqualified).toBe(false);
    });
  }, 120_000);

  it('a global admin may do it; an unrelated signed-in user gets 403 contest_forbidden', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const owner = await insertUser(db, 'dq2-owner');
      const admin = await insertUser(db, 'dq2-admin', 'admin');
      const bystander = await insertUser(db, 'dq2-bystander');
      const cheat = await insertUser(db, 'dq2-cheat');
      const problem = await seedProblemWithSourceAccess(db, { code: 'dq2-p' });
      const contestId = await seedContest(db, 'dq2-open', owner.id, problem.id);
      await join(db, contestId, cheat.id, 0);
      const service = new ContestAccessService(db, uncachedScoreboards());

      expect(
        (await service.setDisqualified(actorFor(admin.id, 'admin'), 'dq2-open', 'dq2-cheat', true))
          .isDisqualified,
      ).toBe(true);

      await expect(
        service.setDisqualified(actorFor(bystander.id), 'dq2-open', 'dq2-cheat', false),
      ).rejects.toMatchObject({ status: 403, code: 'contest_forbidden' });
    });
  }, 120_000);

  it('a contest the caller may not see 404s, and never 403s', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const owner = await insertUser(db, 'dq3-owner');
      const outsider = await insertUser(db, 'dq3-outsider');
      const cheat = await insertUser(db, 'dq3-cheat');
      const problem = await seedProblemWithSourceAccess(db, { code: 'dq3-p' });
      const contestId = await seedContest(db, 'dq3-secret', owner.id, problem.id);
      await db
        .update(contests)
        .set({ visibility: 'private' })
        .where(eq(contests.id, contestId));
      await join(db, contestId, cheat.id, 0);

      await expect(
        new ContestAccessService(db, uncachedScoreboards()).setDisqualified(
          actorFor(outsider.id),
          'dq3-secret',
          'dq3-cheat',
          true,
        ),
      ).rejects.toMatchObject({ status: 404, code: 'contest_not_found' });
    });
  }, 120_000);

  it('404s an unknown user and one who never joined', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const owner = await insertUser(db, 'dq4-owner');
      await insertUser(db, 'dq4-stranger');
      const problem = await seedProblemWithSourceAccess(db, { code: 'dq4-p' });
      await seedContest(db, 'dq4-open', owner.id, problem.id);
      const service = new ContestAccessService(db, uncachedScoreboards());

      await expect(
        service.setDisqualified(actorFor(owner.id), 'dq4-open', 'nobody', true),
      ).rejects.toMatchObject({ status: 404, code: 'user_not_found' });
      await expect(
        service.setDisqualified(actorFor(owner.id), 'dq4-open', 'dq4-stranger', true),
      ).rejects.toMatchObject({ status: 404, code: 'participation_not_found' });
    });
  }, 120_000);

  it('is reachable over HTTP, and GET /contests/:key tells the client who may use it', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const problem = await seedProblemWithSourceAccess(db, { code: 'dq5-p' });
        const ownerAgent = request.agent(app.getHttpServer());
        await registerAndLogin(ownerAgent, 'dq5-owner');
        const otherAgent = request.agent(app.getHttpServer());
        await registerAndLogin(otherAgent, 'dq5-other');
        const contestId = await seedContest(
          db,
          'dq5-open',
          await userIdOf(db, 'dq5-owner'),
          problem.id,
        );
        await join(db, contestId, await userIdOf(db, 'dq5-other'), 0);

        const asOwner = await ownerAgent.get('/contests/dq5-open');
        expect(asOwner.body.canEdit).toBe(true);
        const asOther = await otherAgent.get('/contests/dq5-open');
        expect(asOther.body.canEdit).toBe(false);

        const ok = await ownerAgent
          .patch('/contests/dq5-open/participants/dq5-other')
          .send({ disqualified: true });
        expect(ok.status).toBe(200);
        expect(ok.body.isDisqualified).toBe(true);

        const denied = await otherAgent
          .patch('/contests/dq5-open/participants/dq5-other')
          .send({ disqualified: false });
        expect([denied.status, denied.body.code]).toEqual([403, 'contest_forbidden']);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('what disqualification does to the standings', () => {
  it('ranks a disqualified leader below everyone else, and keeps the row', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const owner = await insertUser(db, 'dqs-owner');
      const leader = await insertUser(db, 'dqs-leader');
      const runnerUp = await insertUser(db, 'dqs-runner');
      const problem = await seedProblemWithSourceAccess(db, { code: 'dqs-p' });
      const contestId = await seedContest(db, 'dqs-open', owner.id, problem.id);
      await join(db, contestId, leader.id, 0);
      await join(db, contestId, runnerUp.id, 0);

      const service = new ContestAccessService(db, uncachedScoreboards());
      const before = await service.getScoreboard(actorFor(owner.id), 'dqs-open');
      expect(before.ranking.map((row) => row.participant)).toEqual(['dqs-leader', 'dqs-runner']);

      await service.setDisqualified(actorFor(owner.id), 'dqs-open', 'dqs-leader', true);

      const after = await service.getScoreboard(actorFor(owner.id), 'dqs-open');
      // Still on the board — the page renders it struck through — but last.
      expect(after.ranking.map((row) => row.participant)).toEqual(['dqs-runner', 'dqs-leader']);
      expect(after.ranking.map((row) => row.is_disqualified)).toEqual([false, true]);
    });
  }, 120_000);

  it('the lowering carries the flag through, and the format sorts on it first', () => {
    // Unit-level, over the formats' own input shape: the same fixture with
    // one flag flipped. `lower()` is what reads `is_disqualified` off the
    // input (defaulting it to `false`); drop that and the top scorer stays
    // top, whatever the organisers decided.
    const input = contestOf('u', [100, 0]);

    const clean = computeContestScoreboard(structuredClone(input));
    expect(clean.ranking.map((row) => row.participant)).toEqual(['u-p0', 'u-p1']);

    const dirty = structuredClone(input);
    dirty.participants[0]!.is_disqualified = true;
    const dqBoard = computeContestScoreboard(dirty);
    expect(dqBoard.ranking.map((row) => row.participant)).toEqual(['u-p1', 'u-p0']);
    expect(dqBoard.ranking.map((row) => row.is_disqualified)).toEqual([false, true]);
  });
});

describe('a disqualified participant is not in the rated field', () => {
  it('earns no rating event, and the field stays big enough to rate', async () => {
    await withTestDb(async (db) => {
      // Nine, so that removing one still clears `MIN_RATED_PARTICIPANTS` (8)
      // — otherwise "no event for the cheat" would be indistinguishable from
      // "the contest stopped being ratable at all".
      const scores = [100, 90, 80, 70, 60, 50, 40, 30, 20];
      await seedGoldenContest(db, contestOf('dqr', scores));
      await db.update(contests).set({ isRated: true }).where(eq(contests.key, 'dqr'));
      const admin = await insertUser(db, 'dqr-admin', 'admin');
      const rating = new RatingService(db, new ContestAccessService(db, uncachedScoreboards()));

      expect(await rating.replayAll()).toBe(1);
      const before = await db
        .select({ userId: ratingEvents.userId })
        .from(ratingEvents);
      expect(before).toHaveLength(9);

      // The leader is disqualified after the fact — D4's whole point.
      await new ContestAccessService(db, uncachedScoreboards()).setDisqualified(
        actorFor(admin.id, 'admin'),
        'dqr',
        'dqr-p0',
        true,
      );
      await rating.replayAll();

      const [cheat] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.username, 'dqr-p0'));
      const after = await db.select({ userId: ratingEvents.userId }).from(ratingEvents);
      expect(after).toHaveLength(8);
      expect(after.map((row) => row.userId)).not.toContain(cheat!.id);
    });
  }, 120_000);
});
