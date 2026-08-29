/**
 * `PATCH /contests/{key}`.
 *
 * Two properties carry this file. First, **absent means keep**: the request
 * schema deliberately has no defaults, because `CreateContestRequest.partial()`
 * would have made every edit that omitted `visibility` silently privatise the
 * contest. Second, **the validations run on the merged state**, not on the
 * patch — moving only `endTime` must still be checked against the stored
 * `startTime`.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { asc, eq } from 'drizzle-orm';
import { contestOrgs, contestProblems, contests, organizations } from '@duckoj/db/guarded';
import type { Db } from '@duckoj/db';
import { ContestAccessService } from '../src/authz/contest.access.js';
import type { Actor } from '../src/authz/actor.js';
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

function actorFor(userId: number, globalRole: Actor['globalRole'] = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

/** A contest whose window is relative to now, so a test can put itself either side of it. */
async function seedContest(
  db: Db,
  opts: { key: string; ownerId: number; problemId: number; startsInMs: number; endsInMs: number },
): Promise<number> {
  const now = Date.now();
  const [contest] = await db
    .insert(contests)
    .values({
      key: opts.key,
      name: opts.key,
      startTime: new Date(now + opts.startsInMs),
      endTime: new Date(now + opts.endsInMs),
      format: 'icpc',
      visibility: 'public',
      createdBy: opts.ownerId,
    })
    .returning({ id: contests.id });
  await db
    .insert(contestProblems)
    .values({ contestId: contest!.id, problemId: opts.problemId, label: 'A', points: 100, order: 0 });
  return contest!.id;
}

async function baseline(db: Db, prefix: string) {
  await seedProblemAndLanguage(db);
  const owner = await insertUser(db, `${prefix}-owner`);
  const problem = await seedProblemWithSourceAccess(db, { code: `${prefix}-p` });
  return { owner, problem };
}

