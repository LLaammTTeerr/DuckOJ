/**
 * The test harness serves the application the container serves (D91).
 *
 * `buildApp` used to hand every one of the ~900 API specs an app assembled by
 * hand: `cookieParser` and `ProblemFilter`, and nothing else. So the whole
 * suite ran with **no `/api/v1` prefix, no CORS, no body limits and no
 * keep-alive tuning** — four pieces of production wiring that only
 * `app.smoke.spec.ts` and `app.boot.spec.ts` ever touched, and only on
 * `AppModule`. A route that worked in every spec and 404'd behind Caddy was
 * a shape the suite could not see, which is the same class of gap B-15's
 * boot outage came out of.
 *
 * `buildApp` now calls `configureApp` — the very function `main.ts` calls.
 * This file is the guard on that: each test below fails if `configureApp` is
 * dropped from the harness, or if a future edit re-hand-rolls a subset of it.
 * Every assertion is made against an app from `buildApp`, deliberately NOT
 * against one this file wires itself, because the thing under test is what
 * the other 900 specs are handed.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { API_PREFIX } from '@duckoj/api-prefix';
import { loadConfig } from '../src/config/config.schema.js';
import { TEST_CONFIG, TEST_ENV, buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';

describe('the API harness serves what the container serves', () => {
  it(
    'prefixes, exposes CORS headers, bounds the body and tunes keep-alive — all through configureApp',
    async () => {
      await withTestDb(async (db) => {
        const app = await buildApp(db);
        try {
          // 1. The prefix. `/auth/me` off the prefix is not the API at all;
          // under it, it is the deny-by-default 401. Before this change the
          // first of these was the 401 and the second was the 404 — exactly
          // inverted from what Caddy sends the browser.
          const off = await request(app.getHttpServer()).get('/auth/me');
          expect(off.status).toBe(404);
          const on = await request(app.getHttpServer()).get(`/${API_PREFIX}/auth/me`);
          expect(on.status).toBe(401);
          expect(on.body.code).toBe('authentication_required');

          // 2. CORS, with the exposed-header list a cross-origin browser
          // needs to read `x-request-id` at all (see `EXPOSED_HEADERS`).
          const cors = await request(app.getHttpServer())
            .get(`/${API_PREFIX}/auth/me`)
            .set('Origin', TEST_CONFIG.publicOrigin);
          expect(cors.headers['access-control-allow-origin']).toBe(TEST_CONFIG.publicOrigin);
          expect(cors.headers['access-control-expose-headers']?.toLowerCase()).toContain('x-request-id');

          // 3. The 100 KB JSON body limit, answered as 413 `payload_too_large`
          // by `ProblemFilter` rather than as a 500. Nest installs no parser
          // limit of its own in the harness, so before this an oversized
          // paste reached Zod in every spec and the parser in production.
          const tooBig = await request(app.getHttpServer())
            .post(`/${API_PREFIX}/submissions`)
            .set('content-type', 'application/json')
            .send(JSON.stringify({ problemCode: 'x', languageKey: 'cpp17', source: 'a'.repeat(400_000) }));
          expect(tooBig.status).toBe(413);
          expect(tooBig.body).toMatchObject({ status: 413, code: 'payload_too_large' });

          // 4. `x-powered-by` off, the one-line version disclosure
          // `configureApp` disables.
          expect(on.headers['x-powered-by']).toBeUndefined();

          // 5. The keep-alive pair that closed B4's 502 race. Node's defaults
          // are 5 s / 60 s, so an untouched server fails this.
          const server = app.getHttpServer() as Server;
          expect(server.keepAliveTimeout).toBe(185_000);
          expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
        } finally {
          await app.close();
        }
      });
    },
    120_000,
  );

  /**
   * The other half of D91: `TEST_CONFIG` is `loadConfig`'s output, not a
   * hand-written `AppConfig` literal that merely resembled one.
   *
   * The literal was in fact NOT a config `loadConfig` would produce — it set
   * `port: 0` (`PORT` is `min(1)`) and `logLevel: 'silent'` (absent from the
   * `LOG_LEVEL` enum until this change). Neither could be noticed, because
   * nothing ever ran the two against each other.
   */
  it('builds TEST_CONFIG through the same loadConfig main.ts calls', () => {
    expect(TEST_CONFIG).toEqual(loadConfig(TEST_ENV));
    // Not a tautology to `toEqual` above: this is the assertion that the env
    // is a *complete* one — a required variable added to `EnvSchema` without
    // a default makes `loadConfig` throw here, where the old literal would
    // simply have gone on missing the field.
    expect(() => loadConfig(TEST_ENV)).not.toThrow();
    expect(TEST_CONFIG.logLevel).toBe('silent');
    expect(TEST_CONFIG.publicOrigin).toBe('http://localhost:5173');
    expect(TEST_CONFIG.totpEncKey).toEqual(Buffer.alloc(32, 1));
  });
});
