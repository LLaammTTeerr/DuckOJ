// B5 live probe: `GET /api/v1/submissions/NaN` answered 422 and then **502**
// when the browser retried it. A 502 is Caddy's, not the API's — the API
// never produces one — so something between Caddy and the API dropped a
// connection mid-request.
//
// The mechanism is the classic reverse-proxy keep-alive race, and nothing in
// this repo was configured against it:
//
//   - Node's `http.Server.keepAliveTimeout` defaults to **5 s**. After 5 s
//     idle the server closes a pooled connection.
//   - Caddy's `reverse_proxy` keeps its own pool of upstream connections and,
//     by default, holds them idle for **2 minutes**.
//
// So the proxy is always the one holding a connection the server is entitled
// to close underneath it. If Caddy writes a request onto a connection in the
// same instant Node sends its FIN, the request dies on an already-closing
// socket and Caddy answers 502 — for a request the API would have answered
// perfectly well. It is load-independent, unreproducible on demand, and shows
// up exactly where B4 saw it: on a *retry*, seconds after the first attempt,
// when the pooled connection has gone idle past the server's timeout.
//
// The fix is the standard one and it has two halves, both of which must hold
// or the race is still open:
//
//   1. The **server** must stay open longer than the proxy is willing to hold
//      a connection, so the proxy is never the last to know.
//   2. The **proxy** must be told an explicit, shorter idle timeout rather
//      than relying on whatever its default happens to be in the next version.
//
// This spec pins both, because pinning only one leaves the invariant
// (`proxy idle < server idle`) resting on a default nobody in this repo
// controls.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { APP_CONFIG, DB } from '../src/config/config.module.js';
import { TEST_CONFIG } from './app.harness.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Caddy's own default upstream idle, which the Caddyfile must undercut. */
const CADDY_DEFAULT_IDLE_SECONDS = 120;

describe('reverse-proxy keep-alive', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('keeps an idle connection open longer than any proxy would hold it', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DB)
      .useValue({ execute: async () => [{ ok: 1 }] })
      .overrideProvider(APP_CONFIG)
      .useValue(TEST_CONFIG)
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app, TEST_CONFIG);
    await app.init();

    const server = app.getHttpServer() as Server;
    // Node's default is 5_000: far below Caddy's 120 s pool idle, which is
    // precisely the race. Anything at or below the proxy's idle reopens it.
    expect(server.keepAliveTimeout).toBeGreaterThan(CADDY_DEFAULT_IDLE_SECONDS * 1000);
    // Node requires `headersTimeout > keepAliveTimeout`; otherwise the header
    // clock fires on a connection that is merely idle between requests and
    // the server closes it early, reintroducing the same race by another
    // door. Node warns about this at runtime and nothing reads the warning.
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });

  it('tells Caddy an explicit upstream idle shorter than the server keeps', async () => {
    const caddyfile = readFileSync(join(repoRoot, 'Caddyfile'), 'utf8');

    // `keepalive <duration>` inside a `transport http { … }` block on the API
    // reverse_proxy. Without it the pool idle is whatever Caddy's default is
    // in whatever version the image pulls — an invariant this repo cannot see
    // and would not notice changing.
    const match = /keepalive\s+(\d+)s/.exec(caddyfile);
    expect(match, 'Caddyfile declares no upstream `keepalive` idle timeout').not.toBeNull();

    const proxyIdleSeconds = Number(match?.[1]);
    expect(proxyIdleSeconds).toBeLessThan(CADDY_DEFAULT_IDLE_SECONDS);
    // Every `reverse_proxy api:3000` must carry it — the /api, /ws and probe
    // handles are three separate proxies to the same upstream, and a pool is
    // per-proxy.
    // `\{` matters: the file also *mentions* `reverse_proxy api:3000` in a
    // comment, and counting that as a proxy makes this assertion unfixable.
    const apiProxies = caddyfile.match(/reverse_proxy\s+api:3000\s*\{/g) ?? [];
    const transports = caddyfile.match(/transport\s+http\s*\{/g) ?? [];
    expect(transports.length).toBe(apiProxies.length);
  });
});
