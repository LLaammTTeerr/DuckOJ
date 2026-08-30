// B5, item 5: the headers this API answers *with*, on the paths where they
// matter most.
//
// Three response headers are load-bearing here, and every one of them is
// written down somewhere as a thing a client or an operator reads:
//
//  - **`Retry-After`** — declared in the OpenAPI document itself for
//    `POST /auth/register` and `POST /auth/login` ("carries the whole seconds
//    until another attempt will be accepted"), and set by `ProblemFilter`
//    from `AppError.headers` precisely so a 429 does not depend on a handler
//    remembering to reach for the response object.
//  - **`X-Scoreboard-Cache`** — D25 chose a header over a body field so the
//    goldens' byte-for-byte snake_case shape stays untouched, on the
//    reasoning that "operators and load tests read a header perfectly well".
//  - **`x-request-id`** — set by `requestLogger` on every response and logged
//    with every line; the one value worth quoting in a bug report.
//
// A browser cannot read any of them cross-origin. `fetch` exposes only the
// CORS-safelisted response headers (`Cache-Control`, `Content-Language`,
// `Content-Length`, `Content-Type`, `Expires`, `Last-Modified`, `Pragma`);
// everything else needs `Access-Control-Expose-Headers`, and `configureApp`
// set none. Verified against the live stack: a 401 carried
// `Access-Control-Allow-Origin` and `Vary: Origin` but no
// `Access-Control-Expose-Headers` at all.
//
// The cost is exactly on the client CORS exists for. Same-origin traffic
// through Caddy is unaffected — which is why nothing noticed — but the whole
// reason `enableCors({ origin: publicOrigin, credentials: true })` is there
// is the browser on another origin: the vite dev server, and any front end a
// province runs off its own domain. For that client `res.headers.get(
// 'Retry-After')` is `null`, so a rate-limited sign-in can say "try again
// later" and nothing more, while the contract promises a number.
//
// Asserted on a real 401 rather than by reading the config object: the
// question is what goes on the wire, and `cors` emits this header only when
// it is configured to.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { APP_CONFIG, DB } from '../src/config/config.module.js';
import { TEST_CONFIG } from './app.harness.js';

const ORIGIN = TEST_CONFIG.publicOrigin;

describe('CORS-exposed response headers', () => {
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

  it('lets a cross-origin client read Retry-After, X-Scoreboard-Cache and x-request-id', async () => {
    // A 401 rather than a 200: the error paths are where these headers carry
    // the most and where a client is least able to ask again.
    const res = await request(app.getHttpServer()).get('/api/v1/auth/me').set('Origin', ORIGIN);

    expect(res.status).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);

    const exposed = String(res.headers['access-control-expose-headers'] ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    expect(exposed).toContain('retry-after');
    expect(exposed).toContain('x-scoreboard-cache');
    expect(exposed).toContain('x-request-id');
  });

  /**
   * Derived from source, not from a list somebody remembered to extend.
   *
   * B5 named three headers and exposed three. F6 then shipped
   * `X-Stats-Cache` (D49) and `X-Booklet-Cache` (D48) — both chosen as
   * headers for D25's exact reason, both invisible to the browser CORS
   * exists for — and nothing failed, because the assertion above only knew
   * about the headers that were there when it was written. So this one asks
   * the source what the API actually answers with.
   */
  it('exposes every X- header any controller sets', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/auth/me').set('Origin', ORIGIN);
    const exposed = String(res.headers['access-control-expose-headers'] ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);

    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const set = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        for (const match of readFileSync(full, 'utf8').matchAll(/setHeader\(\s*'(x-[^']+)'/gi)) {
          set.add(match[1]!.toLowerCase());
        }
      }
    };
    walk(srcRoot);

    expect(set.size).toBeGreaterThan(0);
    for (const name of set) {
      expect(exposed, `${name} is answered but not exposed cross-origin`).toContain(name);
    }
  });

  it('sets x-request-id on every response, so there is something to expose', () => {
    // Guards the premise of the test above rather than repeating it: if the
    // logger stopped stamping this, exposing the name would be exposing
    // nothing and the assertion above would still pass.
    return request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .expect(401)
      .expect((res) => {
        expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      });
  });
});
