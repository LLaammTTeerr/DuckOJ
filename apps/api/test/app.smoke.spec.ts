import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { APP_CONFIG, DB } from '../src/config/config.module.js';
import { TEST_CONFIG } from './app.harness.js';

/**
 * The composition root, exercised end to end.
 *
 * Every other spec in this suite assembles its own subset of modules, so
 * `AppModule` itself was never instantiated and `main.ts`'s wiring never ran.
 * Two things hid in that gap, both invisible to a green suite:
 *
 * - `@Public()` on `HealthController` could be deleted with all tests still
 *   passing while `/healthz` began answering 401 — which fails the Compose
 *   healthcheck, so `api` never reports healthy, so `caddy` never starts.
 * - The `/api/v1` prefix was asserted only by the SDK's client-side base URL.
 *   Nothing checked that the server actually answers there.
 *
 * So this boots the real module graph with only the database replaced, and
 * applies the same `configureApp` that `bootstrap()` calls — not a copy of it.
 *
 * `APP_CONFIG` is overridden alongside `DB` because `ConfigModule`'s factory
 * calls `loadConfig(process.env)`, which throws at module init without a full
 * environment. Overriding the provider replaces the factory, so it never runs.
 */
describe('AppModule composition root', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DB)
      .useValue({ execute: async () => [{ ok: 1 }] })
      .overrideProvider(APP_CONFIG)
      .useValue(TEST_CONFIG)
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app, TEST_CONFIG);
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it('serves /healthz to an anonymous caller, unprefixed', async () => {
    const res = await request(app.getHttpServer()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('serves /readyz to an anonymous caller, unprefixed', async () => {
    const res = await request(app.getHttpServer()).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.database).toBe('ok');
  });

  it('answers the API under /api/v1 and denies it by default', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('authentication_required');
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('does not answer the API off the prefix', async () => {
    const res = await request(app.getHttpServer()).get('/auth/me');
    expect(res.status).toBe(404);
  });

  // Task 13 review, Important finding: apps/judge-agent's materializer.ts
  // once built its archive-fetch URL without this prefix at all, and
  // nothing caught it — materializer.spec.ts mocks fetch (so a hardcoded
  // expected URL and a hardcoded implementation URL can drift together and
  // still agree with each other), and packages.spec.ts's own test harness
  // never calls setGlobalPrefix at all, so it exercises the unprefixed
  // shape the agent was wrongly using. This is the one place InternalPackagesController
  // is reachable behind the REAL setGlobalPrefix('api/v1', ...) that
  // production actually runs.
  //
  // 401, not 404, is the whole point: 401 means the route exists at this
  // prefix and JudgeGuard rejected the anonymous caller. 404 would mean the
  // route isn't mounted here at all — which is exactly the silent failure
  // mode a bare `${apiOrigin}/internal/packages/...` produced. A test
  // expecting 404 would pass whether the route existed or not; this one
  // fails if `app.setup.ts`'s prefix (or InternalPackagesController's own
  // path) ever diverges from what apps/judge-agent's materializer.ts
  // requests.
  it('requires judge credentials on the internal archive route, at the real /api/v1 prefix', async () => {
    const res = await request(app.getHttpServer()).get(
      `/api/v1/internal/packages/${'a'.repeat(64)}/archive`,
    );
    expect(res.status).toBe(401);
  });

  // Task 10 review: nothing previously asserted that AdminModule's route
  // answers behind the real setGlobalPrefix('api/v1', ...) rather than only
  // in test/app.harness.ts's own subset-of-modules build. 401, not 404, is
  // the point — same reasoning as the internal-archive-route test just
  // above: 401 means the route is mounted at this exact prefix and AuthGuard
  // rejected the anonymous caller before AdminUsersController's own
  // SessionOnlyGuard ever ran; 404 would mean it isn't reachable here at all.
  it('reaches PATCH /admin/users/:username at the real /api/v1 prefix', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/v1/admin/users/nobody')
      .send({ globalRole: 'setter' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('authentication_required');
  });

  // Task 7b. The Caddyfile falls everything outside `/api/*` through to the
  // web app's `index.html`, so a document served at bare `/openapi.json`
  // would answer 200 with the SPA's markup — not the doc — which is a worse
  // failure than a 404 (see `docs.controller.ts`). Asserting the real prefix
  // here, the same way the tests above do for the internal-archive and
  // admin routes, is what would catch that regression before Task 13's
  // through-Caddy check ever runs.
  it('serves the OpenAPI document at /api/v1/openapi.json, anonymously', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.paths).toHaveProperty('/auth/login');
  });

  it('serves the docs viewer at /api/v1/docs, anonymously, referencing the prefixed document and script', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/docs');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('data-url="/api/v1/openapi.json"');
    expect(res.text).toContain('src="/api/v1/docs/scalar-standalone.js"');
  });

  it('serves the vendored viewer script at /api/v1/docs/scalar-standalone.js, as JavaScript', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/docs/scalar-standalone.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.text.length).toBeGreaterThan(1_000_000);
  });

  it('does not answer the docs off the prefix', async () => {
    const res = await request(app.getHttpServer()).get('/openapi.json');
    expect(res.status).toBe(404);
  });

  /**
   * Live probe, B3: a 1 MB submission body answered
   * `{"status":500,"code":"internal_error"}`.
   *
   * `CreateSubmissionRequest` caps `source` at 64 KB, but the body never
   * reaches Zod: express's json parser rejects anything over its own 100 KB
   * limit first, and it throws an `http-errors` `PayloadTooLargeError` — which
   * is not a Nest `HttpException`, so `ProblemFilter` fell through to its 500
   * branch. That branch also logs at ERROR, so every oversized paste looked
   * like a server fault to whoever watches the logs. The filter's own tables
   * have carried a 413 `payload_too_large` entry the whole time; nothing could
   * reach it.
   */
  it('answers 413 payload_too_large for a body past the json limit, not 500', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/submissions')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ problemCode: 'x', languageKey: 'cpp17', source: 'a'.repeat(400_000) }));

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ status: 413, code: 'payload_too_large' });
  });

  /**
   * D61 — the roster import is the ONE route allowed past the 100 KB limit
   * the test above pins, and it is allowed past it because a two-thousand-row
   * class list does not fit in it.
   *
   * A 401 (or anything that is not a 413) is the assertion: the body reached
   * the guard, which is exactly as far as an anonymous caller gets. The point
   * is that the request was not refused by the PARSER — if the larger parser
   * were dropped, or mounted on the wrong path, this would be a 413 and the
   * feature would fail at precisely the size it exists for, with no other
   * test noticing.
   */
  it('lets a roster larger than the default body limit reach the guard', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      username: `hs${String(i).padStart(6, '0')}`,
      displayName: `Nguyễn Văn Học Sinh Số ${String(i)}`,
    }));
    const body = JSON.stringify({ rows });
    expect(body.length).toBeGreaterThan(100 * 1024);

    const res = await request(app.getHttpServer())
      .post('/api/v1/orgs/thpt-a/members/import')
      .set('content-type', 'application/json')
      .send(body);

    expect(res.status).not.toBe(413);
    expect(res.status).toBe(401);
  });

  /**
   * The other half: the larger parser is mounted on that ONE path, not on
   * `/orgs/**`. A neighbour route inheriting a 2 MB limit would quietly undo
   * the property the 413 test above exists to hold.
   */
  it('does not extend the larger limit to the neighbouring member routes', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/orgs/thpt-a/members')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ username: 'x'.repeat(400_000), role: 'member' }));

    expect(res.status).toBe(413);
  });

  /**
   * The other half of the same rule: an error that merely *has* a numeric
   * `status` must not be able to pick its own response code. Only the
   * `http-errors` client-error shape (4xx AND `expose: true`) is honoured;
   * a database driver error carrying a 500-ish status stays a 500 with
   * nothing of its own on the wire.
   */
  it('still answers 404 not_found — not 500 — for an unrouted path', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/no-such-route');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ status: 404 });
  });
});
