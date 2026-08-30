/**
 * D82 — the second CSRF layer.
 *
 * B10 cleared CSRF and recorded the clearance as single-layer: `SameSite=Lax`
 * is the only thing standing between a hostile page and a state change made
 * with the victim's session. This file pins the second layer — an
 * Origin/Referer check on every cookie-authenticated unsafe method.
 *
 * Every app here is built with `rawOrigin`, which turns OFF the harness'
 * browser-faithful `Origin` stamp (`app.harness.ts`): this is the one file
 * that must see requests exactly as they were written.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema } from '@duckoj/db';
import { TEST_CONFIG, buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';

const PASSWORD = 'a-long-enough-password';
const ORIGIN = TEST_CONFIG.publicOrigin;
/** The second entry of `wsAllowedOrigins` in production: the e2e's own host. */
const EXTRA_ORIGIN = 'http://localhost:8080';

/**
 * Registers and signs `username` in, returning the session cookie.
 *
 * Both requests set `Origin` explicitly — every app in this file runs with
 * `rawOrigin`, so nothing supplies one for them, and the fixture must not be
 * the thing under test. Registration itself carries no cookie and so is not
 * checked at all (there is a test below for exactly that).
 */
async function register(app: INestApplication, username: string): Promise<string> {
  const created = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .set('Origin', ORIGIN)
    .send({ username, email: `${username}@example.com`, password: PASSWORD, displayName: username });
  expect(created.status).toBe(201);
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('Origin', ORIGIN)
    .send({ usernameOrEmail: username, password: PASSWORD });
  expect(res.status).toBe(200);
  const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;
  const session = cookies?.find((c) => c.startsWith(`${TEST_CONFIG.sessionCookieName}=`));
  expect(session).toBeDefined();
  return session!.split(';')[0]!;
}

async function build(app: Parameters<typeof buildApp>[0]): Promise<INestApplication> {
  return buildApp(app, {
    rawOrigin: true,
    configOverrides: { wsAllowedOrigins: [ORIGIN, EXTRA_ORIGIN] },
  });
}

