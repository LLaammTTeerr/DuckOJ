/**
 * D56 — organization-restricted contests.
 *
 * `contest_orgs` used to mean one thing (who may SEE an `org`-visible
 * contest) and now means two: it also decides who may JOIN, whatever the
 * visibility. The properties that carry this file are the ones a happy path
 * cannot see — that the restriction is legible in every response, that a
 * refusal is 403 rather than 404 for a contest the caller is looking at, and
 * that the gate never takes a participation away from somebody who already
 * holds one.
 */
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  contestOrgs,
  contestParticipations,
  contests,
  orgMembers,
  organizations,
} from '@duckoj/db/guarded';
import type { Db } from '@duckoj/db';
import { ContestAccessService } from '../src/authz/contest.access.js';
import { uncachedScoreboards } from './scoreboard.fixtures.js';
import type { Actor } from '../src/authz/actor.js';
import { withTestDb } from './db.harness.js';
import { insertUser, seedProblemAndLanguage, seedProblemWithSourceAccess } from './submissions.fixtures.js';

const MINUTE = 60_000;

function actorFor(userId: number, globalRole: Actor['globalRole'] = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

async function seedOrg(
  db: Db,
  slug: string,
  members: Array<{ userId: number; role: 'owner' | 'admin' | 'member' }> = [],
): Promise<number> {
  const [org] = await db
    .insert(organizations)
    .values({ slug, name: `Org ${slug}` })
    .returning({ id: organizations.id });
  for (const m of members) {
    await db.insert(orgMembers).values({ orgId: org!.id, userId: m.userId, role: m.role });
  }
  return org!.id;
}

/** A running public contest, optionally restricted to `orgIds`. */
async function seedContest(
  db: Db,
  opts: {
    key: string;
    ownerId: number;
    orgIds?: number[];
    visibility?: 'public' | 'org' | 'private';
    startsInMs?: number;
  },
): Promise<number> {
  const now = Date.now();
  const [contest] = await db
    .insert(contests)
    .values({
      key: opts.key,
      name: opts.key,
      startTime: new Date(now + (opts.startsInMs ?? -10 * MINUTE)),
      endTime: new Date(now + 120 * MINUTE),
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

describe('who may attach an organization to a contest', () => {
  it('accepts an org the setter administers and refuses one they are merely in', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const setter = await insertUser(db, 'co-setter');
      const mine = await seedOrg(db, 'co-mine', [{ userId: setter.id, role: 'admin' }]);
      await seedOrg(db, 'co-theirs', [{ userId: setter.id, role: 'member' }]);
      const service = new ContestAccessService(db, uncachedScoreboards());
      const actor = actorFor(setter.id, 'setter');
      const window = {
        startTime: new Date(Date.now() + 60 * MINUTE).toISOString(),
        endTime: new Date(Date.now() + 120 * MINUTE).toISOString(),
        format: 'icpc',
      };

      const created = await service.create(actor, { ...window, key: 'co-ok', name: 'ok', orgSlugs: ['co-mine'] });
      expect(created.orgs).toEqual([{ slug: 'co-mine', name: 'Org co-mine' }]);
      expect(
        (
          await db.select().from(contestOrgs).where(eq(contestOrgs.orgId, mine))
        ).length,
      ).toBe(1);

      // Membership is not authority (D56): the same 400 an unknown slug gets,
      // so this cannot probe for a private organization either.
      await expect(
        service.create(actor, { ...window, key: 'co-no', name: 'no', orgSlugs: ['co-theirs'] }),
      ).rejects.toMatchObject({ status: 400, code: 'contest_org_unknown' });
      await expect(
        service.create(actor, { ...window, key: 'co-no2', name: 'no', orgSlugs: ['co-nonexistent'] }),
      ).rejects.toMatchObject({ status: 400, code: 'contest_org_unknown' });
    });
  }, 120_000);

  it('lets a global admin attach an organization they have never joined', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const admin = await insertUser(db, 'co-admin', 'admin');
      await seedOrg(db, 'co-stranger');
      const service = new ContestAccessService(db, uncachedScoreboards());
      const created = await service.create(actorFor(admin.id, 'admin'), {
        key: 'co-adm',
        name: 'adm',
        startTime: new Date(Date.now() + 60 * MINUTE).toISOString(),
        endTime: new Date(Date.now() + 120 * MINUTE).toISOString(),
        format: 'icpc',
        orgSlugs: ['co-stranger'],
      });
      expect(created.orgs.map((o) => o.slug)).toEqual(['co-stranger']);
    });
  }, 120_000);
});