describe('editing a contest', () => {
  it('changes only the fields sent, and leaves the rest exactly as they were', async () => {
    await withTestDb(async (db) => {
      const { owner, problem } = await baseline(db, 'ce1');
      await seedContest(db, {
        key: 'ce1',
        ownerId: owner.id,
        problemId: problem.id,
        startsInMs: 60 * MINUTE,
        endsInMs: 120 * MINUTE,
      });
      const service = new ContestAccessService(db);
      const before = await service.getVisible(actorFor(owner.id), 'ce1');

      const after = await service.update(actorFor(owner.id), 'ce1', { name: 'Renamed' });

      expect(after.name).toBe('Renamed');
      // The trap `CreateContestRequest.partial()` would have sprung: an
      // omitted `visibility` must not privatise a public contest.
      expect(after.visibility).toBe('public');
      expect([after.format, after.startTime, after.endTime, after.pointsPrecision]).toEqual([
        before.format,
        before.startTime,
        before.endTime,
        before.pointsPrecision,
      ]);
    });
  }, 120_000);

  it('validates the merged state, not the patch alone', async () => {
    await withTestDb(async (db) => {
      const { owner, problem } = await baseline(db, 'ce2');
      await seedContest(db, {
        key: 'ce2',
        ownerId: owner.id,
        problemId: problem.id,
        startsInMs: 60 * MINUTE,
        endsInMs: 120 * MINUTE,
      });
      const service = new ContestAccessService(db);

      // Only `endTime` moves — and it lands before the STORED start.
      await expect(
        service.update(actorFor(owner.id), 'ce2', {
          endTime: new Date(Date.now() + 30 * MINUTE).toISOString(),
        }),
      ).rejects.toMatchObject({ status: 400, code: 'contest_window_invalid' });

      await expect(
        service.update(actorFor(owner.id), 'ce2', { format: 'no-such-format' }),
      ).rejects.toMatchObject({ status: 400, code: 'unknown_contest_format' });
      // A freeze window is legal since D22 — but not one as long as the
      // contest, which runs 60 minutes here.
      await expect(
        service.update(actorFor(owner.id), 'ce2', { frozenLastMinutes: 60 }),
      ).rejects.toMatchObject({ status: 422, code: 'contest_freeze_too_long' });
      // Org visibility with nothing shared would hide the contest from
      // everyone, its own creator included.
      await expect(
        service.update(actorFor(owner.id), 'ce2', { visibility: 'org' }),
      ).rejects.toMatchObject({ status: 400, code: 'contest_org_required' });
    });
  }, 120_000);

  it('clears a nullable column when it is explicitly sent as null, and keeps it when omitted', async () => {
    await withTestDb(async (db) => {
      const { owner, problem } = await baseline(db, 'ce3');
      const contestId = await seedContest(db, {
        key: 'ce3',
        ownerId: owner.id,
        problemId: problem.id,
        startsInMs: 60 * MINUTE,
        endsInMs: 120 * MINUTE,
      });
      await db.update(contests).set({ timeLimitSeconds: 900 }).where(eq(contests.id, contestId));
      const service = new ContestAccessService(db);

      expect((await service.update(actorFor(owner.id), 'ce3', { name: 'x' })).timeLimitSeconds).toBe(
        900,
      );
      expect(
        (await service.update(actorFor(owner.id), 'ce3', { timeLimitSeconds: null }))
          .timeLimitSeconds,
      ).toBeNull();
    });
  }, 120_000);

  it('replaces the problem list, in order, before the contest starts', async () => {
    await withTestDb(async (db) => {
      const { owner, problem } = await baseline(db, 'ce4');
      const second = await seedProblemWithSourceAccess(db, { code: 'ce4-q' });
      const contestId = await seedContest(db, {
        key: 'ce4',
        ownerId: owner.id,
        problemId: problem.id,
        startsInMs: 60 * MINUTE,
        endsInMs: 120 * MINUTE,
      });

      await new ContestAccessService(db).update(actorFor(owner.id), 'ce4', {
        problems: [
          { code: 'ce4-q', points: 50, partial: false },
          { code: 'ce4-p', points: 200, partial: true },
        ],
      });

      // Read from the table, not from `getVisible`: before the start that
      // response conceals the problem list from everyone but a global admin
      // (the pre-start leak the sweep closed), so it cannot see this.
      const rows = await db
        .select({
          problemId: contestProblems.problemId,
          points: contestProblems.points,
          partial: contestProblems.partial,
          order: contestProblems.order,
        })
        .from(contestProblems)
        .where(eq(contestProblems.contestId, contestId))
        .orderBy(asc(contestProblems.order));
      expect(rows).toEqual([
        { problemId: second.id, points: 50, partial: false, order: 0 },
        { problemId: problem.id, points: 200, partial: true, order: 1 },
      ]);
    });
  }, 120_000);
});

describe('the pre-start concealment', () => {
  it('still hides the problem list from a bystander, but not from the creator', async () => {
    await withTestDb(async (db) => {
      const { owner, problem } = await baseline(db, 'ce10');
      const bystander = await insertUser(db, 'ce10-bystander');
      await seedContest(db, {
        key: 'ce10',
        ownerId: owner.id,
        problemId: problem.id,
        startsInMs: 60 * MINUTE,
        endsInMs: 120 * MINUTE,
      });
      const service = new ContestAccessService(db);

      // The sweep concealed this from everyone but a global admin. It has to
      // reach the creator too, or the edit form prefills an empty problem
      // list and saves it back over the real one.
      const asOwner = await service.getVisible(actorFor(owner.id), 'ce10');
      expect(asOwner.problems.map((p) => p.code)).toEqual(['ce10-p']);

      const asBystander = await service.getVisible(actorFor(bystander.id), 'ce10');
      expect(asBystander.problems).toEqual([]);
      const anonymous = await service.getVisible(null, 'ce10');
      expect(anonymous.problems).toEqual([]);
    });
  }, 120_000);
});

