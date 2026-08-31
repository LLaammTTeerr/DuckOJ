/**
 * D151 — `GET /contests?phase=&mine=`.
 *
 * The bug these exist for is invisible on a small database and fatal on a
 * real one: unfiltered, this endpoint answers page 1 of an **id**-ordered
 * list — creation order — so on a judge with a hundred rounds behind it, the
 * round created this morning is on the last page, and the home panel that
 * reads this endpoint cannot see today's contest at all.
 *
 * So the first property here is deliberately expensive: **a fresh contest
 * beyond the first page of the unfiltered list is on the FIRST page of the
 * filtered one.** Nothing cheaper reproduces the bug.
 *
 * The rest is what a filter must not do: it must not widen visibility, it
 * must not disagree with `assertMayJoin`, and it must not lose or repeat a
 * row across a page boundary.
 *
 * Container-backed (D106/D149): CI runs it serially; it is not run on a
 * developer machine.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { contestOrgs, contestParticipations, contests, orgMembers, organizations } from '@duckoj/db/guarded';
import type { Db } from '@duckoj/db';
import { ContestPage } from '@duckoj/contracts';
import { ContestAccessService } from '../src/authz/contest.access.js';
import type { Actor } from '../src/authz/actor.js';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { uncachedScoreboards } from './scoreboard.fixtures.js';
import { insertUser } from './submissions.fixtures.js';

const MINUTE = 60_000;

function actorFor(userId: number, globalRole: Actor['globalRole'] = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

async function seedOrg(db: Db, slug: string, memberIds: number[] = []): Promise<number> {
  const [org] = await db
    .insert(organizations)
    .values({ slug, name: `Org ${slug}` })
    .returning({ id: organizations.id });
  for (const userId of memberIds) {
    await db.insert(orgMembers).values({ orgId: org!.id, userId, role: 'member' });
  }
  return org!.id;
}

async function seedContest(
  db: Db,
  opts: {
    key: string;
    ownerId: number;
    /** Milliseconds from now. Negative is a contest already begun. */
    startsInMs: number;
    lengthMs?: number;
    orgIds?: number[];
    visibility?: 'public' | 'org' | 'private';
  },
): Promise<number> {
  const start = Date.now() + opts.startsInMs;
  const [contest] = await db
    .insert(contests)
    .values({
      key: opts.key,
      name: opts.key,
      startTime: new Date(start),
      endTime: new Date(start + (opts.lengthMs ?? 120 * MINUTE)),
      format: 'icpc',
      visibility: opts.visibility ?? 'public',
      createdBy: opts.ownerId,
    })
    .returning({ id: contests.id });
  for (const orgId of opts.orgIds ?? []) {
    await db.insert(contestOrgs).values({ contestId: contest!.id, orgId });
  }
  return contest!.id;
}

const keys = (page: { items: Array<{ key: string }> }): string[] => page.items.map((c) => c.key);

describe('the front page can see today’s contest (D151)', () => {
  it('finds a round beyond the unfiltered first page, because `phase` orders by start time', async () => {
    await withTestDb(async (db) => {
      const setter = await insertUser(db, 'clf-setter');
      const reader = await insertUser(db, 'clf-reader');
      // Thirty rounds that are OVER, created first, so they own the low ids
      // and therefore the whole of an id-ordered first page.
      for (let i = 0; i < 30; i += 1) {
        await seedContest(db, {
          key: `clf-old-${i}`,
          ownerId: setter.id,
          startsInMs: -(400 + i) * MINUTE,
          lengthMs: 60 * MINUTE,
        });
      }
      // The one created this morning: the highest id in the table.
      await seedContest(db, { key: 'clf-today', ownerId: setter.id, startsInMs: -10 * MINUTE });

      const service = new ContestAccessService(db, uncachedScoreboards());
      const actor = actorFor(reader.id);

      // The bug, stated: it is not on the unfiltered first page.
      const unfiltered = await service.listVisible(actor, { limit: 25 });
      expect(keys(unfiltered)).not.toContain('clf-today');

      // The fix: it is the FIRST item of the filtered one.
      const active = await service.listVisible(actor, { limit: 5, phase: 'active' });
      expect(keys(active)[0]).toBe('clf-today');
      // A finished round is never in an `active` page, however low its id.
      expect(keys(active).some((key) => key.startsWith('clf-old-'))).toBe(false);
    });
  }, 120_000);

  it('puts the running round ahead of the next one to start, which is what the home panel picks', async () => {
    await withTestDb(async (db) => {
      const setter = await insertUser(db, 'clf-order-setter');
      // Created in the order that would mislead an id-ordered list: the
      // future round first.
      await seedContest(db, { key: 'clf-later', ownerId: setter.id, startsInMs: 90 * MINUTE });
      await seedContest(db, { key: 'clf-soon', ownerId: setter.id, startsInMs: 30 * MINUTE });
      await seedContest(db, { key: 'clf-now', ownerId: setter.id, startsInMs: -5 * MINUTE });

      const service = new ContestAccessService(db, uncachedScoreboards());
      const actor = actorFor(setter.id, 'setter');

      // A running contest started in the past, an upcoming one starts in the
      // future — so start-time order alone puts the round the reader is IN
      // first, with no second sort and no `phase` column to compute.
      expect(keys(await service.listVisible(actor, { limit: 10, phase: 'active' }))).toEqual([
        'clf-now',
        'clf-soon',
        'clf-later',
      ]);
      expect(keys(await service.listVisible(actor, { limit: 10, phase: 'running' }))).toEqual(['clf-now']);
      expect(keys(await service.listVisible(actor, { limit: 10, phase: 'upcoming' }))).toEqual([
        'clf-soon',
        'clf-later',
      ]);
    });
  }, 120_000);
});