describe('editing a contest’s organizations', () => {
  it('replaces the whole set, and refuses to strand an org-visible contest', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const owner = await insertUser(db, 'ceo-owner');
      const a = await seedOrg(db, 'ceo-a', [{ userId: owner.id, role: 'owner' }]);
      await seedOrg(db, 'ceo-b', [{ userId: owner.id, role: 'owner' }]);
      const contestId = await seedContest(db, {
        key: 'ceo',
        ownerId: owner.id,
        orgIds: [a],
        visibility: 'org',
        startsInMs: 60 * MINUTE,
      });
      const service = new ContestAccessService(db, uncachedScoreboards());
      const actor = actorFor(owner.id);

      const after = await service.update(actor, 'ceo', { orgSlugs: ['ceo-b'] });
      expect(after.orgs.map((o) => o.slug)).toEqual(['ceo-b']);
      // REPLACED, not merged — and the removed row is gone from the table,
      // not merely absent from the response.
      const rows = await db.select().from(contestOrgs).where(eq(contestOrgs.contestId, contestId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.orgId).not.toBe(a);

      // `[]` is a real instruction, and on an org-visible contest it would
      // leave the contest visible to nobody at all.
      await expect(service.update(actor, 'ceo', { orgSlugs: [] })).rejects.toMatchObject({
        status: 400,
        code: 'contest_org_missing',
      });
      // …and the merged state is what is checked: a patch naming neither
      // field still has to hold.
      await expect(
        service.update(actor, 'ceo', { orgSlugs: [], visibility: 'public' }),
      ).resolves.toMatchObject({ orgs: [] });
    });
  }, 120_000);

  it('lets a creator who only belongs to an attached org resubmit the stored list', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const owner = await insertUser(db, 'ceo2-owner');
      // An ADMIN attached this org; the creator is only a member of it, so a
      // strict check would refuse every save the edit form makes.
      const org = await seedOrg(db, 'ceo2-org', [{ userId: owner.id, role: 'member' }]);
      await seedContest(db, { key: 'ceo2', ownerId: owner.id, orgIds: [org], startsInMs: 60 * MINUTE });
      const service = new ContestAccessService(db, uncachedScoreboards());

      const after = await service.update(actorFor(owner.id), 'ceo2', {
        name: 'Renamed',
        orgSlugs: ['ceo2-org'],
      });
      expect([after.name, after.orgs.length]).toEqual(['Renamed', 1]);
    });
  }, 120_000);
});

