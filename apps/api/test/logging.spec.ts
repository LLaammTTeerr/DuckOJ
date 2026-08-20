import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { DestinationStream } from 'pino';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';

/** Collects everything pino writes, so the test can assert on real log output. */
function captureLog(): { destination: DestinationStream; lines: () => string } {
  const chunks: string[] = [];
  return {
    destination: { write: (chunk: string) => void chunks.push(chunk) },
    lines: () => chunks.join(''),
  };
}

/**
 * `pino-http` serializes `req` and `res` with `pino-std-serializers`, which
 * copies the header bags wholesale, and attaches the serialized `req` to the
 * *response* line — so without redaction the raw session cookie, the raw bearer
 * token and the `Set-Cookie` that issues a session all reach stdout on every
 * single request, at `info`, which is production's level.
 *
 * The failure mode this guards against is specifically a *silent* one: a redact
 * path with the wrong syntax (`res.headers.set-cookie` for the hyphenated key,
 * say) matches nothing and produces output indistinguishable from a working
 * config. Hence the positive assertions below — the log must be non-empty and
 * must actually contain the censor string — before the absence assertions,
 * which would otherwise pass vacuously against an empty capture.
 */
describe('request logging redacts credentials', () => {
  it('never writes a session cookie, a Set-Cookie, or a bearer token to the log', async () => {
    await withTestDb(async (db) => {
      const log = captureLog();
      const app = await buildApp(db, {
        // Not TEST_CONFIG's 'silent': at that level nothing is emitted and every
        // "the token is absent" assertion below would hold for the wrong reason.
        logging: { level: 'info', destination: log.destination },
      });
      try {
        const agent = request.agent(app.getHttpServer());
        await agent.post('/auth/register').send({
          username: 'ilsa',
          email: 'ilsa@example.com',
          password: 'a-long-enough-password',
          displayName: 'Ilsa',
        });

        // (a) Set-Cookie on the response: login issues the raw session token.
        const login = await agent
          .post('/auth/login')
          .send({ usernameOrEmail: 'ilsa', password: 'a-long-enough-password' });
        expect(login.status).toBe(200);

        const setCookie = login.headers['set-cookie'] as unknown as string[];
        const sessionToken = /duckoj_session=([^;]+)/.exec(setCookie.join(';'))![1]!;
        expect(sessionToken.length).toBeGreaterThan(16);

        // (b) Cookie on the request: the agent replays the session token.
        const me = await agent.get('/auth/me');
        expect(me.status).toBe(200);

        // (c) Authorization on the request: a bearer token.
        const created = await agent
          .post('/auth/tokens')
          .send({ name: 'cli', scopes: ['submissions:write'] });
        expect(created.status).toBe(201);
        const accessToken = (created.body as { token: string }).token;

        // `/auth/me` carries no `@RequireScope`, so `ScopeGuard`'s
        // deny-by-default refuses this token with 403 — but `AuthGuard` has
        // already resolved and logged the request by then, which is all
        // this test cares about.
        const viaToken = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${accessToken}`);
        expect(viaToken.status).toBe(403);

        const output = log.lines();

        // Positive first: prove the logger really ran and really censored, so
        // the absence checks below cannot pass against an empty capture.
        expect(output).toContain('"req"');
        expect(output).toContain('"res"');
        expect(output).toContain('[redacted]');
        expect(output).toContain('"url":"/auth/me"');

        // Then the actual guarantee: no plaintext credential anywhere in it.
        expect(output).not.toContain(sessionToken);
        expect(output).not.toContain(accessToken);
        expect(output).not.toContain('duckoj_session=');
        expect(output.toLowerCase()).not.toContain('bearer ');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