describe('CsrfOriginGuard: a cookie-authenticated state change must say where it came from', () => {
  it('refuses a POST that carries a session cookie and NEITHER header', async () => {
    await withTestDb(async (db) => {
      const app = await build(db);
      try {
        const cookie = await register(app, 'csrf-none');

        // This is the shape the guard exists for once it is stated plainly:
        // ambient credentials, an unsafe method, and nothing at all saying
        // which page produced it.
        const res = await request(app.getHttpServer()).post('/api/v1/auth/logout').set('Cookie', cookie);

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('csrf_origin');
        // The session must survive a refusal: a request the guard would not
        // run has not logged anybody out.
        const sessions = await db.select().from(schema.sessions);
        expect(sessions).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses a hostile Origin, and a hostile Referer', async () => {
    await withTestDb(async (db) => {
      const app = await build(db);
      try {
        const cookie = await register(app, 'csrf-evil');

        const byOrigin = await request(app.getHttpServer())
          .patch('/api/v1/users/me')
          .set('Cookie', cookie)
          .set('Origin', 'https://evil.example')
          .send({ displayName: 'defaced' });
        expect(byOrigin.status).toBe(403);
        expect(byOrigin.body.code).toBe('csrf_origin');

        // `Referer` carries a PATH, and a path is not a trust boundary — a
        // check that string-matched the whole header, or matched a prefix,
        // would admit `https://evil.example/?http://localhost:5173`.
        const byReferer = await request(app.getHttpServer())
          .patch('/api/v1/users/me')
          .set('Cookie', cookie)
          .set('Referer', `https://evil.example/${ORIGIN}`)
          .send({ displayName: 'defaced' });
        expect(byReferer.status).toBe(403);

        // Nothing changed on either path.
        const [user] = await db
          .select({ displayName: schema.users.displayName })
          .from(schema.users)
          .where(eq(schema.users.username, 'csrf-evil'));
        expect(user?.displayName).toBe('csrf-evil');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses an opaque `Origin: null` — a sandboxed iframe is not our origin', async () => {
    await withTestDb(async (db) => {
      const app = await build(db);
      try {
        const cookie = await register(app, 'csrf-opaque');
        const res = await request(app.getHttpServer())
          .patch('/api/v1/users/me')
          .set('Cookie', cookie)
          .set('Origin', 'null')
          .send({ displayName: 'x' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('csrf_origin');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('admits PUBLIC_ORIGIN, an extra allowed origin, and a Referer from either', async () => {
    await withTestDb(async (db) => {
      const app = await build(db);
      try {
        const cookie = await register(app, 'csrf-ok');

        const byOrigin = await request(app.getHttpServer())
          .patch('/api/v1/users/me')
          .set('Cookie', cookie)
          .set('Origin', ORIGIN)
          .send({ displayName: 'Đổi tên' });
        expect(byOrigin.status).toBe(200);

        // The e2e drives the live stack at `http://localhost:8080`, which is
        // `WS_EXTRA_ORIGINS` in `.env` — the allow-list is D70's, unchanged,
        // and it has to admit an HTTP write as well as a socket.
        const byExtra = await request(app.getHttpServer())
          .patch('/api/v1/users/me')
          .set('Cookie', cookie)
          .set('Origin', EXTRA_ORIGIN)
          .send({ displayName: 'Từ e2e' });
        expect(byExtra.status).toBe(200);

        // Referer only: reduced to its origin before it is compared.
        const byReferer = await request(app.getHttpServer())
          .patch('/api/v1/users/me')
          .set('Cookie', cookie)
          .set('Referer', `${ORIGIN}/problems/aplusb?x=1`)
          .send({ displayName: 'Từ referer' });
        expect(byReferer.status).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('leaves a BEARER request alone, even with a cookie and a hostile Origin', async () => {
    await withTestDb(async (db) => {
      const app = await build(db);
      try {
        const cookie = await register(app, 'csrf-bearer');
        const minted = await request(app.getHttpServer())
          .post('/api/v1/auth/tokens')
          .set('Cookie', cookie)
          .set('Origin', ORIGIN)
          .send({ name: 'probe', scopes: ['problems:read'] });
        expect(minted.status).toBe(201);
        const token = (minted.body as { token: string }).token;

        // `AuthGuard.attachActor` authenticates by the token and never reads
        // the cookie, and no page can set an `Authorization` header without a
        // preflight this API answers only for its own origin. Every machine
        // client — `oj`, the judge agent, CI — has no origin to send, and
        // must not be refused for it.
        const res = await request(app.getHttpServer())
          .post('/api/v1/submissions')
          .set('Cookie', cookie)
          .set('Authorization', `Bearer ${token}`)
          .set('Origin', 'https://evil.example')
          .send({ problemCode: 'nope', languageKey: 'cpp17', source: 'x' });
        // Past the CSRF guard, and refused further in by the scope this token
        // does not hold. Both refusals are 403, so the STATUS proves nothing
        // here and the code is the whole assertion.
        expect(res.body.code).toBe('scope_required');
        expect(res.body.code).not.toBe('csrf_origin');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('never touches a GET, however hostile the Origin', async () => {
    await withTestDb(async (db) => {
      const app = await build(db);
      try {
        const cookie = await register(app, 'csrf-get');
        const res = await request(app.getHttpServer())
          .get('/api/v1/auth/me')
          .set('Cookie', cookie)
          .set('Origin', 'https://evil.example');
        // A read changes nothing, and CORS already stops a hostile page from
        // READING the answer. Refusing here would break nothing an attacker
        // has and every reverse proxy that rewrites `Origin` on a GET.
        expect(res.status).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('leaves the cookie-less credential routes exactly as they were', async () => {
    await withTestDb(async (db) => {
      const app = await build(db);
      try {
        // Register, then log in, from a client that has never held a cookie
        // and sends no `Origin` at all — a `curl`, a script, the first
        // request any browser ever makes to this API. The guard's premise is
        // ambient credentials; there are none here, so there is nothing to
        // check and nothing to refuse.
        const registered = await request(app.getHttpServer())
          .post('/api/v1/auth/register')
          .send({
            username: 'csrf-fresh',
            email: 'csrf-fresh@example.com',
            password: PASSWORD,
            displayName: 'Fresh',
          });
        expect(registered.status).toBe(201);

        const loggedIn = await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ usernameOrEmail: 'csrf-fresh', password: PASSWORD });
        expect(loggedIn.status).toBe(200);

        // Logging OUT carries the cookie, so it is checked — and works with
        // an origin, as a browser sends one.
        const cookies = loggedIn.headers['set-cookie'] as unknown as string[];
        const session = cookies.find((c) => c.startsWith(`${TEST_CONFIG.sessionCookieName}=`))!.split(';')[0]!;
        const out = await request(app.getHttpServer())
          .post('/api/v1/auth/logout')
          .set('Cookie', session)
          .set('Origin', ORIGIN);
        expect(out.status).toBe(204);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('answers 403 csrf_origin BEFORE 401 — the guard runs ahead of authentication', async () => {
    await withTestDb(async (db) => {
      const app = await build(db);
      try {
        // A cookie that resolves to nothing, on a route that needs an actor.
        // Order matters and is pinned: reaching `AuthGuard` first would turn a
        // cross-site request into a 401 about the cookie, which says the
        // request was fine and only the credential was stale — and would let
        // a VALID cookie carry the same request all the way to a handler.
        const res = await request(app.getHttpServer())
          .patch('/api/v1/users/me')
          .set('Cookie', `${TEST_CONFIG.sessionCookieName}=not-a-real-session`)
          .send({ displayName: 'x' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('csrf_origin');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
