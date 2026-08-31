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
import {
  contestClarifications,
  contestOrgs,
  contestParticipations,
  contestProblems,
  contests,
  organizations,
  problems,
  teamMembers,
  teams,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { Clarification, ClarificationList } from '@duckoj/contracts';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { insertUser, registerAndLogin, seedProblemAndLanguage, userIdOf } from './submissions.fixtures.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import type { Actor } from '../src/authz/actor.js';
import {
  FEED_CAP,
  NOTIFY_CAP,
  broadcastRecipients,
  broadcastRecipientsQuery,
} from '../src/authz/contest.clarifications.js';

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
          .post('/api/v1/contests/clar-a/clarifications')
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

        const mine = await asker.get('/api/v1/contests/clar-a/clarifications');
        expect(ClarificationList.parse(mine.body).items).toHaveLength(1);

        // The rival sees nothing: a private question belongs to its asker
        // and the organisers, and to nobody else in the room.
        const theirs = await rival.get('/api/v1/contests/clar-a/clarifications');
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
          .post('/api/v1/contests/clar-open/clarifications')
          .send({ question: 'Anyone home?' });
        expect(notJoined.status).toBe(403);
        expect(notJoined.body.code).toBe('contest_not_joined');

        // Not 403: a contest this caller may not see must not confirm it
        // exists, which is the whole of the 404-over-403 rule.
        const hidden = await outsider
          .post('/api/v1/contests/clar-secret/clarifications')
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
          .post('/api/v1/contests/clar-p/clarifications')
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
            .post('/api/v1/contests/clar-rl/clarifications')
            .send({ question: `question ${String(i)}` });
          expect(ok.status).toBe(201);
        }
        const refused = await asker
          .post('/api/v1/contests/clar-rl/clarifications')
          .send({ question: 'one too many' });
        expect(refused.status).toBe(429);
        expect(refused.body.code).toBe('clarification_rate_limited');

        // Per CONTEST, not per user: the same person asking in a different
        // room starts with a fresh window.
        const elsewhere = await asker
          .post('/api/v1/contests/clar-rl2/clarifications')
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
          .post('/api/v1/contests/clar-ans/clarifications')
          .send({ question: 'Is N up to 1e9?' });
        const id = (asked.body as { id: number }).id;

        // A participant cannot answer their own question into existence.
        const usurped = await asker
          .patch(`/api/v1/contests/clar-ans/clarifications/${String(id)}`)
          .send({ answer: 'Yes, obviously.' });
        expect(usurped.status).toBe(403);
        expect(usurped.body.code).toBe('contest_forbidden');

        const answered = await organiserAgent
          .patch(`/api/v1/contests/clar-ans/clarifications/${String(id)}`)
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
          .patch(`/api/v1/contests/clar-ans/clarifications/${String(id)}`)
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
          .patch(`/api/v1/contests/clar-ans/clarifications/${String(id)}`)
          .send({ answer: 'Yes, N is at most 10^9.' });
        expect((await feedOf(db, bystander.id)).items).toHaveLength(1);
        expect((await feedOf(db, askerId)).items).toHaveLength(1);

        // Public now, so the bystander can read it.
        const theirs = await request
          .agent(app.getHttpServer())
          .get('/api/v1/contests/clar-ans/clarifications');
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
        const asked = await asker.post('/api/v1/contests/clar-here/clarifications').send({ question: 'Q?' });
        const id = (asked.body as { id: number }).id;

        const res = await organiser
          .patch(`/api/v1/contests/clar-there/clarifications/${String(id)}`)
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
          .post('/api/v1/contests/ann-cup/announcements')
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
        const anon = await request.agent(app.getHttpServer()).get('/api/v1/contests/ann-cup/clarifications');
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

        const res = await student.post('/api/v1/contests/ann-cup2/announcements').send({ text: 'I am in charge now.' });
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
        const asked = await asker.post('/api/v1/contests/ann-admin/clarifications').send({ question: 'Q?' });

        const answered = await adminAgent
          .patch(`/api/v1/contests/ann-admin/clarifications/${String((asked.body as { id: number }).id)}`)
          .send({ answer: 'A.', visibility: 'public' });
        expect(answered.status).toBe(200);
        const announced = await adminAgent
          .post('/api/v1/contests/ann-admin/announcements')
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
          .post('/api/v1/contests/ann-p/announcements')
          .send({ problemCode: problem!.code, text: 'Sample 2 was wrong; fixed.' });
        expect(posted.status).toBe(201);
        expect(Clarification.parse(posted.body).problemCode).toBe(problem!.code);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('the pre-start problem-list concealment', () => {
  it("withholds an announcement's problemCode until the contest starts", async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const organiser = await agentFor(app, 'pre-boss');
        const organiserId = await userIdOf(db, 'pre-boss');
        // Tomorrow. `getVisible` serves `problems: []` for a contest in this
        // state and the scoreboard 409s, both because "a private problem
        // attached to a tomorrow-starting public contest must not leak its
        // code and name". The feed is the third door onto the same list.
        const [contest] = await db
          .insert(contests)
          .values({
            key: 'pre-c',
            name: 'pre-c',
            startTime: new Date(Date.now() + 24 * 60 * 60_000),
            endTime: new Date(Date.now() + 27 * 60 * 60_000),
            format: 'icpc',
            visibility: 'public',
            createdBy: organiserId,
          })
          .returning({ id: contests.id });
        const [problem] = await db
          .select({ id: problems.id, code: problems.code })
          .from(problems)
          .limit(1);
        await db
          .insert(contestProblems)
          .values({ contestId: contest!.id, problemId: problem!.id, label: 'A', points: 100, order: 0 });

        const posted = await organiser
          .post('/api/v1/contests/pre-c/announcements')
          .send({ problemCode: problem!.code, text: 'The English statement lands at 08:00.' });
        expect(posted.status).toBe(201);

        // The detail route already conceals the list; the feed must agree.
        const concealed = await request(app.getHttpServer()).get('/api/v1/contests/pre-c');
        expect(concealed.body.problems).toEqual([]);

        const anon = await request(app.getHttpServer()).get('/api/v1/contests/pre-c/clarifications');
        expect(anon.status).toBe(200);
        const items = ClarificationList.parse(anon.body).items;
        expect(items).toHaveLength(1);
        // The text is public; which problem it is about is not, yet.
        expect(items[0]!.answer).toContain('English statement');
        expect(items[0]!.problemCode).toBeNull();

        // The organiser, who chose the problems, still sees it.
        const mine = await organiser.get('/api/v1/contests/pre-c/clarifications');
        expect(ClarificationList.parse(mine.body).items[0]!.problemCode).toBe(problem!.code);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('reveals it once the contest has started', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const organiser = await agentFor(app, 'post-boss');
        const organiserId = await userIdOf(db, 'post-boss');
        const contestId = await seedContest(db, { key: 'post-c', createdBy: organiserId });
        const [problem] = await db
          .select({ id: problems.id, code: problems.code })
          .from(problems)
          .limit(1);
        await db
          .insert(contestProblems)
          .values({ contestId, problemId: problem!.id, label: 'A', points: 100, order: 0 });
        await organiser
          .post('/api/v1/contests/post-c/announcements')
          .send({ problemCode: problem!.code, text: 'Sample 2 was wrong; fixed.' });

        const anon = await request(app.getHttpServer()).get('/api/v1/contests/post-c/clarifications');
        expect(ClarificationList.parse(anon.body).items[0]!.problemCode).toBe(problem!.code);
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
          .patch('/api/v1/contests/clar-nan/clarifications/abc')
          .send({ answer: 'A.' });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('clarification_not_found');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

/**
 * The cap was `.limit(NOTIFY_CAP)` with no `ORDER BY` — which is not a cap
 * but a lottery: an over-cap room notified whatever the scan reached first,
 * a different arbitrary subset each time, and nothing said it had happened.
 * B6's closing concern.
 */
describe('broadcastRecipients — the notification cap (D59)', () => {
  it('truncates deterministically, in user-id order, and says so', async () => {
    await withTestDb(async (db) => {
      const organiser = await insertUser(db, 'cap-org');
      const contestId = await seedContest(db, { key: 'cap-cup', createdBy: organiser.id });
      // Joined in DESCENDING id order, so physical (insertion) order is the
      // opposite of the answer: an ascending assertion cannot pass by luck.
      const students = [];
      for (const name of ['cap-e', 'cap-d', 'cap-c', 'cap-b', 'cap-a']) {
        students.push(await insertUser(db, name));
      }
      for (let i = students.length - 1; i >= 0; i -= 1) {
        await join(db, contestId, students[i]!.id);
        // A second, virtual attempt: one person, still one recipient.
        await join(db, contestId, students[i]!.id, 1);
      }
      const ordered = students.map((s) => s.id).sort((a, b) => a - b);

      const capped = await broadcastRecipients(db, contestId, organiser.id, 3);
      expect(capped.userIds).toEqual(ordered.slice(0, 3));
      expect(capped.truncated).toBe(true);

      const whole = await broadcastRecipients(db, contestId, organiser.id, 10);
      expect(whole.userIds).toEqual(ordered);
      // Exactly the cap is NOT truncation — an off-by-one here would log a
      // warning about a room that was fully notified.
      expect((await broadcastRecipients(db, contestId, organiser.id, 5)).truncated).toBe(false);
    });
  }, 120_000);

  it('orders in SQL, not by the planner\'s goodwill', async () => {
    await withTestDb(async (db) => {
      // `SELECT DISTINCT` over a test-sized room is planned as Sort+Unique,
      // which emits ascending order whether or not the clause is there; it
      // is the HashAggregate plan on a real over-cap room that returns an
      // arbitrary subset, and no fixture can summon it. So the clause is
      // asserted where it is unambiguous: in the statement itself.
      const { sql: text } = broadcastRecipientsQuery(db, 1, 2, 3).toSQL();
      expect(text.toLowerCase()).toMatch(/order by/);
    });
  }, 120_000);

  it('leaves the announcer out of their own broadcast, virtual attempts and all', async () => {
    await withTestDb(async (db) => {
      const organiser = await insertUser(db, 'cap-org2');
      const contestId = await seedContest(db, { key: 'cap-cup2', createdBy: organiser.id });
      await join(db, contestId, organiser.id);
      const student = await insertUser(db, 'cap-student');
      await join(db, contestId, student.id);

      const all = await broadcastRecipients(db, contestId, organiser.id, NOTIFY_CAP);
      expect(all.userIds).toEqual([student.id]);
      expect(all.truncated).toBe(false);
    });
  }, 120_000);

  // D99 × D14. A team is ONE participation held by whichever member pressed
  // Join; the row's `user_id` is the captain and the rest of the squad live
  // in `team_members`. A clarification answer or announcement must reach
  // every competitor, so the recipient set is the union of the two ways a
  // person competes here — they hold the row, or they are on the team that
  // holds it — exactly as D101's "participants online" already counts them.
  it('reaches EVERY team member, not just the captain who pressed Join (D99)', async () => {
    await withTestDb(async (db) => {
      const organiser = await insertUser(db, 'cap-team-org');
      const contestId = await seedContest(db, { key: 'cap-team', createdBy: organiser.id });
      await db.update(contests).set({ participationMode: 'team', maxTeamSize: 3 }).where(eq(contests.id, contestId));
      const [org] = await db
        .insert(organizations)
        .values({ slug: 'cap-team-school', name: 'Trường' })
        .returning({ id: organizations.id });
      await db.insert(contestOrgs).values({ contestId, orgId: org!.id });
      const [team] = await db
        .insert(teams)
        .values({ orgId: org!.id, slug: 'doi-1', name: 'Đội 1', createdBy: organiser.id })
        .returning({ id: teams.id });
      const captain = await insertUser(db, 'cap-team-cap');
      const second = await insertUser(db, 'cap-team-b');
      const third = await insertUser(db, 'cap-team-c');
      await db
        .insert(teamMembers)
        .values([captain, second, third].map((u) => ({ teamId: team!.id, userId: u.id })));
      // ONE participation, on the captain's account (D99).
      await db
        .insert(contestParticipations)
        .values({ contestId, userId: captain.id, teamId: team!.id, startTime: new Date(START) });

      const all = await broadcastRecipients(db, contestId, organiser.id, NOTIFY_CAP);
      expect(all.userIds).toEqual([captain.id, second.id, third.id].sort((a, b) => a - b));
    });
  }, 120_000);
});

describe('the feed is bounded (D63)', () => {
  it('serves at most FEED_CAP rows, the newest ones, and says it truncated', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const organiser = await insertUser(db, 'cap-organiser');
        const contestId = await seedContest(db, { key: 'busy', createdBy: organiser.id });
        // One bulk insert: `ask` is metered at 20/user/hour, and the point
        // here is the READ, not the write path that filled the table.
        await db.insert(contestClarifications).values(
          Array.from({ length: FEED_CAP + 5 }, (_, i) => ({
            contestId,
            problemId: null,
            askedBy: organiser.id,
            question: null,
            answer: `announcement ${String(i)}`,
            answeredBy: organiser.id,
            answeredAt: new Date(),
            visibility: 'public' as const,
          })),
        );

        // Anonymous — the `@Public()` shape every spectator's browser polls
        // every 30 seconds while the contest runs.
        const res = await request(app.getHttpServer()).get('/api/v1/contests/busy/clarifications');
        expect(res.status).toBe(200);
        const body = ClarificationList.parse(res.body);
        expect(body.items).toHaveLength(FEED_CAP);
        expect(body.truncated).toBe(true);
        // Newest first, so the cap drops the OLDEST — the rows a reader
        // scrolled past an hour ago, never the announcement just posted.
        expect(body.items[0]!.answer).toBe(`announcement ${String(FEED_CAP + 4)}`);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('says nothing was truncated when nothing was', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const organiser = await insertUser(db, 'small-organiser');
        const contestId = await seedContest(db, { key: 'quiet', createdBy: organiser.id });
        await db.insert(contestClarifications).values({
          contestId,
          problemId: null,
          askedBy: organiser.id,
          question: null,
          answer: 'one notice',
          answeredBy: organiser.id,
          answeredAt: new Date(),
          visibility: 'public',
        });
        const res = await request(app.getHttpServer()).get('/api/v1/contests/quiet/clarifications');
        const body = ClarificationList.parse(res.body);
        expect(body.items).toHaveLength(1);
        expect(body.truncated).toBe(false);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

// D119. A team is ONE entity (D99/D117): a submission its captain made is its
// teammate's to read, and a clarification its member asked — and had answered
// privately, per-team, without publishing to the whole room — must be too.
// The list filter was `askedBy = me`, team-blind, so the notification set
// (which already unions the squad, D99×D14 above) promised the team a reply
// the read endpoint then hid from everyone but the one member who typed it.
describe('a team reads its own private clarifications (D119)', () => {
  it('shows a private answer to the asker’s teammate, and to no rival', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const orgAgent = await agentFor(app, 'd119-org');
        const organiserId = await userIdOf(db, 'd119-org');
        const contestId = await seedContest(db, { key: 'd119', createdBy: organiserId });
        await db
          .update(contests)
          .set({ participationMode: 'team', maxTeamSize: 3 })
          .where(eq(contests.id, contestId));

        const [school] = await db
          .insert(organizations)
          .values({ slug: 'd119-school', name: 'Trường' })
          .returning({ id: organizations.id });
        await db.insert(contestOrgs).values({ contestId, orgId: school!.id });

        const captainAgent = await agentFor(app, 'd119-cap');
        const mateAgent = await agentFor(app, 'd119-mate');
        const rivalAgent = await agentFor(app, 'd119-rival');
        const captainId = await userIdOf(db, 'd119-cap');
        const mateId = await userIdOf(db, 'd119-mate');
        const rivalId = await userIdOf(db, 'd119-rival');

        const [teamA] = await db
          .insert(teams)
          .values({ orgId: school!.id, slug: 'doi-a', name: 'Đội A', createdBy: organiserId })
          .returning({ id: teams.id });
        const [teamB] = await db
          .insert(teams)
          .values({ orgId: school!.id, slug: 'doi-b', name: 'Đội B', createdBy: organiserId })
          .returning({ id: teams.id });
        await db.insert(teamMembers).values([
          { teamId: teamA!.id, userId: captainId },
          { teamId: teamA!.id, userId: mateId },
          { teamId: teamB!.id, userId: rivalId },
        ]);
        // ONE participation per team, on the captain's account (D99).
        await db.insert(contestParticipations).values([
          { contestId, userId: captainId, teamId: teamA!.id, startTime: new Date(START) },
          { contestId, userId: rivalId, teamId: teamB!.id, startTime: new Date(START) },
        ]);

        // The captain asks; the organiser answers PRIVATELY (no publish).
        const asked = await captainAgent
          .post('/api/v1/contests/d119/clarifications')
          .send({ question: 'May our team use the lab printer?' });
        expect(asked.status).toBe(201);
        const clarId = Clarification.parse(asked.body).id;
        const answered = await orgAgent
          .patch(`/api/v1/contests/d119/clarifications/${String(clarId)}`)
          .send({ answer: 'Yes.' });
        expect(answered.status).toBe(200);
        expect(Clarification.parse(answered.body)).toMatchObject({
          answer: 'Yes.',
          visibility: 'private',
        });

        // The teammate — who did not ask — reads the team's own answer.
        const mate = await mateAgent.get('/api/v1/contests/d119/clarifications');
        const mateItems = ClarificationList.parse(mate.body).items;
        expect(mateItems.map((c) => c.id)).toContain(clarId);
        expect(mateItems.find((c) => c.id === clarId)?.answer).toBe('Yes.');

        // A rival on another team still sees nothing private.
        const rival = await rivalAgent.get('/api/v1/contests/d119/clarifications');
        expect(ClarificationList.parse(rival.body).items).toEqual([]);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