describe('once a contest has started', () => {
  it('refuses a format or problem change with 409 contest_started', async () => {
    await withTestDb(async (db) => {
      const { owner, problem } = await baseline(db, 'ce5');
      await seedProblemWithSourceAccess(db, { code: 'ce5-q' });
      await seedContest(db, {
        key: 'ce5',
        ownerId: owner.id,
        problemId: problem.id,
        startsInMs: -MINUTE,
        endsInMs: 60 * MINUTE,
      });
      const service = new ContestAccessService(db);

      await expect(
        service.update(actorFor(owner.id), 'ce5', { format: 'ioi16' }),
      ).rejects.toMatchObject({ status: 409, code: 'contest_started' });
      await expect(
        service.update(actorFor(owner.id), 'ce5', {
          problems: [{ code: 'ce5-q', points: 100, partial: true }],
        }),
      ).rejects.toMatchObject({ status: 409, code: 'contest_started' });
    });
  }, 120_000);

  it('still allows renaming, and takes the values it already has as a no-op', async () => {
    await withTestDb(async (db) => {
      const { owner, problem } = await baseline(db, 'ce6');
      await seedContest(db, {
        key: 'ce6',
        ownerId: owner.id,
        problemId: problem.id,
        startsInMs: -MINUTE,
        endsInMs: 60 * MINUTE,
      });
      const service = new ContestAccessService(db);

      // A client that PATCHes the whole form back must not be told the
      // contest has started: nothing it sent is a change.
      const after = await service.update(actorFor(owner.id), 'ce6', {
        name: 'Live and renamed',
        format: 'icpc',
        problems: [{ code: 'ce6-p', points: 100, partial: true, label: 'A' }],
      });
      expect(after.name).toBe('Live and renamed');
      expect(after.problems.map((p) => p.code)).toEqual(['ce6-p']);
    });
  }, 120_000);
});

describe('who may edit', () => {
  it('an admin may; a bystander and an outsider both get 404, never 403', async () => {
    await withTestDb(async (db) => {
      const { owner, problem } = await baseline(db, 'ce7');
      const admin = await insertUser(db, 'ce7-admin', 'admin');
      const bystander = await insertUser(db, 'ce7-bystander');
      const contestId = await seedContest(db, {
        key: 'ce7',
        ownerId: owner.id,
        problemId: problem.id,
        startsInMs: 60 * MINUTE,
        endsInMs: 120 * MINUTE,
      });
      const service = new ContestAccessService(db);

      expect((await service.update(actorFor(admin.id, 'admin'), 'ce7', { name: 'By admin' })).name).toBe(
        'By admin',
      );
      // Visible to them, and still 404 — this route conceals the authority,
      // not just the contest. See `update`'s doc comment.
      await expect(
        service.update(actorFor(bystander.id), 'ce7', { name: 'nope' }),
      ).rejects.toMatchObject({ status: 404, code: 'contest_not_found' });

      await db.update(contests).set({ visibility: 'private' }).where(eq(contests.id, contestId));
      await expect(
        service.update(actorFor(bystander.id), 'ce7', { name: 'nope' }),
      ).rejects.toMatchObject({ status: 404, code: 'contest_not_found' });
    });
  }, 120_000);

  it('an org-visible contest may stay org-visible', async () => {
    await withTestDb(async (db) => {
      const { owner, problem } = await baseline(db, 'ce8');
      const contestId = await seedContest(db, {
        key: 'ce8',
        ownerId: owner.id,
        problemId: problem.id,
        startsInMs: 60 * MINUTE,
        endsInMs: 120 * MINUTE,
      });
      const [org] = await db
        .insert(organizations)
        .values({ slug: 'ce8-org', name: 'CE8' })
        .returning({ id: organizations.id });
      await db.insert(contestOrgs).values({ contestId, orgId: org!.id });

      const after = await new ContestAccessService(db).update(actorFor(owner.id), 'ce8', {
        visibility: 'org',
      });
      expect(after.visibility).toBe('org');
    });
  }, 120_000);
});

describe('the edit route', () => {
  it('is reachable over HTTP and rejects an unknown field', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const problem = await seedProblemWithSourceAccess(db, { code: 'ce9-p' });
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'ce9-owner');
        await seedContest(db, {
          key: 'ce9',
          ownerId: await userIdOf(db, 'ce9-owner'),
          problemId: problem.id,
          startsInMs: 60 * MINUTE,
          endsInMs: 120 * MINUTE,
        });

        const ok = await agent.patch('/contests/ce9').send({ name: 'Edited over HTTP' });
        expect(ok.status).toBe(200);
        expect(ok.body.name).toBe('Edited over HTTP');
        expect(ok.body.canEdit).toBe(true);

        // A contest's key is its URL; renaming it is a different contest.
        const renamed = await agent.patch('/contests/ce9').send({ key: 'ce9-renamed' });
        expect(renamed.status).toBe(422);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
