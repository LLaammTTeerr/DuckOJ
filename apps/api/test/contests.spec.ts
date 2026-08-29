/**
 * Everything about contests that the golden replay does not cover: the two
 * write-time refusals design §6 names, the visibility rules of §5, and the
 * shape the HTTP layer actually serves.
 *
 * The replay (`contest-golden-replay.spec.ts`) is the acceptance criterion and
 * proves the *mapping*. This file proves the surface around it.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import { contestOrgs, contestProblems, contests, orgMembers, organizations, problems } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { ContestDetail, ContestPage, Scoreboard } from '@duckoj/contracts';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { insertUser, registerAndLogin } from './submissions.fixtures.js';
import { discoverFixtures, readContest, seedGoldenContest } from './contest-golden.fixtures.js';

const VALID = {
  key: 'spring-open',
  name: 'Spring Open',
  startTime: '2026-03-01T09:00:00.000Z',
  endTime: '2026-03-01T14:00:00.000Z',
  format: 'icpc',
};

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

async function seedContest(
  db: Db,
  opts: { key: string; visibility: 'private' | 'org' | 'public'; createdBy: number; orgId?: number },
): Promise<number> {
  const [contest] = await db
    .insert(contests)
    .values({
      key: opts.key,
      name: opts.key,
      startTime: new Date('2026-03-01T09:00:00Z'),
      endTime: new Date('2026-03-01T14:00:00Z'),
      format: 'icpc',
      visibility: opts.visibility,
      createdBy: opts.createdBy,
    })
    .returning({ id: contests.id });
  if (opts.orgId !== undefined) {
    await db.insert(contestOrgs).values({ contestId: contest!.id, orgId: opts.orgId });
  }
  return contest!.id;
}

describe('POST /contests refuses what it cannot honour', () => {
  it('refuses an unknown format with unknown_contest_format, and stores nothing', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await setterAgent(app, db, 'format-setter');
        const res = await agent.post('/contests').send({ ...VALID, format: 'atcoder' });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('unknown_contest_format');
        expect(res.body.detail).toContain('default, icpc, ioi, ioi16');
        expect(await db.select().from(contests)).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('accepts every format the registry knows', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await setterAgent(app, db, 'all-formats-setter');
        for (const format of ['default', 'icpc', 'ioi', 'ioi16']) {
          const res = await agent.post('/contests').send({ ...VALID, key: `k-${format}`, format });
          expect([format, res.status]).toEqual([format, 201]);
          expect(ContestDetail.parse(res.body).format).toBe(format);
        }
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses a plain user, and 401s an anonymous caller', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'plain-user');
        const asUser = await agent.post('/contests').send(VALID);
        expect(asUser.status).toBe(403);
        expect(asUser.body.code).toBe('contest_forbidden');

        const anon = await request(app.getHttpServer()).post('/contests').send(VALID);
        expect(anon.status).toBe(401);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses a duplicate key case-insensitively', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await setterAgent(app, db, 'dupe-setter');
        expect((await agent.post('/contests').send(VALID)).status).toBe(201);
        const again = await agent.post('/contests').send({ ...VALID, key: 'SPRING-OPEN'.toLowerCase() });
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('contest_key_taken');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('contest visibility mirrors problems: 404, never 403', () => {
  it('an anonymous caller lists only public contests and 404s a private one', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await insertUser(db, 'contest-owner');
        await seedContest(db, { key: 'pub', visibility: 'public', createdBy: owner.id });
        await seedContest(db, { key: 'priv', visibility: 'private', createdBy: owner.id });

        const list = await request(app.getHttpServer()).get('/contests');
        expect(list.status).toBe(200);
        expect(ContestPage.parse(list.body).items.map((c) => c.key)).toEqual(['pub']);

        const hidden = await request(app.getHttpServer()).get('/contests/priv');
        // 404 and not 403: a distinct status is an existence oracle for a
        // contest the caller may not see.
        expect(hidden.status).toBe(404);
        expect(hidden.body.code).toBe('contest_not_found');

        const board = await request(app.getHttpServer()).get('/contests/priv/scoreboard');
        expect(board.status).toBe(404);
        expect(board.body.code).toBe('contest_not_found');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it("the creator sees their own private contest; an unrelated user does not", async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const creatorAgent = await setterAgent(app, db, 'creator');
        const created = await creatorAgent.post('/contests').send({ ...VALID, visibility: 'private' });
        expect(created.status).toBe(201);

        const mine = await creatorAgent.get('/contests/spring-open');
        expect(mine.status).toBe(200);
        expect(ContestPage.parse((await creatorAgent.get('/contests')).body).items).toHaveLength(1);

        const otherAgent = request.agent(app.getHttpServer());
        await registerAndLogin(otherAgent, 'someone-else');
        expect((await otherAgent.get('/contests/spring-open')).status).toBe(404);
        expect(ContestPage.parse((await otherAgent.get('/contests')).body).items).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('an org-visible contest is visible to a member of a shared org and to nobody else', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await insertUser(db, 'org-contest-owner');
        const [org] = await db
          .insert(organizations)
          .values({ slug: 'acme', name: 'Acme' })
          .returning({ id: organizations.id });
        await seedContest(db, { key: 'org-only', visibility: 'org', createdBy: owner.id, orgId: org!.id });

        const memberAgent = request.agent(app.getHttpServer());
        await registerAndLogin(memberAgent, 'org-member');
        const [member] = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.username, 'org-member'));
        await db.insert(orgMembers).values({ orgId: org!.id, userId: member!.id });

        const outsiderAgent = request.agent(app.getHttpServer());
        await registerAndLogin(outsiderAgent, 'org-outsider');

        expect((await memberAgent.get('/contests/org-only')).status).toBe(200);
        expect(ContestPage.parse((await memberAgent.get('/contests')).body).items).toHaveLength(1);
        expect((await outsiderAgent.get('/contests/org-only')).status).toBe(404);
        expect(ContestPage.parse((await outsiderAgent.get('/contests')).body).items).toHaveLength(0);
        expect((await request(app.getHttpServer()).get('/contests/org-only')).status).toBe(404);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('an admin sees a private contest they did not create', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await insertUser(db, 'admin-test-owner');
        await seedContest(db, { key: 'secret', visibility: 'private', createdBy: owner.id });
        const adminAgent = request.agent(app.getHttpServer());
        await registerAndLogin(adminAgent, 'contest-admin');
        await db
          .update(schema.users)
          .set({ globalRole: 'admin' })
          .where(eq(schema.users.username, 'contest-admin'));

        expect((await adminAgent.get('/contests/secret')).status).toBe(200);
        expect(ContestPage.parse((await adminAgent.get('/contests')).body).items).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('GET /contests/:key/scoreboard over HTTP', () => {
  /**
   * One golden served end to end, through the guards, the controller and JSON
   * serialisation — the replay calls the service directly, so this is what
   * pins that the wire shape survives the trip. `ioi16/10` on purpose: it is
   * the fixture that separates `contest_problems.points` from the problem's
   * own dataset total (design §7).
   */
  it('serves the ioi16/10 golden, and it parses against the contract', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const fixture = discoverFixtures().find((f) => f.id === 'ioi16/10-points-scaling-factor')!;
        const { key } = await seedGoldenContest(db, readContest(fixture));

        const res = await request(app.getHttpServer()).get(`/contests/${key}/scoreboard`);
        expect(res.status).toBe(200);

        // The contract's hand-written zod is a second, independent statement
        // of the goldens' shape; parsing here is what stops it drifting from
        // what the formats actually emit.
        const board = Scoreboard.parse(res.body);
        // 200 / 100 and 100 / 3: `contest_problems.points` over the problem's
        // own dataset total, which is the whole point of §7. Full precision,
        // not the golden's 9-place normalisation — that normalisation belongs
        // to the *comparison* the replay does, never to what the API serves.
        expect(board.problems.map((p) => p.points_scaling_factor)).toEqual([2, 100 / 3]);
        expect(board.ranking.map((r) => [r.participant, r.score])).toEqual([
          ['alice', 266.667],
          ['bob', 180],
        ]);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('a contest conceals its problems until it starts', () => {
  const HOUR = 60 * 60 * 1000;

  /** A private problem whose code and name must never reach a pre-start viewer. */
  async function seedProbeProblem(db: Db, ownerId: number): Promise<number> {
    const [problem] = await db
      .insert(problems)
      .values({
        code: 'zz-leak-probe',
        name: 'Secret Leak Probe',
        statement: 's',
        visibility: 'private',
        createdBy: ownerId,
      })
      .returning({ id: problems.id });
    return problem!.id;
  }

  /** A public contest whose window is relative to now, with one attached problem. */
  async function seedTimedContest(
    db: Db,
    opts: { key: string; startsInMs: number; createdBy: number; problemId: number },
  ): Promise<void> {
    const now = Date.now();
    const [contest] = await db
      .insert(contests)
      .values({
        key: opts.key,
        name: opts.key,
        startTime: new Date(now + opts.startsInMs),
        endTime: new Date(now + opts.startsInMs + HOUR),
        format: 'icpc',
        visibility: 'public',
        createdBy: opts.createdBy,
      })
      .returning({ id: contests.id });
    await db.insert(contestProblems).values({
      contestId: contest!.id,
      problemId: opts.problemId,
      label: 'A',
      points: 100,
      order: 0,
    });
  }

  it('pre-start, an anonymous detail read gets an empty problems array and no trace of a private problem', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await insertUser(db, 'leak-owner');
        const problemId = await seedProbeProblem(db, owner.id);
        await seedTimedContest(db, { key: 'future-pub', startsInMs: HOUR, createdBy: owner.id, problemId });

        const res = await request(app.getHttpServer()).get('/contests/future-pub');
        expect(res.status).toBe(200);
        expect(ContestDetail.parse(res.body).problems).toEqual([]);
        // The private problem's existence must appear NOWHERE in the body —
        // GET /problems/zz-leak-probe 404s this caller, and the contest must
        // not become the side channel that undoes that.
        const raw = JSON.stringify(res.body);
        expect(raw).not.toContain('zz-leak-probe');
        expect(raw).not.toContain('Secret Leak Probe');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('pre-start, a global admin still sees the problems', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await insertUser(db, 'leak-admin-owner');
        const problemId = await seedProbeProblem(db, owner.id);
        await seedTimedContest(db, { key: 'future-adm', startsInMs: HOUR, createdBy: owner.id, problemId });

        const adminAgent = request.agent(app.getHttpServer());
        await registerAndLogin(adminAgent, 'prestart-admin');
        await db
          .update(schema.users)
          .set({ globalRole: 'admin' })
          .where(eq(schema.users.username, 'prestart-admin'));

        const res = await adminAgent.get('/contests/future-adm');
        expect(res.status).toBe(200);
        expect(ContestDetail.parse(res.body).problems.map((p) => p.code)).toEqual(['zz-leak-probe']);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('pre-start, an anonymous scoreboard read is 409 contest_not_started; post-start it serves', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await insertUser(db, 'leak-board-owner');
        const problemId = await seedProbeProblem(db, owner.id);
        await seedTimedContest(db, { key: 'future-board', startsInMs: HOUR, createdBy: owner.id, problemId });
        await seedTimedContest(db, { key: 'past-board', startsInMs: -HOUR, createdBy: owner.id, problemId });

        const before = await request(app.getHttpServer()).get('/contests/future-board/scoreboard');
        expect(before.status).toBe(409);
        expect(before.body.code).toBe('contest_not_started');
        const raw = JSON.stringify(before.body);
        expect(raw).not.toContain('zz-leak-probe');
        expect(raw).not.toContain('Secret Leak Probe');

        const after = await request(app.getHttpServer()).get('/contests/past-board/scoreboard');
        expect(after.status).toBe(200);
        expect(Scoreboard.parse(after.body).problems.map((p) => p.code)).toEqual(['zz-leak-probe']);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('post-start, an anonymous detail read still gets the problems (regression guard)', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await insertUser(db, 'leak-started-owner');
        const problemId = await seedProbeProblem(db, owner.id);
        await seedTimedContest(db, { key: 'started-pub', startsInMs: -HOUR, createdBy: owner.id, problemId });

        const res = await request(app.getHttpServer()).get('/contests/started-pub');
        expect(res.status).toBe(200);
        expect(ContestDetail.parse(res.body).problems.map((p) => p.code)).toEqual(['zz-leak-probe']);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
