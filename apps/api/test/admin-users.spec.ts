import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { schema } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin } from './submissions.fixtures.js';

// `registerAndLogin` always produces a plain `user` — registration has no
// path to `admin`. Elevating this way (a direct write, after the HTTP login)
// mirrors `problems-http.spec.ts`'s setter tests and is the only way to get
// an admin session at all in these tests.

describe('PATCH /admin/users/:username over HTTP', () => {
  it(
    'an admin grants setter and the target can then create a problem — session established before the grant',
    async () => {
      await withTestDb(async (db) => {
        const app = await buildApp(db);
        try {
          // The target's session is established FIRST, before any grant
          // exists at all. If `Actor.globalRole` were baked into a cached
          // session payload at login time (rather than re-read from the
          // database on every request, as `SessionService.resolve` and
          // `TokenService.resolve` both do), this exact ordering is what
          // would catch it: a fresh login *after* the grant would pass even
          // with a stale cache and prove nothing.
          const targetAgent = request.agent(app.getHttpServer());
          await registerAndLogin(targetAgent, 'promote-target');

          const adminAgent = request.agent(app.getHttpServer());
          await registerAndLogin(adminAgent, 'promote-admin');
          await db.update(schema.users).set({ globalRole: 'admin' }).where(eq(schema.users.username, 'promote-admin'));

          const grant = await adminAgent.patch('/admin/users/promote-target').send({ globalRole: 'setter' });
          expect(grant.status).toBe(200);
          expect(grant.body).toMatchObject({ username: 'promote-target', globalRole: 'setter' });

          // The same, already-established session — no re-login.
          const created = await targetAgent
            .post('/problems')
            .send({ code: 'promoted-create', name: 'Promoted Create', statement: 'A statement.' });
          expect(created.status).toBe(201);
          expect(created.body.code).toBe('promoted-create');
        } finally {
          await app.close();
        }
      });
    },
    120_000,
  );

  it('a non-admin gets 403', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await registerAndLogin(request.agent(app.getHttpServer()), 'admin-403-target');

        const plainAgent = request.agent(app.getHttpServer());
        await registerAndLogin(plainAgent, 'admin-403-plain');

        const res = await plainAgent.patch('/admin/users/admin-403-target').send({ globalRole: 'setter' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('admin_forbidden');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('a setter cannot grant themselves admin', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const setterAgent = request.agent(app.getHttpServer());
        await registerAndLogin(setterAgent, 'self-promote-setter');
        await db.update(schema.users).set({ globalRole: 'setter' }).where(eq(schema.users.username, 'self-promote-setter'));

        const res = await setterAgent.patch('/admin/users/self-promote-setter').send({ globalRole: 'admin' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('admin_forbidden');

        const [row] = await db.select().from(schema.users).where(eq(schema.users.username, 'self-promote-setter'));
        expect(row!.globalRole).toBe('setter');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('an unknown username gets 404 user_not_found', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const adminAgent = request.agent(app.getHttpServer());
        await registerAndLogin(adminAgent, 'notfound-admin');
        await db.update(schema.users).set({ globalRole: 'admin' }).where(eq(schema.users.username, 'notfound-admin'));

        const res = await adminAgent.patch('/admin/users/no-such-user-at-all').send({ globalRole: 'setter' });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('user_not_found');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('granting a role the enum does not contain is 400', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await registerAndLogin(request.agent(app.getHttpServer()), 'badrole-target');

        const adminAgent = request.agent(app.getHttpServer());
        await registerAndLogin(adminAgent, 'badrole-admin');
        await db.update(schema.users).set({ globalRole: 'admin' }).where(eq(schema.users.username, 'badrole-admin'));

        const res = await adminAgent.patch('/admin/users/badrole-target').send({ globalRole: 'superuser' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('admin_role_invalid');

        const [row] = await db.select().from(schema.users).where(eq(schema.users.username, 'badrole-target'));
        expect(row!.globalRole).toBe('user');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('resolves the target username case-insensitively, matching users_username_lower_idx', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await registerAndLogin(request.agent(app.getHttpServer()), 'MixedCaseTarget');

        const adminAgent = request.agent(app.getHttpServer());
        await registerAndLogin(adminAgent, 'case-admin');
        await db.update(schema.users).set({ globalRole: 'admin' }).where(eq(schema.users.username, 'case-admin'));

        // Deliberately different case than the stored username.
        const res = await adminAgent.patch('/admin/users/mixedcasetarget').send({ globalRole: 'setter' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ username: 'MixedCaseTarget', globalRole: 'setter' });

        const [row] = await db.select().from(schema.users).where(eq(schema.users.username, 'MixedCaseTarget'));
        expect(row!.globalRole).toBe('setter');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
