import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema } from '@duckoj/db';
import type { Db } from '@duckoj/db';
import {
  contestClarifications,
  contestOrgs,
  contestParticipations,
  contestProblems,
  contests,
  orgMembers,
  organizations,
} from '@duckoj/db/guarded';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin } from './submissions.fixtures.js';

/**
 * D88 — cloning a contest. Next year's round is the same problems, the same
 * format and the same freeze at a new time; everything that happened IN the
 * old one belongs to the old one.
 */

const HOUR = 3_600_000;

async function setterAgent(
  app: INestApplication,
  db: Db,
  username: string,
): Promise<ReturnType<typeof request.agent>> {
  const agent = request.agent(app.getHttpServer());
  await registerAndLogin(agent, username);
  await db.update(schema.users).set({ globalRole: 'setter' }).where(eq(schema.users.username, username));
  return agent;
}

async function withApp(db: Db, run: (app: INestApplication) => Promise<void>): Promise<void> {
  const app = await buildApp(db);
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

/** An organization the agent's user owns, so it may be bound to a contest. */
async function seedOwnedOrg(db: Db, slug: string, username: string): Promise<void> {
  const [org] = await db
    .insert(organizations)
    .values({ slug, name: `Org ${slug}` })
    .returning({ id: organizations.id });
  const [user] = await db.select().from(schema.users).where(eq(schema.users.username, username));
  await db.insert(orgMembers).values({ orgId: org!.id, userId: user!.id, role: 'owner' });
}

/** A finished contest with two problems, a freeze, org restriction and history. */
async function seedSource(
  agent: ReturnType<typeof request.agent>,
  db: Db,
  key: string,
): Promise<void> {
  for (const code of ['clone-p1', 'clone-p2']) {
    const created = await agent.post('/api/v1/problems').send({ code, name: code, statement: 's' });
    expect(created.status).toBe(201);
  }
  const start = new Date(Date.now() - 5 * HOUR);
  const end = new Date(Date.now() - 4 * HOUR);
  const created = await agent.post('/api/v1/contests').send({
    key,
    name: 'Vòng tỉnh 2026',
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    format: 'ioi16',
    formatConfig: { cumtime: false },
    pointsPrecision: 1,
    frozenLastMinutes: 15,
    timeLimitSeconds: 1800,
    visibility: 'public',
    orgSlugs: ['truong-a'],
    problems: [
      { code: 'clone-p1', label: 'A', points: 100, partial: true },
      { code: 'clone-p2', label: 'B', points: 50, partial: false },
    ],
  });
  expect(created.status).toBe(201);

  // History the clone must NOT carry: a participant and a clarification.
  const [contest] = await db.select().from(contests).where(eq(contests.key, key));
  const [user] = await db.select().from(schema.users).where(eq(schema.users.username, 'clone-organiser'));
  await db.insert(contestParticipations).values({
    contestId: contest!.id,
    userId: user!.id,
    startTime: start,
    virtual: 0,
  });
  await db.insert(contestClarifications).values({
    contestId: contest!.id,
    askedBy: user!.id,
    question: 'Đề bài B có ràng buộc nào?',
  });
}

describe('cloning a contest (D88)', () => {
  it('copies the format, config, freeze, problems and org restriction — and nothing that happened in it', async () => {
    await withTestDb(async (db) => {
      await withApp(db, async (app) => {
        const agent = await setterAgent(app, db, 'clone-organiser');
        await seedOwnedOrg(db, 'truong-a', 'clone-organiser');
        await seedSource(agent, db, 'tinh-2026');

        const start = new Date(Date.now() + 24 * HOUR);
        const end = new Date(Date.now() + 26 * HOUR);
        const cloned = await agent.post('/api/v1/contests/tinh-2026/clone').send({
          newKey: 'tinh-2027',
          newName: 'Vòng tỉnh 2027',
          startTime: start.toISOString(),
          endTime: end.toISOString(),
        });
        expect(cloned.status).toBe(201);
        expect(cloned.body).toMatchObject({
          key: 'tinh-2027',
          name: 'Vòng tỉnh 2027',
          format: 'ioi16',
          pointsPrecision: 1,
          frozenLastMinutes: 15,
          timeLimitSeconds: 1800,
          // Private, whatever the source was: a contest nobody scheduled
          // must not appear on the public list the moment it is copied.
          visibility: 'private',
          isRated: false,
        });
        expect(cloned.body.formatConfig).toEqual({ cumtime: false });
        expect(cloned.body.startTime).toBe(start.toISOString());
        expect(cloned.body.endTime).toBe(end.toISOString());
        // D56's restriction rides along: a contest for one school stays one.
        expect(cloned.body.orgs.map((o: { slug: string }) => o.slug)).toEqual(['truong-a']);

        // Labels, points, partial and order, all preserved.
        expect(cloned.body.problems).toEqual([
          expect.objectContaining({ code: 'clone-p1', label: 'A', points: 100, partial: true, order: 0 }),
          expect.objectContaining({ code: 'clone-p2', label: 'B', points: 50, partial: false, order: 1 }),
        ]);

        const [copy] = await db.select().from(contests).where(eq(contests.key, 'tinh-2027'));
        expect(await db.select().from(contestParticipations).where(eq(contestParticipations.contestId, copy!.id)))
          .toEqual([]);
        expect(await db.select().from(contestClarifications).where(eq(contestClarifications.contestId, copy!.id)))
          .toEqual([]);
        expect(
          (await db.select().from(contestProblems).where(eq(contestProblems.contestId, copy!.id))).length,
        ).toBe(2);
        expect((await db.select().from(contestOrgs).where(eq(contestOrgs.contestId, copy!.id))).length).toBe(1);

        // The source keeps its own history.
        const [source] = await db.select().from(contests).where(eq(contests.key, 'tinh-2026'));
        expect(
          (await db.select().from(contestParticipations).where(eq(contestParticipations.contestId, source!.id)))
            .length,
        ).toBe(1);
      });
    });
  }, 180_000);

  it('validates the NEW window: a backwards one, and one the copied freeze no longer fits', async () => {
    await withTestDb(async (db) => {
      await withApp(db, async (app) => {
        const agent = await setterAgent(app, db, 'clone-organiser');
        await seedOwnedOrg(db, 'truong-a', 'clone-organiser');
        await seedSource(agent, db, 'tinh-win');

        const backwards = await agent.post('/api/v1/contests/tinh-win/clone').send({
          newKey: 'tinh-back',
          newName: 'Ngược',
          startTime: new Date(Date.now() + 26 * HOUR).toISOString(),
          endTime: new Date(Date.now() + 24 * HOUR).toISOString(),
        });
        expect(backwards.status).toBe(400);
        expect(backwards.body.code).toBe('contest_window_invalid');

        // The source's 15-minute freeze is longer than a 10-minute contest,
        // and nothing in the request says so — the same merged-state rule
        // `update` applies.
        const squeezed = await agent.post('/api/v1/contests/tinh-win/clone').send({
          newKey: 'tinh-short',
          newName: 'Ngắn',
          startTime: new Date(Date.now() + 24 * HOUR).toISOString(),
          endTime: new Date(Date.now() + 24 * HOUR + 600_000).toISOString(),
        });
        expect(squeezed.status).toBe(422);
        expect(squeezed.body.code).toBe('contest_freeze_too_long');

        expect(await db.select().from(contests).where(eq(contests.key, 'tinh-short'))).toEqual([]);
      });
    });
  }, 180_000);

  it('refuses a taken key, a caller who does not run the contest, and one who may not create contests', async () => {
    await withTestDb(async (db) => {
      await withApp(db, async (app) => {
        const agent = await setterAgent(app, db, 'clone-organiser');
        await seedOwnedOrg(db, 'truong-a', 'clone-organiser');
        await seedSource(agent, db, 'tinh-authz');

        const window = {
          startTime: new Date(Date.now() + 24 * HOUR).toISOString(),
          endTime: new Date(Date.now() + 26 * HOUR).toISOString(),
        };

        const taken = await agent
          .post('/api/v1/contests/tinh-authz/clone')
          .send({ newKey: 'tinh-authz', newName: 'Trùng', ...window });
        expect(taken.status).toBe(409);
        expect(taken.body.code).toBe('contest_key_taken');

        // Another setter can SEE this public contest and does not run it —
        // 404, the same answer `PATCH /contests/{key}` gives them.
        const other = await setterAgent(app, db, 'clone-outsider');
        const refused = await other
          .post('/api/v1/contests/tinh-authz/clone')
          .send({ newKey: 'tinh-other', newName: 'Của người khác', ...window });
        expect(refused.status).toBe(404);

        // The organiser demoted: they still run the contest and may no
        // longer mint one.
        await db
          .update(schema.users)
          .set({ globalRole: 'user' })
          .where(eq(schema.users.username, 'clone-organiser'));
        const demoted = await agent
          .post('/api/v1/contests/tinh-authz/clone')
          .send({ newKey: 'tinh-demoted', newName: 'Bị hạ quyền', ...window });
        expect(demoted.status).toBe(403);
        expect(demoted.body.code).toBe('contest_forbidden');
      });
    });
  }, 180_000);
});
