import type { Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
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
  configureBodyParsers(app);
  app.use(cookieParser());
  app.useGlobalFilters(new ProblemFilter());
  // The probes stay off the versioned prefix: they are infrastructure contracts
  // (the Compose healthcheck, the Caddyfile) rather than API surface, so they
  // must not move when the API version does.
  app.setGlobalPrefix(API_PREFIX, { exclude: ['healthz', 'readyz'] });
  app.enableCors({ origin: config.publicOrigin, credentials: true, exposedHeaders: EXPOSED_HEADERS });
  configureKeepAlive(app.getHttpServer() as Server);
}

/**
 * The JSON body limit, per route rather than globally (D61).
 *
 * Express' default of 100 KB is right for every endpoint this API had until
 * the roster import: `CreateSubmissionRequest` caps `source` at 64 KB, every
 * other schema caps its fields far below that, and refusing an oversized
 * paste at the PARSER — before Zod, before a handler, before a database
 * connection — is a property worth keeping. `app.smoke.spec.ts` pins it: a
 * 400 KB submission answers `413 payload_too_large`.
 *
 * A two-thousand-row roster does not fit in it. Worst case each row carries a
 * 32-character username, a 100-character display name (Vietnamese, so up to
 * three bytes a character) and a 254-character address — about 600 bytes,
 * 1.2 MB for a full file. Raising the limit globally to cover that would undo
 * the paragraph above for every other route at once, so instead the larger
 * parser is mounted FIRST and matches only the import path; the ordinary
 * 100 KB parser runs behind it and sees every other request untouched
 * (`body-parser` sets `req._body` once it has parsed, and the next parser in
 * the chain steps aside).
 *
 * The default pair is registered here explicitly rather than left to Nest:
 * `ExpressAdapter.registerParserMiddleware` skips any parser whose middleware
 * NAME is already on the router stack, and `express.json()` is named
 * `jsonParser` whichever limit it was built with — so a lone `useBodyParser`
 * call would silently take JSON parsing away from the rest of the API. Doing
 * it here means the chain is correct whether or not Nest adds its own copy
 * behind us (it would be a no-op either way).
 */
const IMPORT_BODY_LIMIT = '2mb';
const DEFAULT_BODY_LIMIT = '100kb';

/**
 * True only for `POST /<API_PREFIX>/orgs/<slug>/members/import`.
 *
 * Built from `API_PREFIX` rather than a literal, for the reason that constant
 * exists at all: the last time this path was written out by hand in three
 * places, one of them omitted the prefix and nothing caught it until a real
 * bring-up.
 */
const ROSTER_IMPORT_PATH = new RegExp(`^/${API_PREFIX}/orgs/[^/]+/members/import/?$`);

function isRosterImport(req: IncomingMessage): boolean {
  if (req.method !== 'POST') return false;
  return ROSTER_IMPORT_PATH.test((req.url ?? '').split('?')[0] ?? '');
}

function configureBodyParsers(app: INestApplication): void {
  const express = app as unknown as NestExpressApplication;
  express.useBodyParser('json', {
    limit: IMPORT_BODY_LIMIT,
    // `type` decides whether THIS parser touches the request at all. It must
    // still require JSON: a raw package upload that happened to be posted to
    // this path must not be buffered as a body.
    type: (req: IncomingMessage) =>
      isRosterImport(req) && (req.headers['content-type'] ?? '').includes('application/json'),
  });
  express.useBodyParser('json', { limit: DEFAULT_BODY_LIMIT });
  express.useBodyParser('urlencoded', { limit: DEFAULT_BODY_LIMIT, extended: true });
}

/**
 * Response headers a cross-origin browser client is allowed to read.
 *
 * `fetch` exposes only the CORS-safelisted response headers — `Cache-Control`,
 * `Content-Language`, `Content-Length`, `Content-Type`, `Expires`,
 * `Last-Modified`, `Pragma` — and nothing else, ever, unless it is named
 * here. Every header below is one this API deliberately answers *with*, and
 * without this list each one is invisible to the only client CORS exists
 * for:
 *
 * - `Retry-After` is declared in the OpenAPI document itself for
 *   `POST /auth/register` and `POST /auth/login`, so a 429 that a browser
 *   cannot read the number from breaks a published contract: the client can
 *   say "try again later" and nothing more.
 * - `X-Scoreboard-Cache` is a header rather than a body field on purpose
 *   (D25) — the goldens pin the body byte for byte — on the reasoning that
 *   operators and load tests read a header perfectly well. Not from a
 *   browser, they did not.
 * - `x-request-id` is stamped on every response by `requestLogger` and
 *   appears on every log line; it is the one value worth quoting in a bug
 *   report, and a front end that cannot read it cannot show it.
 * - `X-Stats-Cache` (D49) and `X-Booklet-Cache` (D48) are the same choice
 *   `X-Scoreboard-Cache` made, for the same reason, on two routes shipped
 *   after this list was written — and they were left off it, so a browser
 *   on another origin could not read either. **Anything added to this list
 *   must be a header some controller actually sets, and anything a
 *   controller sets must be here**: `test/cors-exposed-headers.spec.ts`
 *   derives the second half from the source rather than trusting the next
 *   author to remember this paragraph.
 *
 * Same-origin traffic through Caddy never needed any of this, which is
 * exactly why its absence went unnoticed.
 */
const EXPOSED_HEADERS = [
  'Retry-After',
  'X-Scoreboard-Cache',
  'X-Stats-Cache',
  'X-Booklet-Cache',
  'X-Request-Id',
];

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
