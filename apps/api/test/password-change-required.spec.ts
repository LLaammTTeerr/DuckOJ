import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';

/**
 * D102 — `must_change_password` is enforced by the API, not only by the web.
 *
 * D61 left the flag to `PasswordGate` because reaching the API around it
 * "would mean driving the API by hand". `oj login` and the MCP server (D89)
 * are now exactly that, documented and shipped, so the premise is gone: a
 * session opened on a printed classroom password could mint a durable access
 * token, and from then on the forced change simply never happened.
 *
 * Two halves, and both are needed. The mint is the door (`POST /auth/tokens`);
 * a token that already exists — minted before this rule, since nothing else
 * can produce one now — is the window.
 */
const PASSWORD = 'a-long-enough-password';

async function registerAndLogin(app: Awaited<ReturnType<typeof buildApp>>, username: string) {
  const agent = request.agent(app.getHttpServer());
  await agent.post('/api/v1/auth/register').send({
    username,
    email: `${username}@example.com`,
    password: PASSWORD,
    displayName: username,
  });
  await agent.post('/api/v1/auth/login').send({ usernameOrEmail: username, password: PASSWORD });
  return agent;
}

async function flag(db: Db, username: string): Promise<void> {
  await db
    .update(schema.users)
    .set({ mustChangePassword: true })
    .where(eq(schema.users.username, username));
}

describe('a flagged account cannot mint or use an access token (D102)', () => {
  it('refuses POST /auth/tokens with 409 password_change_required while the flag is set', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await registerAndLogin(app, 'imported');
        await flag(db, 'imported');

        const refused = await agent
          .post('/api/v1/auth/tokens')
          .send({ name: 'cli', scopes: ['submissions:write'] });
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('password_change_required');
        // The message has to name the fix, because the only clients that
        // reach this refusal are `oj` and the MCP server, which print it
        // verbatim to somebody who is not looking at a browser.
        expect(String(refused.body.detail)).toMatch(/password/i);

        // Nothing was minted — the refusal is not merely cosmetic.
        const listed = await agent.get('/api/v1/auth/tokens');
        expect(listed.status).toBe(200);
        expect(listed.body).toEqual([]);

        // Changing the password clears the flag and the door opens again.
        const changed = await agent
          .post('/api/v1/auth/password/change')
          .send({ newPassword: 'another-long-password' });
        expect(changed.status).toBe(204);

        const minted = await agent.post('/api/v1/auth/tokens').send({ name: 'cli', scopes: [] });
        expect(minted.status).toBe(201);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses a token minted before the flag was set, for reads and for writes', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await registerAndLogin(app, 'earlybird');
        const created = await agent
          .post('/api/v1/auth/tokens')
          .send({ name: 'cli', scopes: ['submissions:write', 'problems:read'] });
        expect(created.status).toBe(201);
        const { token } = created.body as { token: string };

        // Working credential before the flag: this is what makes the refusal
        // below attributable to the flag rather than to a bad token.
        const before = await request(app.getHttpServer())
          .get('/api/v1/auth/me')
          .set('Authorization', `Bearer ${token}`);
        expect(before.status).toBe(200);

        await flag(db, 'earlybird');

        const read = await request(app.getHttpServer())
          .get('/api/v1/auth/me')
          .set('Authorization', `Bearer ${token}`);
        expect(read.status).toBe(409);
        expect(read.body.code).toBe('password_change_required');

        const write = await request(app.getHttpServer())
          .post('/api/v1/submissions')
          .set('Authorization', `Bearer ${token}`)
          .send({ problemCode: 'anything', languageKey: 'cpp17', source: 'int main(){}' });
        expect(write.status).toBe(409);
        expect(write.body.code).toBe('password_change_required');

        // The session is deliberately NOT refused: it is the only way the
        // change can be made, and `PasswordGate` needs `/auth/me` to know it
        // has to swap the page.
        const me = await agent.get('/api/v1/auth/me');
        expect(me.status).toBe(200);
        expect(me.body.mustChangePassword).toBe(true);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('tells a bearer-flow client about the obligation at login', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await registerAndLogin(app, 'pupil');
        await flag(db, 'pupil');

        const login = await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ usernameOrEmail: 'pupil', password: PASSWORD });
        expect(login.status).toBe(200);
        expect(login.body.user.mustChangePassword).toBe(true);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