describe('a filter narrows, and never widens (D151)', () => {
  it('still hides a private contest and an org contest the caller is not in', async () => {
    await withTestDb(async (db) => {
      const setter = await insertUser(db, 'clf-vis-setter');
      const outsider = await insertUser(db, 'clf-vis-outsider');
      const theirs = await seedOrg(db, 'clf-vis-theirs', [setter.id]);
      await seedContest(db, { key: 'clf-vis-private', ownerId: setter.id, startsInMs: -MINUTE, visibility: 'private' });
      await seedContest(db, {
        key: 'clf-vis-org',
        ownerId: setter.id,
        startsInMs: -MINUTE,
        visibility: 'org',
        orgIds: [theirs],
      });
      await seedContest(db, { key: 'clf-vis-public', ownerId: setter.id, startsInMs: -MINUTE });

      const service = new ContestAccessService(db, uncachedScoreboards());

      // Every combination of the two new filters, and the anonymous caller
      // too: none of them may reach a row the unfiltered list would refuse.
      for (const params of [
        { limit: 25, phase: 'active' as const },
        { limit: 25, phase: 'active' as const, mine: true },
        { limit: 25, mine: true },
      ]) {
        expect(keys(await service.listVisible(actorFor(outsider.id), params))).toEqual(['clf-vis-public']);
        expect(keys(await service.listVisible(null, params))).toEqual(
          params.mine === true ? [] : ['clf-vis-public'],
        );
      }
      // The creator still sees their own private round through the filter —
      // the filter did not become a second visibility rule.
      expect(keys(await service.listVisible(actorFor(setter.id, 'setter'), { limit: 25, phase: 'active' }))).toEqual(
        expect.arrayContaining(['clf-vis-private', 'clf-vis-org', 'clf-vis-public']),
      );
    });
  }, 120_000);

  it('`mine` agrees with the join gate: no orgs, my org, or a participation already held', async () => {
    await withTestDb(async (db) => {
      const setter = await insertUser(db, 'clf-mine-setter');
      const pupil = await insertUser(db, 'clf-mine-pupil');
      const mySchool = await seedOrg(db, 'clf-mine-school', [pupil.id]);
      const otherSchool = await seedOrg(db, 'clf-mine-other', [setter.id]);

      await seedContest(db, { key: 'clf-mine-open', ownerId: setter.id, startsInMs: -MINUTE });
      await seedContest(db, { key: 'clf-mine-ours', ownerId: setter.id, startsInMs: -MINUTE, orgIds: [mySchool] });
      const theirs = await seedContest(db, {
        key: 'clf-mine-theirs',
        ownerId: setter.id,
        startsInMs: -MINUTE,
        orgIds: [otherSchool],
      });

      const service = new ContestAccessService(db, uncachedScoreboards());
      const actor = actorFor(pupil.id);

      // Public and therefore VISIBLE, but this pupil may not join it, so a
      // panel headed "your contests" must not headline it.
      expect(keys(await service.listVisible(actor, { limit: 25 }))).toContain('clf-mine-theirs');
      expect(keys(await service.listVisible(actor, { limit: 25, mine: true })).sort()).toEqual([
        'clf-mine-open',
        'clf-mine-ours',
      ]);

      // A participation already held wins outright — `assertMayJoin` sits
      // after the idempotent short-circuit for exactly this reason, and a
      // filter that dropped the round off their home page while they could
      // still submit to it would contradict the endpoint.
      await db.insert(contestParticipations).values({
        contestId: theirs,
        userId: pupil.id,
        startTime: new Date(),
      });
      expect(keys(await service.listVisible(actor, { limit: 25, mine: true }))).toContain('clf-mine-theirs');

      // An admin may join anything (`assertMayJoin` returns early), so
      // `mine` removes nothing for them.
      const admin = await insertUser(db, 'clf-mine-admin', 'admin');
      expect(keys(await service.listVisible(actorFor(admin.id, 'admin'), { limit: 25, mine: true })).sort()).toEqual([
        'clf-mine-open',
        'clf-mine-ours',
        'clf-mine-theirs',
      ]);
    });
  }, 120_000);
});

