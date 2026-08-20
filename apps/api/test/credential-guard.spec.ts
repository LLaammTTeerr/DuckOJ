import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';

/**
 * A personal access token authenticates its owner but must not be able to
 * rewrite the credentials that govern that owner.
 *
 * Left open, a single leaked token was a permanent account takeover rather than
 * a revocable incident: `POST /auth/totp/begin` upserts a fresh secret with
 * `confirmedAt: null`, silently disabling the victim's second factor while
 * looking like an enrolment, and `POST /auth/tokens` then mints replacements so
 * that revoking the leaked token no longer ends the compromise.
 *
 * Both halves are asserted deliberately. A guard that simply rejected everyone
 * would satisfy the rejection half alone, so each route is also exercised with
 * a session cookie and required to succeed.
 */
describe('credential management requires an interactive session', () => {
  it('rejects a bearer token but serves a session cookie on the token and TOTP routes', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await agent.post('/auth/register').send({
          username: 'xena',
          email: 'xena@example.com',
          password: 'a-long-enough-password',
          displayName: 'Xena',
        });
        await agent
          .post('/auth/login')
          .send({ usernameOrEmail: 'xena', password: 'a-long-enough-password' });

        const created = await agent
          .post('/auth/tokens')
          .send({ name: 'cli', scopes: ['submissions:write'] });
        expect(created.status).toBe(201);
        const { token } = created.body as { token: string };

        // The token authenticates: `/auth/me` is `@NoScopeRequired()`, so it
        // is reachable by any token and answers with the caller's own
        // identity — proof this is a working credential, distinct from the
        // 401 `invalid_token` an unrecognized token would get.
        const me = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${token}`);
        expect(me.status).toBe(200);
        expect(me.body.username).toBe('xena');

        const bearer = (path: string) =>
          request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`);

        const mintByToken = await bearer('/auth/tokens').send({ name: 'replacement', scopes: [] });
        expect(mintByToken.status).toBe(403);
        expect(mintByToken.body.code).toBe('session_required');

        const totpByToken = await bearer('/auth/totp/begin');
        expect(totpByToken.status).toBe(403);
        expect(totpByToken.body.code).toBe('session_required');

        // The whole controller is covered, not just the two routes above.
        const listByToken = await request(app.getHttpServer())
          .get('/auth/tokens')
          .set('Authorization', `Bearer ${token}`);
        expect(listByToken.status).toBe(403);

        // ...and the session half still works, so the guard is not simply
        // rejecting everything.
        const mintBySession = await agent.post('/auth/tokens').send({ name: 'second', scopes: [] });
        expect(mintBySession.status).toBe(201);

        const totpBySession = await agent.post('/auth/totp/begin');
        expect(totpBySession.status).toBe(200);
        expect(typeof totpBySession.body.secret).toBe('string');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