describe('joining an organization-restricted contest', () => {
  it('refuses a non-member with 403, and admits a member', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      await seedProblemWithSourceAccess(db, { code: 'cj-p' });
      const owner = await insertUser(db, 'cj-owner');
      const pupil = await insertUser(db, 'cj-pupil');
      const stranger = await insertUser(db, 'cj-stranger');
      const org = await seedOrg(db, 'cj-school', [{ userId: pupil.id, role: 'member' }]);
      // PUBLIC, deliberately: the stranger can see this contest perfectly
      // well, which is the whole reason the refusal is 403 and not 404.
      await seedContest(db, { key: 'cj', ownerId: owner.id, orgIds: [org] });
      const service = new ContestAccessService(db, uncachedScoreboards());

      await expect(service.getVisible(actorFor(stranger.id), 'cj')).resolves.toMatchObject({
        orgs: [{ slug: 'cj-school', name: 'Org cj-school' }],
      });
      await expect(service.join(actorFor(stranger.id), 'cj')).rejects.toMatchObject({
        status: 403,
        code: 'contest_org_required',
      });
      await expect(service.join(actorFor(pupil.id), 'cj')).resolves.toMatchObject({ virtual: 0 });
      // The contest's own creator is NOT exempt: running a contest is not
      // competing in it.
      await expect(service.join(actorFor(owner.id), 'cj')).rejects.toMatchObject({ status: 403 });
    });
  }, 120_000);

  it('lets a global admin in, and leaves an unrestricted contest alone', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const owner = await insertUser(db, 'cj2-owner');
      const admin = await insertUser(db, 'cj2-admin', 'admin');
      const anyone = await insertUser(db, 'cj2-anyone');
      const org = await seedOrg(db, 'cj2-school');
      await seedContest(db, { key: 'cj2', ownerId: owner.id, orgIds: [org] });
      await seedContest(db, { key: 'cj2-open', ownerId: owner.id });
      const service = new ContestAccessService(db, uncachedScoreboards());

      await expect(service.join(actorFor(admin.id, 'admin'), 'cj2')).resolves.toMatchObject({ virtual: 0 });
      // No organizations at all means no restriction — the pre-D56 contest.
      await expect(service.join(actorFor(anyone.id), 'cj2-open')).resolves.toMatchObject({ virtual: 0 });
    });
  }, 120_000);

  it('still returns the participation of somebody the school has since removed', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const owner = await insertUser(db, 'cj3-owner');
      const pupil = await insertUser(db, 'cj3-pupil');
      const org = await seedOrg(db, 'cj3-school', [{ userId: pupil.id, role: 'member' }]);
      const contestId = await seedContest(db, { key: 'cj3', ownerId: owner.id, orgIds: [org] });
      const service = new ContestAccessService(db, uncachedScoreboards());
      const joined = await service.join(actorFor(pupil.id), 'cj3');

      await db
        .delete(orgMembers)
        .where(and(eq(orgMembers.orgId, org), eq(orgMembers.userId, pupil.id)));

      // The gate sits after the idempotent short-circuit: a competitor mid
      // contest does not lose the row they are already competing on.
      await expect(service.join(actorFor(pupil.id), 'cj3')).resolves.toMatchObject({ id: joined.id });
      expect(
        await db.select().from(contestParticipations).where(eq(contestParticipations.contestId, contestId)),
      ).toHaveLength(1);
    });
  }, 120_000);
});

describe('finding a contest by its organization', () => {
  it('filters the list, and answers an empty page for a slug that names nothing', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const owner = await insertUser(db, 'cf-owner');
      const org = await seedOrg(db, 'cf-school');
      await seedContest(db, { key: 'cf-theirs', ownerId: owner.id, orgIds: [org] });
      await seedContest(db, { key: 'cf-open', ownerId: owner.id });
      const service = new ContestAccessService(db, uncachedScoreboards());

      const filtered = await service.listVisible(null, { limit: 20, org: 'cf-school' });
      expect(filtered.items.map((c) => c.key)).toEqual(['cf-theirs']);
      expect(filtered.items[0]!.orgs).toEqual([{ slug: 'cf-school', name: 'Org cf-school' }]);
      // Case-insensitive, like every other slug lookup in this codebase.
      expect((await service.listVisible(null, { limit: 20, org: 'CF-School' })).items).toHaveLength(1);
      // Never a 404: the filter must not become an existence oracle.
      await expect(service.listVisible(null, { limit: 20, org: 'cf-nothing' })).resolves.toMatchObject({
        items: [],
      });
      expect((await service.listVisible(null, { limit: 20 })).items).toHaveLength(2);
    });
  }, 120_000);
});
