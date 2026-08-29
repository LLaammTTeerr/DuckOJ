/**
 * Contest clarifications and announcements (D31), end to end over HTTP.
 *
 * The negative space is the point, as it was for D14's notification suite:
 * a private question is invisible to another participant, a non-organiser
 * cannot answer or announce, a contest the caller cannot see 404s rather
 * than 403s, an edit to an already-published answer notifies nobody a second
 * time, and a user holding a live participation plus two virtual attempts is
 * notified once, not three times.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import { contestParticipations, contestProblems, contests, problems } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { Clarification, ClarificationList } from '@duckoj/contracts';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { insertUser, registerAndLogin, seedProblemAndLanguage, userIdOf } from './submissions.fixtures.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import type { Actor } from '../src/authz/actor.js';

const START = '2026-03-01T09:00:00Z';
const END = '2026-03-01T14:00:00Z';

function actorFor(userId: number): Actor {
  return { userId, globalRole: 'user', via: 'session', scopes: [] };
}

async function seedContest(
  db: Db,
  opts: { key: string; createdBy: number; visibility?: 'private' | 'public' },
): Promise<number> {
  const [contest] = await db
    .insert(contests)
    .values({
      key: opts.key,
      name: opts.key,
      startTime: new Date(START),
      endTime: new Date(END),
      format: 'icpc',
      visibility: opts.visibility ?? 'public',
      createdBy: opts.createdBy,
    })
    .returning({ id: contests.id });
  return contest!.id;
}

async function join(db: Db, contestId: number, userId: number, virtual = 0): Promise<void> {
  await db
    .insert(contestParticipations)
    .values({ contestId, userId, virtual, startTime: new Date(START) });
}

/** Registers `username` and returns its logged-in agent. */
async function agentFor(app: INestApplication, username: string) {
  const agent = request.agent(app.getHttpServer());
  await registerAndLogin(agent, username);
  return agent;
}

async function feedOf(db: Db, userId: number) {
  return new NotificationsService(db).listFor(actorFor(userId));
}

