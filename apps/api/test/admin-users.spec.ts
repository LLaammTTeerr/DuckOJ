import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { authenticator } from '@otplib/preset-default';
import { schema, type Db } from '@duckoj/db';
import { DB } from '../src/config/config.module.js';
import { TotpService } from '../src/authn/totp.service.js';
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

  it(
    "a scoped access token gets 403 session_required on the grant route; the same admin's session gets 200",
    async () => {
      await withTestDb(async (db) => {
        const app = await buildApp(db);
        try {
          const adminAgent = request.agent(app.getHttpServer());
          await registerAndLogin(adminAgent, 'token-guard-admin');
          await db.update(schema.users).set({ globalRole: 'admin' }).where(eq(schema.users.username, 'token-guard-admin'));

          await registerAndLogin(request.agent(app.getHttpServer()), 'token-guard-victim');

          // Minted over the session — deliberately scoped narrowly
          // (`submissions:read`), to make the point that `Actor.scopes`
          // constrains nothing outside `SessionOnlyGuard` itself: any valid
          // token from this admin carries their full authority regardless of
          // its declared scopes. `AdminUsersController` is `@SessionOnly()`,
          // which also tells `ScopeGuard` to defer rather than shadow it
          // with its own deny-by-default `scope_required`.
          const minted = await adminAgent.post('/auth/tokens').send({ name: 'probe', scopes: ['submissions:read'] });
          expect(minted.status).toBe(201);
          const { token } = minted.body as { token: string };

          const byToken = await request(app.getHttpServer())
            .patch('/admin/users/token-guard-victim')
            .set('Authorization', `Bearer ${token}`)
            .send({ globalRole: 'admin' });
          expect(byToken.status).toBe(403);
          expect(byToken.body.code).toBe('session_required');

          const [victimAfterToken] = await db.select().from(schema.users).where(eq(schema.users.username, 'token-guard-victim'));
          expect(victimAfterToken!.globalRole).toBe('user');

          // The same admin's session succeeds — the guard rejects the
          // credential kind, not the actor.
          const bySession = await adminAgent.patch('/admin/users/token-guard-victim').send({ globalRole: 'admin' });
          expect(bySession.status).toBe(200);
        } finally {
          await app.close();
        }
      });
    },
    120_000,
  );

  it('refuses to let an admin demote themselves out of admin, comparing by id (not username string)', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const adminAgent = request.agent(app.getHttpServer());
        await registerAndLogin(adminAgent, 'SelfDemoteAdmin');
        await db.update(schema.users).set({ globalRole: 'admin' }).where(eq(schema.users.username, 'SelfDemoteAdmin'));

        // Deliberately different case than the stored username: the
        // self-demotion check must still recognise this as "self" by
        // resolving to the same user id, not by comparing strings.
        const res = await adminAgent.patch('/admin/users/selfdemoteadmin').send({ globalRole: 'setter' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('admin_self_demotion');

        const [row] = await db.select().from(schema.users).where(eq(schema.users.username, 'SelfDemoteAdmin'));
        expect(row!.globalRole).toBe('admin');

        // Demoting a *different* admin is unaffected — only self-demotion is refused.
        const otherAgent = request.agent(app.getHttpServer());
        await registerAndLogin(otherAgent, 'other-admin-target');
        await db.update(schema.users).set({ globalRole: 'admin' }).where(eq(schema.users.username, 'other-admin-target'));

        const demoteOther = await adminAgent.patch('/admin/users/other-admin-target').send({ globalRole: 'setter' });
        expect(demoteOther.status).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

/**
 * M9 — `DELETE /admin/users/{username}/totp`.
 *
 * TOTP was a one-way door: `DELETE /auth/totp` sits behind the very factor
 * that was lost, password reset does not clear it, and there were no recovery
 * codes and no admin surface anywhere. A contestant who enrolled the night
 * before and wiped their phone was locked out permanently, with nothing an
 * organiser could do on contest morning.
 */
describe('DELETE /admin/users/:username/totp over HTTP', () => {
  /** Enrols and confirms TOTP for `username`, the way the routes would. */
  async function enrolTotp(app: Awaited<ReturnType<typeof buildApp>>, username: string) {
    const totp = app.get(TotpService);
    const userId = (
      await (app.get(DB) as Db)
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.username, username))
    )[0]!.id;
    const { secret } = await totp.beginEnrolment(userId);
    await totp.confirmEnrolment(userId, authenticator.generate(secret));
    expect(await totp.isEnabled(userId)).toBe(true);
    return userId;
  }

  it('disables the lost authenticator, answers 204, and tells the user', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await registerAndLogin(request.agent(app.getHttpServer()), 'totp-lost');
        const userId = await enrolTotp(app, 'totp-lost');

        const adminAgent = request.agent(app.getHttpServer());
        await registerAndLogin(adminAgent, 'totp-admin');
        await db
          .update(schema.users)
          .set({ globalRole: 'admin' })
          .where(eq(schema.users.username, 'totp-admin'));

        const res = await adminAgent.delete('/admin/users/totp-lost/totp');
        expect(res.status).toBe(204);
        expect(await app.get(TotpService).isEnabled(userId)).toBe(false);

        // The account's second factor was removed by somebody else. That is
        // exactly the kind of thing its holder must not discover by accident.
        const notes = await db
          .select({ kind: schema.notifications.kind, userId: schema.notifications.userId })
          .from(schema.notifications)
          .where(eq(schema.notifications.userId, userId));
        expect(notes).toEqual([{ kind: 'totp_reset', userId }]);

        // Idempotent: an admin who clicks twice, or who resets an account
        // that never had TOTP, gets the same 204 — "disabled, or was already
        // off", the same shape `DELETE /auth/totp` documents.
        expect((await adminAgent.delete('/admin/users/totp-lost/totp')).status).toBe(204);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('is 404 for an unknown user and 403 for a non-admin', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await registerAndLogin(request.agent(app.getHttpServer()), 'totp-victim');

        const plainAgent = request.agent(app.getHttpServer());
        await registerAndLogin(plainAgent, 'totp-plain');
        const forbidden = await plainAgent.delete('/admin/users/totp-victim/totp');
        expect(forbidden.status).toBe(403);
        expect(forbidden.body.code).toBe('admin_forbidden');

        const adminAgent = request.agent(app.getHttpServer());
        await registerAndLogin(adminAgent, 'totp-admin2');
        await db
          .update(schema.users)
          .set({ globalRole: 'admin' })
          .where(eq(schema.users.username, 'totp-admin2'));
        const missing = await adminAgent.delete('/admin/users/nobody-here/totp');
        expect(missing.status).toBe(404);
        expect(missing.body.code).toBe('user_not_found');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses an access token — credential surfaces are session-only', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await registerAndLogin(request.agent(app.getHttpServer()), 'totp-target3');
        const adminAgent = request.agent(app.getHttpServer());
        await registerAndLogin(adminAgent, 'totp-admin3');
        await db
          .update(schema.users)
          .set({ globalRole: 'admin' })
          .where(eq(schema.users.username, 'totp-admin3'));

        const minted = await adminAgent
          .post('/auth/tokens')
          .send({ name: 'ci', scopes: ['users:read'] });
        expect(minted.status).toBe(201);

        const res = await request(app.getHttpServer())
          .delete('/admin/users/totp-target3/totp')
          .set('Authorization', `Bearer ${String(minted.body.token)}`);
        expect(res.status).toBe(403);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
