import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { schema } from '@qhhoj/db';
import { SessionService } from '../src/authn/session.service.js';
import { buildApp, TEST_CONFIG } from './app.harness.js';
import { withTestDb } from './db.harness.js';

const config = { sessionTtlHours: 720 } as never;

describe('SessionService', () => {
  it('issues a token that resolves to the owning actor', async () => {
    await withTestDb(async (db) => {
      const [user] = await db
        .insert(schema.users)
        .values({ username: 'gina', email: 'g@e.com', passwordHash: 'x', displayName: 'G' })
        .returning();
      const service = new SessionService(db, config);

      const { token } = await service.issue(user!.id, {});
      const actor = await service.resolve(token);

      expect(actor?.userId).toBe(user!.id);
      expect(actor?.via).toBe('session');
    });
  }, 120_000);

  it('stores only a hash — the raw token never appears in the table', async () => {
    await withTestDb(async (db) => {
      const [user] = await db
        .insert(schema.users)
        .values({ username: 'hana', email: 'h@e.com', passwordHash: 'x', displayName: 'H' })
        .returning();
      const service = new SessionService(db, config);

      const { token } = await service.issue(user!.id, {});
      const rows = await db.select().from(schema.sessions);

      expect(rows[0]?.tokenHash).not.toBe(token);
      expect(rows.map((r) => r.tokenHash)).not.toContain(token);
    });
  }, 120_000);

  it('returns null for an unknown token', async () => {
    await withTestDb(async (db) => {
      const service = new SessionService(db, config);
      expect(await service.resolve('nonsense')).toBeNull();
    });
  }, 120_000);

  it('returns null for an expired session', async () => {
    await withTestDb(async (db) => {
      const [user] = await db
        .insert(schema.users)
        .values({ username: 'ivan', email: 'i@e.com', passwordHash: 'x', displayName: 'I' })
        .returning();
      const service = new SessionService(db, { sessionTtlHours: -1 } as never);
      const { token } = await service.issue(user!.id, {});
      expect(await service.resolve(token)).toBeNull();
    });
  }, 120_000);

  it('revokes a session immediately', async () => {
    await withTestDb(async (db) => {
      const [user] = await db
        .insert(schema.users)
        .values({ username: 'jane', email: 'j@e.com', passwordHash: 'x', displayName: 'J' })
        .returning();
      const service = new SessionService(db, config);
      const { token } = await service.issue(user!.id, {});
      await service.revoke(token);
      expect(await service.resolve(token)).toBeNull();
    });
  }, 120_000);

  it('returns null once the owning user is suspended, even with a valid unexpired token', async () => {
    await withTestDb(async (db) => {
      const [user] = await db
        .insert(schema.users)
        .values({ username: 'kara', email: 'k@e.com', passwordHash: 'x', displayName: 'K' })
        .returning();
      const service = new SessionService(db, config);
      const { token } = await service.issue(user!.id, {});

      await db.update(schema.users).set({ status: 'suspended' }).where(eq(schema.users.id, user!.id));

      expect(await service.resolve(token)).toBeNull();
    });
  }, 120_000);
});

describe('login / logout / me', () => {
  it('logs in, reads me with the cookie, then logs out and is rejected', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());

        await agent.post('/auth/register').send({
          username: 'kim',
          email: 'kim@example.com',
          password: 'a-long-enough-password',
          displayName: 'Kim',
        });

        const login = await agent
          .post('/auth/login')
          .send({ usernameOrEmail: 'kim', password: 'a-long-enough-password' });
        expect(login.status).toBe(200);
        const loginCookie = login.headers['set-cookie'][0] as string;
        expect(loginCookie).toContain('HttpOnly');
        expect(loginCookie).toContain('SameSite=Lax');
        expect(loginCookie).toContain('Path=/');
        expect(loginCookie).toMatch(/Expires=/);

        const me = await agent.get('/auth/me');
        expect(me.status).toBe(200);
        expect(me.body.username).toBe('kim');

        const logout = await agent.post('/auth/logout');
        expect(logout.status).toBe(204);
        const logoutCookie = logout.headers['set-cookie'][0] as string;
        expect(logoutCookie).toMatch(new RegExp(`^${TEST_CONFIG.sessionCookieName}=;`));
        expect(logoutCookie).toContain('Path=/');
        expect(logoutCookie).toMatch(/Expires=Thu, 01 Jan 1970/);

        expect((await agent.get('/auth/me')).status).toBe(401);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('rejects a wrong password with invalid_credentials, not user_not_found', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await agent.post('/auth/register').send({
          username: 'lee',
          email: 'lee@example.com',
          password: 'a-long-enough-password',
          displayName: 'Lee',
        });
        const res = await agent
          .post('/auth/login')
          .send({ usernameOrEmail: 'lee', password: 'wrong-password-here' });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('invalid_credentials');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('gives the same code for an unknown user as for a wrong password', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const res = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ usernameOrEmail: 'nobody', password: 'whatever-password' });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('invalid_credentials');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
