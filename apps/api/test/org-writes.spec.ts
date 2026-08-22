import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '@duckoj/db';
import { organizations, orgMembers } from '@duckoj/db/guarded';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { OrgAccessService } from '../src/authz/org.access.js';
import type { Actor } from '../src/authz/actor.js';
import { withTestDb } from './db.harness.js';
import { insertUser } from './submissions.fixtures.js';

function actorFor(userId: number, globalRole: 'user' | 'setter' | 'admin' = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

async function seedOrg(
  db: Db,
  opts: { slug: string; name: string; visibility?: 'public' | 'private' },
): Promise<{ id: number }> {
  const [org] = await db
    .insert(organizations)
    .values({ slug: opts.slug, name: opts.name, visibility: opts.visibility ?? 'public' })
    .returning();
  return { id: org!.id };
}

describe('OrgAccessService.create', () => {
  it('is admin-only: a plain user, a setter, and an anonymous caller are all refused', async () => {
    await withTestDb(async (db) => {
      const user = await insertUser(db, 'create-user');
      const service = new OrgAccessService(db, new NotificationsService(db));

      await expect(
        service.create(actorFor(user.id, 'user'), { slug: 'nope', name: 'Nope' }),
      ).rejects.toMatchObject({ status: 403, code: 'organization_forbidden' });
      await expect(
        service.create(actorFor(user.id, 'setter'), { slug: 'nope', name: 'Nope' }),
      ).rejects.toMatchObject({ status: 403, code: 'organization_forbidden' });
      await expect(service.create(null, { slug: 'nope', name: 'Nope' })).rejects.toMatchObject({
        status: 403,
        code: 'organization_forbidden',
      });

      const rows = await db.select().from(organizations);
      expect(rows).toHaveLength(0);
    });
  }, 120_000);

  it('seeds the creator as owner, and defaults a direct call missing visibility/joinPolicy the same way the wire schema does', async () => {
    await withTestDb(async (db) => {
      const admin = await insertUser(db, 'create-admin', 'admin');
      const service = new OrgAccessService(db, new NotificationsService(db));

      const org = await service.create(actorFor(admin.id, 'admin'), { slug: 'new-club', name: 'New Club' });
      expect(org.visibility).toBe('private');
      expect(org.joinPolicy).toBe('request');

      const members = await db.select().from(orgMembers).where(eq(orgMembers.orgId, org.id));
      expect(members).toHaveLength(1);
      expect(members[0]).toMatchObject({ userId: admin.id, role: 'owner' });
    });
  }, 120_000);

  it('rejects a racing duplicate slug (case-insensitively) as 409 organization_slug_taken, never a 500', async () => {
    await withTestDb(async (db) => {
      const admin = await insertUser(db, 'create-admin-2', 'admin');
      const service = new OrgAccessService(db, new NotificationsService(db));

      await service.create(actorFor(admin.id, 'admin'), { slug: 'dup-club', name: 'Dup Club' });
      await expect(
        service.create(actorFor(admin.id, 'admin'), { slug: 'DUP-CLUB', name: 'Dup Club Again' }),
      ).rejects.toMatchObject({ status: 409, code: 'organization_slug_taken' });
    });
  }, 120_000);
});

describe('OrgAccessService.update', () => {
  it('404s an unknown slug', async () => {
    await withTestDb(async (db) => {
      const admin = await insertUser(db, 'upd-admin', 'admin');
      const service = new OrgAccessService(db, new NotificationsService(db));
      await expect(
        service.update(actorFor(admin.id, 'admin'), 'does-not-exist', { name: 'x' }),
      ).rejects.toMatchObject({ status: 404, code: 'organization_not_found' });
    });
  }, 120_000);

  /**
   * The ordering property spec item 1 names: an invisible organization must
   * 404 regardless of what the patch contains — even a patch guaranteed to
   * fail for a completely unrelated reason once applied (here: renaming to a
   * slug that already belongs to another organization). If the visibility
   * check ran after patch application (or after the conflict check), a
   * stranger to a private org could distinguish "org exists, patch failed"
   * (409/400) from "org exists, patch would have worked" — an existence
   * oracle. `loadForEdit`'s 404 must win regardless.
   */
  it('an invisible org 404s even for a patch that would otherwise conflict (visibility precedes patch handling)', async () => {
    await withTestDb(async (db) => {
      const stranger = await insertUser(db, 'ordering-stranger');
      await seedOrg(db, { slug: 'taken-slug', name: 'Taken', visibility: 'public' });
      await seedOrg(db, { slug: 'secret-org', name: 'Secret', visibility: 'private' });
      const service = new OrgAccessService(db, new NotificationsService(db));

      await expect(
        service.update(actorFor(stranger.id), 'secret-org', { slug: 'taken-slug' }),
      ).rejects.toMatchObject({ status: 404, code: 'organization_not_found' });

      // Confirm the org truly was untouched — the 404 was not a coincidental
      // side effect of some other failure.
      const [row] = await db.select().from(organizations).where(eq(organizations.slug, 'secret-org'));
      expect(row).toBeDefined();
    });
  }, 120_000);

  it('a visible org a plain member (not owner/admin) may not edit is a 403, not a 404', async () => {
    await withTestDb(async (db) => {
      const member = await insertUser(db, 'plain-member');
      const org = await seedOrg(db, { slug: 'member-org', name: 'Member Org', visibility: 'public' });
      await db.insert(orgMembers).values({ orgId: org.id, userId: member.id, role: 'member' });
      const service = new OrgAccessService(db, new NotificationsService(db));

      await expect(
        service.update(actorFor(member.id), 'member-org', { name: 'New Name' }),
      ).rejects.toMatchObject({ status: 403, code: 'organization_forbidden' });
    });
  }, 120_000);

  it('lets an owner, an org-admin, and a global admin (non-member) all edit', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'org-owner');
      const orgAdmin = await insertUser(db, 'org-admin-member');
      const globalAdmin = await insertUser(db, 'global-admin-1', 'admin');
      const org = await seedOrg(db, { slug: 'edit-org', name: 'Edit Org', visibility: 'public' });
      await db.insert(orgMembers).values([
        { orgId: org.id, userId: owner.id, role: 'owner' },
        { orgId: org.id, userId: orgAdmin.id, role: 'admin' },
      ]);
      const service = new OrgAccessService(db, new NotificationsService(db));

      const r1 = await service.update(actorFor(owner.id), 'edit-org', { name: 'By Owner' });
      expect(r1.name).toBe('By Owner');
      const r2 = await service.update(actorFor(orgAdmin.id), 'edit-org', { name: 'By Org Admin' });
      expect(r2.name).toBe('By Org Admin');
      const r3 = await service.update(actorFor(globalAdmin.id, 'admin'), 'edit-org', { name: 'By Global Admin' });
      expect(r3.name).toBe('By Global Admin');
    });
  }, 120_000);

  it('renames the slug, and a rename to a mere case-variant of its own current slug succeeds', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'rename-owner');
      const org = await seedOrg(db, { slug: 'old-name', name: 'Old', visibility: 'public' });
      await db.insert(orgMembers).values({ orgId: org.id, userId: owner.id, role: 'owner' });
      const service = new OrgAccessService(db, new NotificationsService(db));

      const renamed = await service.update(actorFor(owner.id), 'old-name', { slug: 'new-name' });
      expect(renamed.slug).toBe('new-name');

      // The unique index is on lower(slug): renaming to a pure case-variant
      // of the SAME row's current slug must not spuriously collide with
      // itself.
      const sameCase = await service.update(actorFor(owner.id), 'new-name', { slug: 'New-Name' });
      expect(sameCase.slug).toBe('New-Name');
    });
  }, 120_000);

  it('rejects renaming to a slug already taken by another org, case-insensitively, as 409', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'conflict-owner');
      const org = await seedOrg(db, { slug: 'mine', name: 'Mine', visibility: 'public' });
      await seedOrg(db, { slug: 'theirs', name: 'Theirs', visibility: 'public' });
      await db.insert(orgMembers).values({ orgId: org.id, userId: owner.id, role: 'owner' });
      const service = new OrgAccessService(db, new NotificationsService(db));

      await expect(
        service.update(actorFor(owner.id), 'mine', { slug: 'THEIRS' }),
      ).rejects.toMatchObject({ status: 409, code: 'organization_slug_taken' });
    });
  }, 120_000);

  it('looks up the target org case-insensitively, matching organizations_slug_lower_idx', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'case-owner');
      const org = await seedOrg(db, { slug: 'MixedCase-Org', name: 'Mixed', visibility: 'public' });
      await db.insert(orgMembers).values({ orgId: org.id, userId: owner.id, role: 'owner' });
      const service = new OrgAccessService(db, new NotificationsService(db));

      const result = await service.update(actorFor(owner.id), 'mixedcase-org', { name: 'Updated' });
      expect(result.name).toBe('Updated');
    });
  }, 120_000);
});

