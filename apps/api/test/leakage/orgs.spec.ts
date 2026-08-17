import { describe, expect, it } from 'vitest';
import { organizations, orgMembers } from '@qhhoj/db/guarded';
import type { Db } from '@qhhoj/db';
import { schema } from '@qhhoj/db';
import { OrgAccessService } from '../../src/authz/org.access.js';
import type { Actor } from '../../src/authz/actor.js';
import { withTestDb } from '../db.harness.js';

async function seed(db: Db) {
  const [member] = await db
    .insert(schema.users)
    .values({ username: 'm', email: 'm@e.com', passwordHash: 'x', displayName: 'M' })
    .returning();
  const [outsider] = await db
    .insert(schema.users)
    .values({ username: 'o', email: 'o@e.com', passwordHash: 'x', displayName: 'O' })
    .returning();
  const [admin] = await db
    .insert(schema.users)
    .values({
      username: 'a',
      email: 'a@e.com',
      passwordHash: 'x',
      displayName: 'A',
      globalRole: 'admin',
    })
    .returning();

  const [pub] = await db
    .insert(organizations)
    .values({ slug: 'open-club', name: 'Open Club', visibility: 'public' })
    .returning();
  const [priv] = await db
    .insert(organizations)
    .values({ slug: 'secret-club', name: 'Secret Club', visibility: 'private' })
    .returning();

  await db.insert(orgMembers).values({ orgId: priv!.id, userId: member!.id, role: 'member' });

  return {
    actors: {
      anonymous: null,
      member: { userId: member!.id, globalRole: 'user', via: 'session', scopes: [] } as Actor,
      outsider: { userId: outsider!.id, globalRole: 'user', via: 'session', scopes: [] } as Actor,
      admin: { userId: admin!.id, globalRole: 'admin', via: 'session', scopes: [] } as Actor,
    },
    slugs: { pub: pub!.slug, priv: priv!.slug },
  };
}

const EXPECTED_VISIBLE: Record<string, string[]> = {
  anonymous: ['open-club'],
  member: ['open-club', 'secret-club'],
  outsider: ['open-club'],
  admin: ['open-club', 'secret-club'],
};

describe('organization visibility leakage matrix', () => {
  it('shows each actor exactly the organizations it may see', async () => {
    await withTestDb(async (db) => {
      const { actors } = await seed(db);
      const service = new OrgAccessService(db);

      for (const [name, actor] of Object.entries(actors)) {
        const page = await service.listVisible(actor, { limit: 50 });
        expect(page.items.map((o) => o.slug).sort(), `actor: ${name}`).toEqual(
          EXPECTED_VISIBLE[name]!.slice().sort(),
        );
      }
    });
  }, 120_000);

  it('returns 404 — not 403 — for a private org an actor cannot see', async () => {
    await withTestDb(async (db) => {
      const { actors, slugs } = await seed(db);
      const service = new OrgAccessService(db);

      await expect(service.getVisible(actors.outsider, slugs.priv)).rejects.toMatchObject({
        status: 404,
        code: 'organization_not_found',
      });
      await expect(service.getVisible(null, slugs.priv)).rejects.toMatchObject({ status: 404 });
    });
  }, 120_000);

  it('lets a member and an admin fetch the private org', async () => {
    await withTestDb(async (db) => {
      const { actors, slugs } = await seed(db);
      const service = new OrgAccessService(db);

      expect((await service.getVisible(actors.member, slugs.priv)).slug).toBe('secret-club');
      expect((await service.getVisible(actors.admin, slugs.priv)).slug).toBe('secret-club');
    });
  }, 120_000);

  it('reports membership role only for actual members', async () => {
    await withTestDb(async (db) => {
      const { actors, slugs } = await seed(db);
      const service = new OrgAccessService(db);
      const org = await service.getVisible(actors.member, slugs.priv);

      expect(await service.roleIn(actors.member, org.id)).toBe('member');
      expect(await service.roleIn(actors.outsider, org.id)).toBeNull();
      expect(await service.roleIn(null, org.id)).toBeNull();
    });
  }, 120_000);
});