describe('the phase page’s cursor (D151)', () => {
  it('walks every round exactly once when several start in the same second', async () => {
    await withTestDb(async (db) => {
      const setter = await insertUser(db, 'clf-cur-setter');
      // The normal case on this judge, not a corner one: several rounds
      // beginning at the same instant on a Saturday morning. A single-column
      // seek over a non-unique key either repeats one or loses it.
      for (let i = 0; i < 5; i += 1) {
        await seedContest(db, { key: `clf-cur-${i}`, ownerId: setter.id, startsInMs: 60 * MINUTE });
      }
      const service = new ContestAccessService(db, uncachedScoreboards());
      const actor = actorFor(setter.id, 'setter');

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const result = await service.listVisible(actor, { limit: 2, phase: 'upcoming', cursor });
        seen.push(...keys(result));
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }
      expect(seen.sort()).toEqual(['clf-cur-0', 'clf-cur-1', 'clf-cur-2', 'clf-cur-3', 'clf-cur-4']);
    });
  }, 120_000);

  it('refuses a cursor from the other ordering rather than silently re-serving page 1', async () => {
    await withTestDb(async (db) => {
      const setter = await insertUser(db, 'clf-cur2-setter');
      await seedContest(db, { key: 'clf-cur2-a', ownerId: setter.id, startsInMs: 60 * MINUTE });
      const service = new ContestAccessService(db, uncachedScoreboards());
      const actor = actorFor(setter.id, 'setter');

      // An id cursor handed to a phase page: a real client mistake, and one
      // that would otherwise loop forever on page 1.
      await expect(service.listVisible(actor, { limit: 2, phase: 'upcoming', cursor: 'nonsense' })).rejects.toMatchObject(
        { status: 422, code: 'invalid_cursor' },
      );
      await expect(
        service.listVisible(actor, { limit: 2, phase: 'upcoming', cursor: '1_2_3' }),
      ).rejects.toMatchObject({ status: 422, code: 'invalid_cursor' });
    });
  }, 120_000);
});

describe('GET /contests carries the filters over the wire (D151)', () => {
  it('accepts `phase` and `mine` from the query string and refuses an unknown phase', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const setter = await insertUser(db, 'clf-http-setter');
        await seedContest(db, { key: 'clf-http-done', ownerId: setter.id, startsInMs: -400 * MINUTE, lengthMs: MINUTE });
        await seedContest(db, { key: 'clf-http-now', ownerId: setter.id, startsInMs: -MINUTE });

        const res = await request(app.getHttpServer()).get('/api/v1/contests?phase=active&limit=5');
        expect(res.status).toBe(200);
        expect(keys(ContestPage.parse(res.body))).toEqual(['clf-http-now']);

        // Anonymous + `mine=true` is an empty page, never a 401: a filter
        // must not turn a public listing into a guarded one.
        const anon = await request(app.getHttpServer()).get('/api/v1/contests?mine=true');
        expect(anon.status).toBe(200);
        expect(ContestPage.parse(anon.body).items).toEqual([]);

        const bad = await request(app.getHttpServer()).get('/api/v1/contests?phase=finished');
        expect(bad.status).toBe(422);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
