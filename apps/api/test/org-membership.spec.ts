/**
 * Phase 3e — organization membership.
 *
 * Organizations had a full permission model and no way to join one. The
 * acceptance criterion (design §9) is that an organization can never be left
 * without an owner: every other rule here is recoverable by an administrator,
 * and that one is only repairable by editing the database.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import { orgJoinRequests, orgMembers, organizations } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin, userIdOf } from './submissions.fixtures.js';

type Agent = ReturnType<typeof request.agent>;

async function signIn(app: INestApplication, db: Db, name: string, admin = false): Promise<Agent> {
  const agent = request.agent(app.getHttpServer());
  await registerAndLogin(agent, name);
  if (admin) {
    await db.update(schema.users).set({ globalRole: 'admin' }).where(eq(schema.users.username, name));
  }
  return agent;
}

/** An organization owned by `owner`, with the given join policy. */
async function makeOrg(
  owner: Agent,
  slug: string,
  joinPolicy: 'open' | 'request' | 'invite',
): Promise<void> {
  const res = await owner
    .post('/api/v1/orgs')
    .send({ slug, name: slug, visibility: 'public', joinPolicy });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function roleOf(db: Db, slug: string, username: string): Promise<string | null> {
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug));
  const userId = await userIdOf(db, username);
  const rows = await db
    .select({ role: orgMembers.role, userId: orgMembers.userId })
    .from(orgMembers)
    .where(eq(orgMembers.orgId, org!.id));
  return rows.find((r) => r.userId === userId)?.role ?? null;
}

