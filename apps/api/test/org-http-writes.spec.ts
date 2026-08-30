import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { organizations, orgMembers } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { OrgMemberPage, OrgSummary } from '@duckoj/contracts';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin } from './submissions.fixtures.js';

async function makeAdmin(db: Db, username: string): Promise<void> {
  await db.update(schema.users).set({ globalRole: 'admin' }).where(eq(schema.users.username, username));
}

describe('POST /orgs over HTTP', () => {
  it('401s anonymous, 403s a signed-in non-admin, and 201s an admin — with the response satisfying OrgSummary', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const anon = await request(app.getHttpServer()).post('/orgs').send({ slug: 'anon-club', name: 'Anon Club' });
        expect(anon.status).toBe(401);

        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'orgs-http-plain');
        const plain = await agent.post('/orgs').send({ slug: 'plain-club', name: 'Plain Club' });
        expect(plain.status).toBe(403);
        expect(plain.body.code).toBe('organization_forbidden');

        const adminAgent = request.agent(app.getHttpServer());
        await registerAndLogin(adminAgent, 'orgs-http-admin');
        await makeAdmin(db, 'orgs-http-admin');
        const created = await adminAgent.post('/orgs').send({ slug: 'admin-club', name: 'Admin Club' });
        expect(created.status).toBe(201);
        const parsed = OrgSummary.parse(created.body);
        expect(parsed.slug).toBe('admin-club');
        expect(parsed.visibility).toBe('private');

        const members = await db.select().from(orgMembers).where(eq(orgMembers.orgId, parsed.id));
        expect(members).toHaveLength(1);
        expect(members[0]!.role).toBe('owner');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('409s an exact-duplicate slug over HTTP, and 422s a malformed one (the wire schema is lowercase-only, so a case-variant duplicate is exercised at the service level instead — see org-writes.spec.ts)', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const adminAgent = request.agent(app.getHttpServer());
        await registerAndLogin(adminAgent, 'orgs-http-admin-2');
        await makeAdmin(db, 'orgs-http-admin-2');

        const first = await adminAgent.post('/orgs').send({ slug: 'dup-http', name: 'Dup' });
        expect(first.status).toBe(201);

        const dup = await adminAgent.post('/orgs').send({ slug: 'dup-http', name: 'Dup Again' });
        expect(dup.status).toBe(409);
        expect(dup.body.code).toBe('organization_slug_taken');

        const bad = await adminAgent.post('/orgs').send({ slug: 'Not A Valid Slug!', name: 'Bad' });
        expect(bad.status).toBe(422);
        expect(bad.body.code).toBe('validation_failed');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('PATCH /orgs/:slug over HTTP', () => {
  it('404s a private org a stranger cannot see even with a patch that would otherwise 409', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await db.insert(organizations).values({ slug: 'taken-http', name: 'Taken', visibility: 'public' });
        await db.insert(organizations).values({ slug: 'secret-http', name: 'Secret', visibility: 'private' });

        const strangerAgent = request.agent(app.getHttpServer());
        await registerAndLogin(strangerAgent, 'orgs-http-stranger');

        const res = await strangerAgent.patch('/orgs/secret-http').send({ slug: 'taken-http' });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('organization_not_found');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('403s a plain member, 200s the owner', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const [org] = await db
          .insert(organizations)
          .values({ slug: 'http-member-org', name: 'Member Org', visibility: 'public' })
          .returning();

        const ownerAgent = request.agent(app.getHttpServer());
        await registerAndLogin(ownerAgent, 'orgs-http-owner');
        const [owner] = await db.select().from(schema.users).where(eq(schema.users.username, 'orgs-http-owner'));

        const memberAgent = request.agent(app.getHttpServer());
        await registerAndLogin(memberAgent, 'orgs-http-member');
        const [member] = await db.select().from(schema.users).where(eq(schema.users.username, 'orgs-http-member'));

        await db.insert(orgMembers).values([
          { orgId: org!.id, userId: owner!.id, role: 'owner' },
          { orgId: org!.id, userId: member!.id, role: 'member' },
        ]);

        const forbidden = await memberAgent.patch('/orgs/http-member-org').send({ name: 'Nope' });
        expect(forbidden.status).toBe(403);
        expect(forbidden.body.code).toBe('organization_forbidden');

        const ok = await ownerAgent.patch('/orgs/http-member-org').send({ name: 'Renamed' });
        expect(ok.status).toBe(200);
        expect(OrgSummary.parse(ok.body).name).toBe('Renamed');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('GET /orgs/:slug/members over HTTP', () => {
  it('serves a public org roster to anonymous callers, and 404s a private one', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const [pub] = await db
          .insert(organizations)
          .values({ slug: 'http-pub-members', name: 'Pub', visibility: 'public' })
          .returning();
        const [priv] = await db
          .insert(organizations)
          .values({ slug: 'http-priv-members', name: 'Priv', visibility: 'private' })
          .returning();

        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'orgs-http-member-viewer');
        const [user] = await db.select().from(schema.users).where(eq(schema.users.username, 'orgs-http-member-viewer'));
        await db.insert(orgMembers).values([
          { orgId: pub!.id, userId: user!.id, role: 'member' },
          { orgId: priv!.id, userId: user!.id, role: 'member' },
        ]);

        const anonPub = await request(app.getHttpServer()).get('/orgs/http-pub-members/members');
        expect(anonPub.status).toBe(200);
        const page = OrgMemberPage.parse(anonPub.body);
        expect(page.items.map((m) => m.username)).toEqual(['orgs-http-member-viewer']);
        expect(page.nextCursor).toBeNull();

        const anonPriv = await request(app.getHttpServer()).get('/orgs/http-priv-members/members');
        expect(anonPriv.status).toBe(404);
        expect(anonPriv.body.code).toBe('organization_not_found');

        const memberPriv = await agent.get('/orgs/http-priv-members/members');
        expect(memberPriv.status).toBe(200);
        expect(OrgMemberPage.parse(memberPriv.body).items.map((m) => m.username)).toEqual(['orgs-http-member-viewer']);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
