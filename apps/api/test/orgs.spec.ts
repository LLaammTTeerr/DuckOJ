import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { organizations, orgMembers } from '@qhhoj/db/guarded';
import { schema, type Db } from '@qhhoj/db';
import { OrgPage } from '@qhhoj/contracts';
import { OrgAccessService } from '../src/authz/org.access.js';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';

const PASSWORD = 'a-long-enough-password';

async function seedOrgs(db: Db, memberId: number): Promise<void> {
  await db
    .insert(organizations)
    .values({ slug: 'open-club', name: 'Open Club', visibility: 'public' });
  const [priv] = await db
    .insert(organizations)
    .values({ slug: 'secret-club', name: 'Secret Club', visibility: 'private' })
    .returning();
  await db.insert(orgMembers).values({ orgId: priv!.id, userId: memberId, role: 'member' });
}

describe('GET /orgs over HTTP', () => {
  it('serves anonymous callers public orgs only, and a signed-in member their private one', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await agent
          .post('/auth/register')
          .send({ username: 'nora', email: 'nora@e.com', password: PASSWORD, displayName: 'Nora' });
        await agent.post('/auth/login').send({ usernameOrEmail: 'nora', password: PASSWORD });

        const [user] = await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.username, 'nora'));
        await seedOrgs(db, user!.id);

        // Anonymous: the response must also satisfy the published contract.
        const anon = await request(app.getHttpServer()).get('/orgs');
        expect(anon.status).toBe(200);
        const page = OrgPage.parse(anon.body);
        expect(page.items.map((o) => o.slug)).toEqual(['open-club']);
        expect(page.nextCursor).toBeNull();

        // The very bug a "skip auth on public routes" guard would introduce:
        // a signed-in member must not be treated as anonymous here.
        const asMember = await agent.get('/orgs');
        expect(asMember.status).toBe(200);
        expect(
          OrgPage.parse(asMember.body)
            .items.map((o) => o.slug)
            .sort(),
        ).toEqual(['open-club', 'secret-club']);

        const hidden = await request(app.getHttpServer()).get('/orgs/secret-club');
        expect(hidden.status).toBe(404);
        expect(hidden.headers['content-type']).toContain('application/problem+json');
        expect(hidden.body.code).toBe('organization_not_found');

        expect((await agent.get('/orgs/secret-club')).status).toBe(200);
        expect((await request(app.getHttpServer()).get('/orgs/open-club')).body.slug).toBe(
          'open-club',
        );
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('rejects an out-of-range limit and a non-numeric cursor rather than guessing', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const tooLarge = await request(app.getHttpServer()).get('/orgs?limit=500');
        expect(tooLarge.status).toBe(422);
        expect(tooLarge.body.code).toBe('validation_failed');

        const badCursor = await request(app.getHttpServer()).get('/orgs?cursor=not-a-number');
        expect(badCursor.status).toBe(422);
        expect(badCursor.body.code).toBe('invalid_cursor');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('OrgAccessService pagination', () => {
  it('walks every visible org exactly once across cursor pages', async () => {
    await withTestDb(async (db) => {
      await db.insert(organizations).values([
        { slug: 'alpha', name: 'Alpha', visibility: 'public' },
        { slug: 'bravo', name: 'Bravo', visibility: 'public' },
        { slug: 'charlie', name: 'Charlie', visibility: 'public' },
        { slug: 'hidden', name: 'Hidden', visibility: 'private' },
      ]);
      const service = new OrgAccessService(db);

      const first = await service.listVisible(null, { limit: 2 });
      expect(first.items.map((o) => o.slug)).toEqual(['alpha', 'bravo']);
      expect(first.nextCursor).toBe(String(first.items.at(-1)!.id));

      const second = await service.listVisible(null, { limit: 2, cursor: first.nextCursor! });
      expect(second.items.map((o) => o.slug)).toEqual(['charlie']);
      expect(second.nextCursor).toBeNull();
    });
  }, 120_000);
});