describe('asking a clarification', () => {
  it('stores a private question the asker can read back and a rival cannot', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const organiser = await insertUser(db, 'clar-org');
        const contestId = await seedContest(db, { key: 'clar-a', createdBy: organiser.id });
        const asker = await agentFor(app, 'clar-asker');
        const rival = await agentFor(app, 'clar-rival');
        await join(db, contestId, await userIdOf(db, 'clar-asker'));
        await join(db, contestId, await userIdOf(db, 'clar-rival'));

        const asked = await asker
          .post('/contests/clar-a/clarifications')
          .send({ question: 'Is the array 1-indexed?' });
        expect(asked.status).toBe(201);
        expect(Clarification.parse(asked.body)).toMatchObject({
          askedBy: 'clar-asker',
          question: 'Is the array 1-indexed?',
          answer: null,
          answeredBy: null,
          visibility: 'private',
          problemCode: null,
        });

        const mine = await asker.get('/contests/clar-a/clarifications');
        expect(ClarificationList.parse(mine.body).items).toHaveLength(1);

        // The rival sees nothing: a private question belongs to its asker
        // and the organisers, and to nobody else in the room.
        const theirs = await rival.get('/contests/clar-a/clarifications');
        expect(ClarificationList.parse(theirs.body).items).toEqual([]);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses a caller who has not joined, and 404s a contest they cannot see', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const organiser = await insertUser(db, 'clar-org2');
        await seedContest(db, { key: 'clar-open', createdBy: organiser.id });
        await seedContest(db, { key: 'clar-secret', createdBy: organiser.id, visibility: 'private' });
        const outsider = await agentFor(app, 'clar-outsider');

        const notJoined = await outsider
          .post('/contests/clar-open/clarifications')
          .send({ question: 'Anyone home?' });
        expect(notJoined.status).toBe(403);
        expect(notJoined.body.code).toBe('contest_not_joined');

        // Not 403: a contest this caller may not see must not confirm it
        // exists, which is the whole of the 404-over-403 rule.
        const hidden = await outsider
          .post('/contests/clar-secret/clarifications')
          .send({ question: 'Anyone home?' });
        expect(hidden.status).toBe(404);
        expect(hidden.body.code).toBe('contest_not_found');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses a problem that is not in this contest, without confirming it exists', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const organiser = await insertUser(db, 'clar-org3');
        const contestId = await seedContest(db, { key: 'clar-p', createdBy: organiser.id });
        const asker = await agentFor(app, 'clar-p-asker');
        await join(db, contestId, await userIdOf(db, 'clar-p-asker'));

        const [problem] = await db.select({ code: problems.code }).from(problems).limit(1);
        const res = await asker
          .post('/contests/clar-p/clarifications')
          .send({ problemCode: problem!.code, question: 'About this one?' });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('problem_not_found');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('rate limits at 20 questions per user per contest per hour', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const organiser = await insertUser(db, 'clar-org4');
        const contestId = await seedContest(db, { key: 'clar-rl', createdBy: organiser.id });
        const other = await seedContest(db, { key: 'clar-rl2', createdBy: organiser.id });
        const asker = await agentFor(app, 'clar-rl-asker');
        const userId = await userIdOf(db, 'clar-rl-asker');
        await join(db, contestId, userId);
        await join(db, other, userId);

        for (let i = 0; i < 20; i++) {
          const ok = await asker
            .post('/contests/clar-rl/clarifications')
            .send({ question: `question ${String(i)}` });
          expect(ok.status).toBe(201);
        }
        const refused = await asker
          .post('/contests/clar-rl/clarifications')
          .send({ question: 'one too many' });
        expect(refused.status).toBe(429);
        expect(refused.body.code).toBe('clarification_rate_limited');

        // Per CONTEST, not per user: the same person asking in a different
        // room starts with a fresh window.
        const elsewhere = await asker
          .post('/contests/clar-rl2/clarifications')
          .send({ question: 'different contest' });
        expect(elsewhere.status).toBe(201);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

describe('answering and publishing', () => {
  it('notifies the asker on the first answer and every participant when it goes public', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const organiserAgent = await agentFor(app, 'clar-boss');
        const organiserId = await userIdOf(db, 'clar-boss');
        const contestId = await seedContest(db, { key: 'clar-ans', createdBy: organiserId });
        const asker = await agentFor(app, 'clar-ans-asker');
        const askerId = await userIdOf(db, 'clar-ans-asker');
        const bystander = await insertUser(db, 'clar-ans-bystander');
        await join(db, contestId, askerId);
        await join(db, contestId, bystander.id);
        // Three participations for one person — one notification, not three.
        await join(db, contestId, bystander.id, 1);
        await join(db, contestId, bystander.id, 2);

        const asked = await asker
          .post('/contests/clar-ans/clarifications')
          .send({ question: 'Is N up to 1e9?' });
        const id = (asked.body as { id: number }).id;

        // A participant cannot answer their own question into existence.
        const usurped = await asker
          .patch(`/contests/clar-ans/clarifications/${String(id)}`)
          .send({ answer: 'Yes, obviously.' });
        expect(usurped.status).toBe(403);
        expect(usurped.body.code).toBe('contest_forbidden');

        const answered = await organiserAgent
          .patch(`/contests/clar-ans/clarifications/${String(id)}`)
          .send({ answer: 'Yes, N is at most 1e9.' });
        expect(answered.status).toBe(200);
        expect(Clarification.parse(answered.body)).toMatchObject({
          answer: 'Yes, N is at most 1e9.',
          answeredBy: 'clar-boss',
          visibility: 'private',
        });

        // Answered but still private: the asker hears, the room does not.
        expect((await feedOf(db, askerId)).items).toMatchObject([
          { kind: 'clarification_answered', payload: { contestKey: 'clar-ans' } },
        ]);
        expect((await feedOf(db, bystander.id)).items).toEqual([]);

        const published = await organiserAgent
          .patch(`/contests/clar-ans/clarifications/${String(id)}`)
          .send({ visibility: 'public' });
        expect(published.status).toBe(200);

        const bystanderFeed = await feedOf(db, bystander.id);
        expect(bystanderFeed.items).toHaveLength(1);
        expect(bystanderFeed.items[0]).toMatchObject({
          kind: 'clarification_published',
          payload: { contestKey: 'clar-ans' },
        });
        // The asker already heard about this row; publishing does not tell
        // them a second time.
        expect((await feedOf(db, askerId)).items).toHaveLength(1);

        // A typo fix on an already-public answer is not news.
        await organiserAgent
          .patch(`/contests/clar-ans/clarifications/${String(id)}`)
          .send({ answer: 'Yes, N is at most 10^9.' });
        expect((await feedOf(db, bystander.id)).items).toHaveLength(1);
        expect((await feedOf(db, askerId)).items).toHaveLength(1);

        // Public now, so the bystander can read it.
        const theirs = await request
          .agent(app.getHttpServer())
          .get('/contests/clar-ans/clarifications');
        expect(ClarificationList.parse(theirs.body).items).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('404s a clarification id that belongs to another contest', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const organiser = await agentFor(app, 'clar-x-boss');
        const organiserId = await userIdOf(db, 'clar-x-boss');
        const here = await seedContest(db, { key: 'clar-here', createdBy: organiserId });
        await seedContest(db, { key: 'clar-there', createdBy: organiserId });
        const asker = await agentFor(app, 'clar-x-asker');
        await join(db, here, await userIdOf(db, 'clar-x-asker'));
        const asked = await asker.post('/contests/clar-here/clarifications').send({ question: 'Q?' });
        const id = (asked.body as { id: number }).id;

        const res = await organiser
          .patch(`/contests/clar-there/clarifications/${String(id)}`)
          .send({ answer: 'A.' });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('clarification_not_found');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('announcements', () => {
  it('an organiser posts one, every participant is notified once, and anyone may read it', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const organiser = await agentFor(app, 'ann-boss');
        const organiserId = await userIdOf(db, 'ann-boss');
        const contestId = await seedContest(db, { key: 'ann-cup', createdBy: organiserId });
        const student = await insertUser(db, 'ann-student');
        await join(db, contestId, student.id);
        await join(db, contestId, student.id, 1);

        const posted = await organiser
          .post('/contests/ann-cup/announcements')
          .send({ text: 'Problem B has been rejudged.' });
        expect(posted.status).toBe(201);
        expect(Clarification.parse(posted.body)).toMatchObject({
          question: null,
          answer: 'Problem B has been rejudged.',
          answeredBy: 'ann-boss',
          askedBy: 'ann-boss',
          visibility: 'public',
        });

        const feed = await feedOf(db, student.id);
        expect(feed.items).toHaveLength(1);
        expect(feed.items[0]).toMatchObject({
          kind: 'contest_announcement',
          payload: { contestKey: 'ann-cup' },
        });

        // Anonymous, on a public contest: an announcement is for spectators too.
        const anon = await request.agent(app.getHttpServer()).get('/contests/ann-cup/clarifications');
        expect(anon.status).toBe(200);
        expect(ClarificationList.parse(anon.body).items).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses a participant who is not an organiser', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const organiser = await insertUser(db, 'ann-boss2');
        const contestId = await seedContest(db, { key: 'ann-cup2', createdBy: organiser.id });
        const student = await agentFor(app, 'ann-student2');
        await join(db, contestId, await userIdOf(db, 'ann-student2'));

        const res = await student.post('/contests/ann-cup2/announcements').send({ text: 'I am in charge now.' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('contest_forbidden');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('an admin who runs nothing may still answer and announce', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const organiser = await insertUser(db, 'ann-owner');
        const contestId = await seedContest(db, { key: 'ann-admin', createdBy: organiser.id });
        const adminAgent = await agentFor(app, 'ann-admin-user');
        await db
          .update(schema.users)
          .set({ globalRole: 'admin' })
          .where(eq(schema.users.username, 'ann-admin-user'));
        const asker = await agentFor(app, 'ann-admin-asker');
        await join(db, contestId, await userIdOf(db, 'ann-admin-asker'));
        const asked = await asker.post('/contests/ann-admin/clarifications').send({ question: 'Q?' });

        const answered = await adminAgent
          .patch(`/contests/ann-admin/clarifications/${String((asked.body as { id: number }).id)}`)
          .send({ answer: 'A.', visibility: 'public' });
        expect(answered.status).toBe(200);
        const announced = await adminAgent
          .post('/contests/ann-admin/announcements')
          .send({ text: 'Ten minutes remaining.' });
        expect(announced.status).toBe(201);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('an announcement may be scoped to a problem in this contest', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const organiser = await agentFor(app, 'ann-p-boss');
        const organiserId = await userIdOf(db, 'ann-p-boss');
        const contestId = await seedContest(db, { key: 'ann-p', createdBy: organiserId });
        const [problem] = await db.select({ id: problems.id, code: problems.code }).from(problems).limit(1);
        await db
          .insert(contestProblems)
          .values({ contestId, problemId: problem!.id, label: 'A', points: 100, order: 0 });

        const posted = await organiser
          .post('/contests/ann-p/announcements')
          .send({ problemCode: problem!.code, text: 'Sample 2 was wrong; fixed.' });
        expect(posted.status).toBe(201);
        expect(Clarification.parse(posted.body).problemCode).toBe(problem!.code);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('a malformed clarification id', () => {
  it('is 404, not a 500 from Postgres refusing NaN as a bigint', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const organiser = await agentFor(app, 'clar-nan-boss');
        await seedContest(db, { key: 'clar-nan', createdBy: await userIdOf(db, 'clar-nan-boss') });

        const res = await organiser
          .patch('/contests/clar-nan/clarifications/abc')
          .send({ answer: 'A.' });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('clarification_not_found');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
