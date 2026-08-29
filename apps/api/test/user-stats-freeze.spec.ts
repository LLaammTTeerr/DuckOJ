/**
 * M1 — `GET /users/{username}`'s `solvedCount` and `points` must respect the
 * freeze (D22/D23).
 *
 * D23 named this leak in its own "Out of scope, deliberately" clause: the
 * profile counts a user's distinct ACs over public problems with no contest
 * awareness at all, so a competitor polling `/users/rival` every ten seconds
 * reads `solvedCount` tick 3→4 and knows the rival just got an AC — strictly
 * more than the frozen board's `pending` count discloses, which says only that
 * an attempt exists.
 *
 * `submissionCount` is deliberately NOT filtered: "somebody submitted" is
 * exactly what the board's `pending` already announces (D23), and hiding it
 * would make the count disagree with the submission list, which still lists
 * every frozen row.
 *
 * No clock is injected — contests are seeded relative to `Date.now()`, the
 * convention `contest-freeze.spec.ts` and `submission-freeze.spec.ts` share.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  contestParticipations,
  contestProblems,
  contestSubmissions,
  contests,
  submissions,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { UserAccessService } from '../src/authz/user.access.js';
import type { Actor } from '../src/authz/actor.js';
import { withTestDb } from './db.harness.js';
import {
  insertUser,
  seedProblemAndLanguage,
  seedProblemWithSourceAccess,
} from './submissions.fixtures.js';

const MINUTE = 60_000;

function actorFor(userId: number, globalRole: Actor['globalRole'] = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

interface Seeded {
  rivalId: number;
  organizerId: number;
  bystanderId: number;
}

/**
 * One public contest on one public problem, with `rival` holding a single
 * graded AC placed `submissionOffsetMs` from now. `contestEndInMs` decides
 * whether the wall clock is inside the freeze window or past it.
 */
async function seedContestAc(
  db: Db,
  opts: { key: string; contestEndInMs: number; submissionOffsetMs: number },
): Promise<Seeded> {
  await seedProblemAndLanguage(db);
  const endMs = Date.now() + opts.contestEndInMs;
  const startMs = endMs - 60 * MINUTE;

  const organizer = await insertUser(db, `${opts.key}-org`);
  const rival = await insertUser(db, `${opts.key}-rival`);
  const bystander = await insertUser(db, `${opts.key}-bystander`);
  const problem = await seedProblemWithSourceAccess(db, { code: `${opts.key}-p` });

  const [contest] = await db
    .insert(contests)
    .values({
      key: opts.key,
      name: opts.key,
      startTime: new Date(startMs),
      endTime: new Date(endMs),
      format: 'default',
      frozenLastMinutes: 20,
      visibility: 'public',
      createdBy: organizer.id,
    })
    .returning({ id: contests.id });
  const [contestProblem] = await db
    .insert(contestProblems)
    .values({
      contestId: contest!.id,
      problemId: problem.id,
      label: 'A',
      points: 100,
      partial: false,
      order: 0,
    })
    .returning({ id: contestProblems.id });
  const [participation] = await db
    .insert(contestParticipations)
    .values({ contestId: contest!.id, userId: rival.id, startTime: new Date(startMs), virtual: 0 })
    .returning({ id: contestParticipations.id });

  const [language] = await db
    .select({ id: schema.languages.id })
    .from(schema.languages)
    .where(eq(schema.languages.key, 'cpp17'));
  const at = new Date(Date.now() + opts.submissionOffsetMs);
  const [row] = await db
    .insert(submissions)
    .values({
      userId: rival.id,
      problemId: problem.id,
      revisionId: problem.revisionId,
      languageId: language!.id,
      source: 'int main(){}',
      state: 'done',
      verdict: 'AC',
      points: 100,
      maxPoints: 100,
      createdAt: at,
      judgedAt: at,
    })
    .returning({ id: submissions.id });
  await db.insert(contestSubmissions).values({
    participationId: participation!.id,
    contestProblemId: contestProblem!.id,
    submissionId: row!.id,
  });

  return { rivalId: rival.id, organizerId: organizer.id, bystanderId: bystander.id };
}

describe("a profile's stats during a freeze", () => {
  it('hides a frozen AC from a rival, from an anonymous poller, and from nobody else', async () => {
    await withTestDb(async (db) => {
      // The contest ends in ten minutes and freezes for the last twenty, so
      // `now` is inside the window; the AC was made five minutes ago, i.e.
      // after the freeze instant.
      const seeded = await seedContestAc(db, {
        key: 'usf1',
        contestEndInMs: 10 * MINUTE,
        submissionOffsetMs: -5 * MINUTE,
      });
      const users = new UserAccessService(db);

      const toRival = await users.getByUsername('usf1-rival', actorFor(seeded.bystanderId));
      expect(toRival.stats).toEqual({ submissionCount: 1, solvedCount: 0, points: 0 });

      // Anonymous is the same viewer, with even less standing.
      const toAnonymous = await users.getByUsername('usf1-rival', null);
      expect(toAnonymous.stats).toEqual({ submissionCount: 1, solvedCount: 0, points: 0 });

      // The three viewers the freeze never applies to.
      const live = { submissionCount: 1, solvedCount: 1, points: 100 };
      expect((await users.getByUsername('usf1-rival', actorFor(seeded.rivalId))).stats).toEqual(live);
      expect(
        (await users.getByUsername('usf1-rival', actorFor(seeded.organizerId))).stats,
      ).toEqual(live);
      expect(
        (await users.getByUsername('usf1-rival', actorFor(seeded.bystanderId, 'admin'))).stats,
      ).toEqual(live);
    });
  }, 120_000);

  it('reveals it to everyone once the participation window has closed', async () => {
    await withTestDb(async (db) => {
      // The contest ended a minute ago: nothing is frozen any more.
      const seeded = await seedContestAc(db, {
        key: 'usf2',
        contestEndInMs: -MINUTE,
        submissionOffsetMs: -5 * MINUTE,
      });
      const users = new UserAccessService(db);

      const stats = (await users.getByUsername('usf2-rival', actorFor(seeded.bystanderId))).stats;
      expect(stats).toEqual({ submissionCount: 1, solvedCount: 1, points: 100 });
    });
  }, 120_000);

  it('leaves a submission made BEFORE the freeze instant counted', async () => {
    await withTestDb(async (db) => {
      // Inside the window (ends in ten minutes, freezes for twenty), but the
      // AC is fifty minutes old — before the freeze instant, so the board
      // published it and so does the profile.
      const seeded = await seedContestAc(db, {
        key: 'usf3',
        contestEndInMs: 10 * MINUTE,
        submissionOffsetMs: -50 * MINUTE,
      });
      const users = new UserAccessService(db);

      const stats = (await users.getByUsername('usf3-rival', actorFor(seeded.bystanderId))).stats;
      expect(stats).toEqual({ submissionCount: 1, solvedCount: 1, points: 100 });
    });
  }, 120_000);
});
