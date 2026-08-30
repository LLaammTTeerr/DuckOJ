import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { API_PREFIX } from '@duckoj/api-prefix';
import cookieParser from 'cookie-parser';
import type { DestinationStream } from 'pino';
import type { AppConfig } from './config/config.schema.js';
import { requestLogger } from './common/logger.js';
import { ProblemFilter } from './common/problem.filter.js';

/**
 * Everything that turns a bare `AppModule` into the application this project
 * actually serves: request logging, cookie parsing, problem+json errors, the
 * `API_PREFIX` (`@duckoj/api-prefix`) with its health-probe exclusions, and CORS.
 *
 * This lives beside `main.ts` rather than inside it so that `main.ts` stays a
 * pure entrypoint — importing it runs `bootstrap()` as a side effect, which a
 * test cannot do — while production and tests still execute *one* copy of this
 * wiring instead of two that resemble each other.
 *
 * The distinction is not academic. Before this existed nothing instantiated
 * `AppModule` at all, so `@Public()` could be deleted from `HealthController`
 * with every test still green while `/healthz` began answering 401 — which
 * fails the Compose healthcheck, so `api` never becomes healthy, so `caddy`
 * never starts. `test/app.smoke.spec.ts` closes that gap; any wiring added to
 * the application must be added *here*, or it reopens.
 *
 * Call before `app.init()` / `app.listen()`.
 */
export function configureApp(
  app: INestApplication,
  config: AppConfig,
  logDestination?: DestinationStream,
): void {
  app.use(requestLogger(config.logLevel, logDestination));
  app.use(cookieParser());
  app.useGlobalFilters(new ProblemFilter());
  // The probes stay off the versioned prefix: they are infrastructure contracts
  // (the Compose healthcheck, the Caddyfile) rather than API surface, so they
  // must not move when the API version does.
  app.setGlobalPrefix(API_PREFIX, { exclude: ['healthz', 'readyz'] });
  app.enableCors({ origin: config.publicOrigin, credentials: true });
  configureKeepAlive(app.getHttpServer() as Server);
}

/**
 * How long an idle connection is kept open, in milliseconds.
 *
 * This must exceed the idle timeout of **every** proxy in front of the API,
 * and Node's default of 5 s exceeds nothing. Caddy's `reverse_proxy` pools
 * upstream connections and holds them idle for 2 minutes by default, so with
 * the default the proxy is always holding a connection the server is entitled
 * to close underneath it: write a request into that gap and it dies on a
 * closing socket, which Caddy reports as a **502** for a request the API
 * would have answered. That is the shape B4 saw — `GET /submissions/NaN`
 * answering 422 and then 502 on the retry seconds later, once the pooled
 * connection had gone idle past the 5 s mark.
 *
 * 185 s is Caddy's 2-minute default plus margin, so the invariant holds even
 * against a proxy that ignores the `keepalive 60s` the Caddyfile now sets.
 * The race is closed from whichever end is misconfigured.
 */
const KEEP_ALIVE_TIMEOUT_MS = 185_000;

/**
 * Node requires `headersTimeout > keepAliveTimeout`. The header clock starts
 * on the first byte of a *new* request, but Node arms it on a connection that
 * is merely waiting between requests too — so a smaller value closes idle
 * keep-alive connections early and reopens the very race above by another
 * door. Node prints a warning about the inversion at runtime and nothing in
 * this deployment reads it.
 */
const HEADERS_TIMEOUT_MS = KEEP_ALIVE_TIMEOUT_MS + 5_000;

function configureKeepAlive(server: Server): void {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
}
