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
});