describe('an organization always has an owner', () => {
  it('refuses the last owner leaving, being demoted, or being removed', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await signIn(app, db, 'lastowner', true);
        await makeOrg(owner, 'solo', 'open');

        // All three routes, because all three could strand the organization
        // and the rule lives in one place precisely so they cannot disagree.
        const left = await owner.delete('/api/v1/orgs/solo/members/lastowner');
        expect(left.status).toBe(409);
        expect(left.body.code).toBe('org_last_owner');

        const demoted = await owner.patch('/api/v1/orgs/solo/members/lastowner').send({ role: 'admin' });
        expect(demoted.status).toBe(409);
        expect(demoted.body.code).toBe('org_last_owner');

        // A *different* global admin is refused too: the invariant is about
        // the organization, not about who is asking.
        const superuser = await signIn(app, db, 'superuser', true);
        const removed = await superuser.delete('/api/v1/orgs/solo/members/lastowner');
        expect(removed.status).toBe(409);

        expect(await roleOf(db, 'solo', 'lastowner')).toBe('owner');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('permits all three once a second owner exists', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await signIn(app, db, 'firstowner', true);
        await signIn(app, db, 'secondowner');
        await makeOrg(owner, 'duo', 'open');
        expect(
          (await owner.post('/api/v1/orgs/duo/members').send({ username: 'secondowner', role: 'owner' }))
            .status,
        ).toBe(201);

        // The rule is "the last one", not "owners are immovable" — without
        // this, refusing every owner removal would pass the test above.
        expect((await owner.patch('/api/v1/orgs/duo/members/firstowner').send({ role: 'admin' })).status).toBe(200);
        expect(await roleOf(db, 'duo', 'firstowner')).toBe('admin');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('joining', () => {
  it('distinguishes the three policies by status code', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await signIn(app, db, 'policyowner', true);
        for (const policy of ['open', 'request', 'invite'] as const) {
          await makeOrg(owner, `p-${policy}`, policy);
        }
        const joiner = await signIn(app, db, 'joiner');

        const open = await joiner.post('/api/v1/orgs/p-open/join');
        expect(open.status).toBe(201);
        expect(open.body.outcome).toBe('joined');

        // 202, not 201: nothing was created that the caller can read back as a
        // membership, and a client checking for 201 must not think it joined.
        const asked = await joiner.post('/api/v1/orgs/p-request/join');
        expect(asked.status).toBe(202);
        expect(asked.body.outcome).toBe('requested');
        expect(asked.body.role).toBeNull();

        const invite = await joiner.post('/api/v1/orgs/p-invite/join');
        expect(invite.status).toBe(403);
        expect(invite.body.code).toBe('org_invite_only');

        expect(await roleOf(db, 'p-open', 'joiner')).toBe('member');
        expect(await roleOf(db, 'p-request', 'joiner')).toBeNull();
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('keeps one pending request however many times it is asked for', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await signIn(app, db, 'reqowner', true);
        await makeOrg(owner, 'reqorg', 'request');
        const joiner = await signIn(app, db, 'reqjoiner');

        // Concurrent, not sequential: a read-then-write pre-check passes the
        // sequential version and races to two rows here. The partial unique
        // index is what actually prevents the second.
        const results = await Promise.all([
          joiner.post('/api/v1/orgs/reqorg/join'),
          joiner.post('/api/v1/orgs/reqorg/join'),
          joiner.post('/api/v1/orgs/reqorg/join'),
        ]);
        expect(results.every((res) => res.status === 202)).toBe(true);

        const pending = await owner.get('/api/v1/orgs/reqorg/requests');
        expect(pending.status).toBe(200);
        // `.items` since D181: the queue answers a bounded PAGE, not the
        // whole of itself in one array.
        expect(pending.body.items).toHaveLength(1);
        expect(pending.body.nextCursor).toBeNull();
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('lets a rejected user ask again', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await signIn(app, db, 'rejowner', true);
        await makeOrg(owner, 'rejorg', 'request');
        const joiner = await signIn(app, db, 'rejjoiner');

        await joiner.post('/api/v1/orgs/rejorg/join');
        const [first] = (await owner.get('/api/v1/orgs/rejorg/requests')).body.items as { id: number }[];
        expect((await owner.post(`/api/v1/orgs/rejorg/requests/${String(first!.id)}/reject`)).status).toBe(200);

        // A rejection is a decision about a moment, not a ban — which is why
        // the uniqueness index is partial on `state = 'pending'`.
        expect((await joiner.post('/api/v1/orgs/rejorg/join')).status).toBe(202);
        expect((await owner.get('/api/v1/orgs/rejorg/requests')).body.items).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses a member who asks again', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await signIn(app, db, 'dupowner', true);
        await makeOrg(owner, 'duporg', 'open');
        const joiner = await signIn(app, db, 'dupjoiner');
        expect((await joiner.post('/api/v1/orgs/duporg/join')).status).toBe(201);
        expect((await joiner.post('/api/v1/orgs/duporg/join')).status).toBe(409);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('deciding a request', () => {
  it('creates the membership and marks the request in one step', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await signIn(app, db, 'decowner', true);
        await makeOrg(owner, 'decorg', 'request');
        const joiner = await signIn(app, db, 'decjoiner');
        await joiner.post('/api/v1/orgs/decorg/join');
        const [pending] = (await owner.get('/api/v1/orgs/decorg/requests')).body.items as { id: number }[];

        const approved = await owner.post(`/api/v1/orgs/decorg/requests/${String(pending!.id)}/approve`);
        expect(approved.status).toBe(200);
        expect((approved.body as { items: { username: string }[] }).items.map((m) => m.username)).toContain('decjoiner');
        expect(await roleOf(db, 'decorg', 'decjoiner')).toBe('member');

        const [row] = await db
          .select({ state: orgJoinRequests.state, decidedBy: orgJoinRequests.decidedBy })
          .from(orgJoinRequests)
          .where(eq(orgJoinRequests.id, pending!.id));
        expect(row!.state).toBe('approved');
        // These columns have existed since Phase 3c and nothing had ever
        // written them.
        expect(row!.decidedBy).toBe(await userIdOf(db, 'decowner'));

        // 409, not a silent no-op: the second decider believes they are acting
        // on a live request.
        const again = await owner.post(`/api/v1/orgs/decorg/requests/${String(pending!.id)}/reject`);
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('join_request_decided');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('hides the queue from members and non-members alike', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await signIn(app, db, 'qowner', true);
        await makeOrg(owner, 'qorg', 'open');
        const plain = await signIn(app, db, 'qmember');
        await plain.post('/api/v1/orgs/qorg/join');
        const outsider = await signIn(app, db, 'qoutsider');

        expect((await plain.get('/api/v1/orgs/qorg/requests')).status).toBe(403);
        expect((await outsider.get('/api/v1/orgs/qorg/requests')).status).toBe(403);
        expect((await owner.get('/api/v1/orgs/qorg/requests')).status).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('who may act on whom', () => {
  it('lets an admin remove a member but not another admin or the owner', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await signIn(app, db, 'rankowner', true);
        await makeOrg(owner, 'rankorg', 'open');
        for (const name of ['adminone', 'admintwo', 'plainmember']) await signIn(app, db, name);
        await owner.post('/api/v1/orgs/rankorg/members').send({ username: 'adminone', role: 'admin' });
        await owner.post('/api/v1/orgs/rankorg/members').send({ username: 'admintwo', role: 'admin' });
        await owner.post('/api/v1/orgs/rankorg/members').send({ username: 'plainmember' });

        // A fresh agent signed in as the org admin, to act with their rights.
        const orgAdmin = request.agent(app.getHttpServer());
        await orgAdmin.post('/api/v1/auth/login').send({ usernameOrEmail: 'adminone', password: 'a-long-enough-password' });

        // Strictly below, not below-or-equal: an admin removing another admin
        // reads identically in code and is the off-by-one this pins.
        expect((await orgAdmin.delete('/api/v1/orgs/rankorg/members/admintwo')).status).toBe(403);
        expect((await orgAdmin.delete('/api/v1/orgs/rankorg/members/rankowner')).status).toBe(403);
        expect((await orgAdmin.delete('/api/v1/orgs/rankorg/members/plainmember')).status).toBe(200);

        // The owner outranks everyone.
        expect((await owner.delete('/api/v1/orgs/rankorg/members/admintwo')).status).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('lets an org admin add a member but not grant a rank', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await signIn(app, db, 'grantowner', true);
        await makeOrg(owner, 'grantorg', 'open');
        for (const name of ['grantadmin', 'newbie']) await signIn(app, db, name);
        await owner.post('/api/v1/orgs/grantorg/members').send({ username: 'grantadmin', role: 'admin' });

        const orgAdmin = request.agent(app.getHttpServer());
        await orgAdmin
          .post('/api/v1/auth/login')
          .send({ usernameOrEmail: 'grantadmin', password: 'a-long-enough-password' });

        // An org admin passes the edit check, so this rule is the only thing
        // between them and minting an owner. A plain member is stopped earlier
        // and therefore never reaches it — which is why that test does not
        // cover this one.
        expect(
          (await orgAdmin.post('/api/v1/orgs/grantorg/members').send({ username: 'newbie', role: 'owner' }))
            .status,
        ).toBe(403);
        expect(
          (await orgAdmin.post('/api/v1/orgs/grantorg/members').send({ username: 'newbie', role: 'admin' }))
            .status,
        ).toBe(403);
        // …but adding a plain member is squarely theirs to do.
        expect(
          (await orgAdmin.post('/api/v1/orgs/grantorg/members').send({ username: 'newbie' })).status,
        ).toBe(201);
        expect(await roleOf(db, 'grantorg', 'newbie')).toBe('member');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('lets anyone leave by naming themselves', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await signIn(app, db, 'leaveowner', true);
        await makeOrg(owner, 'leaveorg', 'open');
        const member = await signIn(app, db, 'leaver');
        await member.post('/api/v1/orgs/leaveorg/join');
        expect(await roleOf(db, 'leaveorg', 'leaver')).toBe('member');

        expect((await member.delete('/api/v1/orgs/leaveorg/members/leaver')).status).toBe(200);
        expect(await roleOf(db, 'leaveorg', 'leaver')).toBeNull();
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses a plain member granting themselves a role', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await signIn(app, db, 'escowner', true);
        await makeOrg(owner, 'escorg', 'open');
        const member = await signIn(app, db, 'escalator');
        await member.post('/api/v1/orgs/escorg/join');

        expect((await member.patch('/api/v1/orgs/escorg/members/escalator').send({ role: 'owner' })).status).toBe(403);
        expect((await member.post('/api/v1/orgs/escorg/members').send({ username: 'escalator' })).status).toBe(403);
        expect(await roleOf(db, 'escorg', 'escalator')).toBe('member');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