describe('OrgAccessService.listMembers', () => {
  it('404s a private org an outsider cannot see', async () => {
    await withTestDb(async (db) => {
      const outsider = await insertUser(db, 'lm-outsider');
      await seedOrg(db, { slug: 'lm-private', name: 'Private', visibility: 'private' });
      const service = new OrgAccessService(db, new NotificationsService(db));

      await expect(service.listMembers(actorFor(outsider.id), 'lm-private')).rejects.toMatchObject({
        status: 404,
        code: 'organization_not_found',
      });
      await expect(service.listMembers(null, 'lm-private')).rejects.toMatchObject({ status: 404 });
    });
  }, 120_000);

  it('lists exactly the members of a public org, for an anonymous caller too — no extra membership gate', async () => {
    await withTestDb(async (db) => {
      const alice = await insertUser(db, 'lm-alice');
      const bob = await insertUser(db, 'lm-bob');
      const org = await seedOrg(db, { slug: 'lm-public', name: 'Public', visibility: 'public' });
      await db.insert(orgMembers).values([
        { orgId: org.id, userId: alice.id, role: 'owner' },
        { orgId: org.id, userId: bob.id, role: 'member' },
      ]);
      const service = new OrgAccessService(db, new NotificationsService(db));

      const members = await service.listMembers(null, 'lm-public');
      expect(members.map((m) => ({ username: m.username, role: m.role })).sort((a, b) => a.username.localeCompare(b.username))).toEqual(
        [
          { username: 'lm-alice', role: 'owner' },
          { username: 'lm-bob', role: 'member' },
        ],
      );
    });
  }, 120_000);

  it('lists a private org for a member, but 404s the same org for a non-member', async () => {
    await withTestDb(async (db) => {
      const member = await insertUser(db, 'lm-member');
      const outsider = await insertUser(db, 'lm-outsider-2');
      const org = await seedOrg(db, { slug: 'lm-secret', name: 'Secret', visibility: 'private' });
      await db.insert(orgMembers).values({ orgId: org.id, userId: member.id, role: 'member' });
      const service = new OrgAccessService(db, new NotificationsService(db));

      const members = await service.listMembers(actorFor(member.id), 'lm-secret');
      expect(members.map((m) => m.username)).toEqual(['lm-member']);

      await expect(service.listMembers(actorFor(outsider.id), 'lm-secret')).rejects.toMatchObject({
        status: 404,
      });
    });
  }, 120_000);
});
