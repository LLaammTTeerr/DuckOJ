/**
 * D196 — U+0000 is not a character any DuckOJ string accepts.
 *
 * `route-fuzz.spec.ts` carries the breadth (every documented route, a NUL in
 * every path parameter and in `q`, `user`, `problem`, `contest`, `org` and
 * `cursor`). This file carries the two properties breadth cannot express:
 *
 *  1. **The refusal is 422 `validation_failed`, not 500.** Postgres `text`
 *     cannot hold a NUL, so before D196 the byte travelled all the way to a
 *     bind and came back as `22021 invalid byte sequence` — a
 *     `DrizzleQueryError` `ProblemFilter` cannot map, logged at ERROR with a
 *     stack, on an input a stranger chooses. Measured live at `eef05c1`:
 *     `GET /users/%00`, `/problems?q=%00` and `POST /auth/login` all answered
 *     500 with no credential at all.
 *
 *  2. **Every ruled refusal that comes from a GUARD still comes first.** This
 *     is why the check is an interceptor and not middleware. D188 ruled that
 *     an anonymous caller on `GET /users` meets `401 authentication_required`
 *     — not "your request is malformed", which would imply a well-formed one
 *     would have been served — and D191 ruled the same for the roster's
 *     cursor. `AuthGuard` runs before interceptors, so a guarded route keeps
 *     its 401 even when the request also carries a NUL.
 *
 * The `%2500` case is the third property and the one that keeps the rule from
 * being a blunt string match: `%2500` is the percent-decoded TEXT "%00", which
 * is an ordinary five-character search term and must be served.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin } from './submissions.fixtures.js';

describe('a NUL byte is refused, above every handler (D196)', () => {
  it('answers 422 rather than 500, and never displaces a guard refusal', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const server = app.getHttpServer();

        /* --- 1. The guards still answer first, exactly as D188/D191 ruled --- */

        // `GET /users` lost `@Public()` in D188, so `AuthGuard` refuses before
        // any interceptor runs. A NUL must not turn this into a 422.
        await request(server).get('/api/v1/users').query({ q: '\u0000' }).expect(401);
        await request(server).get('/api/v1/users').query({ cursor: '\u0000' }).expect(401);

        /* --- 2. Past the guards, the byte is refused rather than bound ---- */

        const agent = request.agent(server);
        await registerAndLogin(agent, 'nulprobe');

        for (const query of [{ q: '\u0000' }, { cursor: '\u0000' }]) {
          const res = await agent.get('/api/v1/users').query(query);
          expect(res.status, JSON.stringify(query)).toBe(422);
          expect((res.body as { code: string }).code).toBe('validation_failed');
        }

        // A path parameter, which no pipe validates on 87 of this API's
        // bindings — the reason the rule is stated once above the handlers.
        for (const path of ['/api/v1/users/%00', '/api/v1/problems/%00', '/api/v1/contests/%00']) {
          const res = await request(server).get(path);
          expect(res.status, path).toBe(422);
        }

        // A body, on a route that takes no credential at all. This one
        // answered 500 on the live edge.
        const login = await request(server)
          .post('/api/v1/auth/login')
          .send({ usernameOrEmail: 'a\u0000b', password: 'a-long-enough-password' });
        expect(login.status).toBe(422);

        // Inside an ARRAY, because a body is a tree and the check walks one
        // — a NUL one level down must be found as surely as a top-level field.
        // `POST /auth/tokens` is a cookie write, so D82's `Origin` is what
        // gets it past `CsrfOriginGuard` and to the interceptor at all.
        const nested = await agent
          .post('/api/v1/auth/tokens')
          .set('Origin', 'http://localhost:5173')
          .send({ name: 'ok', scopes: ['a\u0000b'] });
        expect(nested.status).toBe(422);

        // In a KEY rather than a value. Several columns here are `jsonb`, and
        // Postgres refuses a NUL inside one with `22P05` exactly as `text`
        // refuses it with `22021`.
        const keyed = await agent
          .post('/api/v1/auth/tokens')
          .set('Origin', 'http://localhost:5173')
          .send({ name: 'ok', scopes: [], ['k\u0000ey']: 'x' });
        expect(keyed.status).toBe(422);

        /* --- 3. `%2500` is the TEXT "%00" and is an ordinary search term -- */

        const literal = await agent.get('/api/v1/users').query({ q: '%00' });
        expect(literal.status, 'the five characters %00 are a legal query').toBe(200);
      } finally {
        await app.close();
      }
    });
  });
});
