import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { organizations, orgMembers } from '../src/schema/guarded.js';
import { schema } from '../src/index.js';
import { withTestDb } from './harness.js';

describe('organization schema', () => {
  it('defaults to private visibility and links members with a role', async () => {
    await withTestDb(async (db) => {
      const [user] = await db
        .insert(schema.users)
        .values({
          username: 'carol',
          email: 'carol@example.com',
          passwordHash: 'x',
          displayName: 'Carol',
        })
        .returning();
      const [org] = await db
        .insert(organizations)
        .values({ slug: 'qhh', name: 'QHH' })
        .returning();

      expect(org?.visibility).toBe('private');
      expect(org?.joinPolicy).toBe('request');

      await db
        .insert(orgMembers)
        .values({ orgId: org!.id, userId: user!.id, role: 'owner' });

      const membership = await db
        .select()
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, org!.id), eq(orgMembers.userId, user!.id)));

      expect(membership[0]?.role).toBe('owner');
    });
  }, 120_000);

  it('rejects a duplicate slug differing only in case', async () => {
    await withTestDb(async (db) => {
      await db.insert(organizations).values({ slug: 'club', name: 'Club' });
      await expect(
        db.insert(organizations).values({ slug: 'CLUB', name: 'Club 2' }),
      ).rejects.toThrow();
    });
  }, 120_000);
});
