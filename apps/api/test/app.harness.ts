import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import type { DestinationStream } from 'pino';
import type { Db } from '@duckoj/db';
import { SUBMISSION_CHANNEL } from '@duckoj/realtime';
import { AuthnModule } from '../src/authn/authn.module.js';
import { MailModule } from '../src/mail/mail.module.js';
import { AdminModule } from '../src/admin/admin.module.js';
import { OrgsModule } from '../src/orgs/orgs.module.js';
import { ContestsModule } from '../src/contests/contests.module.js';
import { ProblemsModule } from '../src/problems/problems.module.js';
import { SubmissionsModule } from '../src/submissions/submissions.module.js';
import { RealtimeModule } from '../src/realtime/realtime.module.js';
import { NotificationsModule } from '../src/notifications/notifications.module.js';
import { PackagesModule } from '../src/packages/packages.module.js';
import { LanguagesModule } from '../src/languages/languages.module.js';
import { TagsModule } from '../src/tags/tags.module.js';
import { UsersModule } from '../src/users/users.module.js';
import { RedisSubscriber } from '../src/realtime/redis-subscriber.js';
import { SubmissionsGateway } from '../src/realtime/submissions.gateway.js';
import { APP_CONFIG, DB } from '../src/config/config.module.js';
import { configureApp } from '../src/app.setup.js';
import { type AppConfig, loadConfig } from '../src/config/config.schema.js';
import { ensureRedisUrl } from './redis.harness.js';

/**
 * The environment a test API runs under — the same variable names
 * `docker-compose.yml` sets, parsed by the same `loadConfig` the container's
 * `main.ts` calls (D91).
 *
 * `TEST_CONFIG` used to be a hand-written `AppConfig` object literal, and that
 * was the only reason `loadConfig` had a single caller in the whole suite:
 * ~900 specs ran against a config shape assembled by hand, so a schema that
 * disagreed with the object (a renamed key, a new required field, a default
 * that moved) was invisible until a real bring-up. Going through the parser
 * makes the suite's config the parser's output by construction.
 *
 * The values are the old literal's, restated as env strings — see the
 * comments below for the two that are load-bearing.
 */
export const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  // Never listened on: `buildApp` dispatches in memory and
  // `buildAppWithRealtime` calls `app.listen(0)`. The old literal said `0`,
  // which `EnvSchema` refuses (`PORT` is `min(1)`) — itself a small proof
  // that the hand-written object was not a config the schema would accept.
  PORT: '3000',
  DATABASE_URL: 'postgres://unused',
  // Deliberately unreachable rather than a real container: `buildApp` never
  // awaits the subscription, so a refused connection just logs and retries in
  // the background exactly as it would against a real, temporarily-down Redis
  // — it must never block `app.init()`. Tests that need a live subscriber use
  // `buildAppWithRealtime`, which overrides this with a real container's URL.
  REDIS_URL: 'redis://127.0.0.1:1',
  TOTP_ENC_KEY: '01'.repeat(32),
  PUBLIC_ORIGIN: 'http://localhost:5173',
  // `configureApp` installs `requestLogger(config.logLevel)` on every app the
  // harness builds, so this is what keeps the suite silent. `silent` is a
  // pino level; `LOG_LEVEL` accepts it (see `config.schema.ts`).
  LOG_LEVEL: 'silent',
  MAIL_FROM: 'DuckOJ <test@duckoj.local>',
  // No `SMTP_HOST`: tests use `LogMailer`, and a test that wants to read what
  // was sent injects the mailer and reads `sent`. A suite must never need a
  // mail server to register a user. No `TYPST_BIN` either: the PDF route
  // answers 501 unless a test injects a renderer.
  //
  // `buildApp` overrides `PACKAGE_STORE_DIR`'s result with a fresh temp
  // directory per call, so this default only backs callers — like
  // `app.smoke.spec.ts` — that use `TEST_CONFIG` as-is and never touch the
  // package store; it never needs to exist on disk.
  PACKAGE_STORE_DIR: join(tmpdir(), 'duckoj-test-packages-unused'),
};

export const TEST_CONFIG: AppConfig = loadConfig(TEST_ENV);

export interface BuildAppOptions {
  /**
   * Installs the production `requestLogger` middleware writing to this stream,
   * for tests that assert on what actually reaches the log. Omitted by default
   * so the rest of the suite stays silent.
   */
  logging?: { level: string; destination: DestinationStream };
  /**
   * Merged over `TEST_CONFIG` (after the per-call `packageStoreDir`), for
   * tests that need one config value away from the default — e.g. shrinking
   * `packageUploadMaxBytes` to a few bytes so the over-limit path is
   * reachable without actually uploading hundreds of megabytes.
   */
  configOverrides?: Partial<AppConfig>;
  /**
   * Provider substitutions applied on top of the usual `DB`/`APP_CONFIG`
   * overrides — the same fault-injection seam `buildAppWithRealtime` has,
   * e.g. swapping `MAILER` for one whose `send` rejects to prove an outage
   * does not block registration.
   */
  overrides?: RealtimeOverride[];
  /**
   * Skips the `Origin` stamp described on {@link browserOrigin} — for the
   * tests that are ABOUT the missing header (D82's "a session cookie and
   * nothing to say where it came from is a refusal").
   */
  rawOrigin?: boolean;
}

/**
 * Stamps `Origin` on a request that names neither `Origin` nor `Referer`.
 *
 * `request.agent(...)` is a browser simulation — it keeps a cookie jar and
 * replays it — and every browser this decade sends `Origin` on every unsafe
 * method. Supertest does not, so without this the suite's 400-odd
 * cookie-authenticated writes would all meet `CsrfOriginGuard` (D82) as
 * requests from nowhere. This makes the simulation faithful rather than
 * turning the guard off: it is exactly one header, added only when the
 * request supplied neither, so a test that sets a HOSTILE origin is untouched
 * and reaches the guard as written.
 *
 * The arrangement is deliberate in both directions: those 400-odd requests
 * now exercise the guard's ADMIT path on every run — a guard that refused a
 * legitimate origin would fail all of them — and `csrf-origin.spec.ts`, which
 * passes `rawOrigin`, owns the refuse path.
 */
function browserOrigin(origin: string) {
  return (
    req: { headers: Record<string, string | string[] | undefined> },
    _res: unknown,
    next: () => void,
  ): void => {
    if (req.headers.origin === undefined && req.headers.referer === undefined) {
      req.headers.origin = origin;
    }
    next();
  };
}

export async function buildApp(db: Db, options: BuildAppOptions = {}): Promise<INestApplication> {
  // A fresh directory per call, not the shared `TEST_CONFIG` default: tests
  // in `packages.spec.ts` actually write blobs, and sharing one directory
  // across every test in the file (or across files, since `mkdtemp` here is
  // per-`buildApp`-call rather than per-process) would let one test's store
  // state leak into another's.
  const packageStoreDir = await mkdtemp(join(tmpdir(), 'duckoj-test-packages-'));

  // One config object, injected AND handed to `configureApp` — production
  // reads one `loadConfig` result in both places, and a harness that gave the
  // providers one object and the middleware another would be able to disagree
  // with itself about the public origin or the log level.
  const config: AppConfig = {
    ...TEST_CONFIG,
    packageStoreDir,
    ...options.configOverrides,
    // `options.logging` is the one setting that is not a config override:
    // it exists so a spec can READ the log, so it must beat `TEST_ENV`'s
    // `silent`.
    ...(options.logging === undefined ? {} : { logLevel: options.logging.level }),
  };

  let builder = Test.createTestingModule({
    // Deliberately NOT `AppModule`'s list, and deliberately not shared with it:
    // this omits `ConfigModule` (which would build its own database pool
    // instead of the Testcontainers one overridden below), `RealtimeModule`
    // (which dials Redis on construction) and `HealthModule`/`DocsModule`.
    // Sharing one array between the two was tried and broke 127 tests.
    // The cost is that a new module must be added in both places.
    imports: [
      MailModule,
      AuthnModule,
      AdminModule,
      OrgsModule,
      ContestsModule,
      ProblemsModule,
      SubmissionsModule,
      PackagesModule,
      LanguagesModule,
      TagsModule,
      UsersModule,
      NotificationsModule,
    ],
  })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(APP_CONFIG)
    .useValue(config);

  for (const override of options.overrides ?? []) {
    builder = builder.overrideProvider(override.provide).useValue(override.useValue);
  }

  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication();
  // BEFORE `configureApp`, so the stamp is in place by the time anything the
  // production wiring installs (the logger, the body parsers) sees the
  // request — and, more importantly, by the time `CsrfOriginGuard` runs.
  if (!options.rawOrigin) {
    app.use(browserOrigin(config.publicOrigin));
  }
  // The production wiring itself (D91), not a hand-rolled subset of it: the
  // `/api/v1` prefix, CORS with its exposed-header list, the two body
  // parsers and their limits, `cookieParser`, `ProblemFilter`, the keep-alive
  // timeouts and `x-powered-by` off. Before this, `buildApp` applied
  // `cookieParser` and `ProblemFilter` by hand and nothing else, so ~900
  // specs ran unprefixed against an app that shared only two lines with the
  // one the container serves.
  configureApp(app, config, options.logging?.destination);
  await app.init();
  return app;
}

export interface RealtimeAppHandle {
  app: INestApplication;
  /** The `ws://` origin of a *listening* server, e.g. `${url}/ws`. */
  url: string;
  /** Publishes `submissionId` on the same Redis channel the subscriber listens to. */
  publish: (submissionId: number) => Promise<void>;
}

/**
 * A provider substitution applied on top of the usual `DB`/`APP_CONFIG`
 * overrides — the seam a fault-injection test uses to make e.g.
 * `SessionService.resolve` throw, to pin the gateway's upgrade-handler
 * `.catch()` against a real database-error shape rather than only the
 * malformed-cookie input the parser now handles without ever throwing.
 */
export interface RealtimeOverride {
  provide: unknown;
  useValue: unknown;
}

/**
 * Like `buildApp`, but with `RealtimeModule` wired in exactly as `main.ts`
 * wires it: a real, listening HTTP server (a raw `ws` upgrade needs an actual
 * socket to dial, not `supertest`'s in-memory dispatch) with the gateway
 * `attach`ed to it, backed by a real — `testcontainers` — Redis so the
 * subscriber's pub/sub round-trip is genuine rather than mocked.
 */
export async function buildAppWithRealtime(
  db: Db,
  options: { overrides?: RealtimeOverride[] } = {},
): Promise<RealtimeAppHandle> {
  const redisUrl = await ensureRedisUrl();

  let builder = Test.createTestingModule({
    imports: [MailModule, AuthnModule, OrgsModule, SubmissionsModule, RealtimeModule],
  })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(APP_CONFIG)
    .useValue({ ...TEST_CONFIG, redisUrl });

  for (const override of options.overrides ?? []) {
    builder = builder.overrideProvider(override.provide).useValue(override.useValue);
  }

  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication();
  // Realtime tests POST submissions through an agent too — see `browserOrigin`.
  app.use(browserOrigin(TEST_CONFIG.publicOrigin));
  // Same production wiring as `buildApp` (D91) — and here it matters twice
  // over: this app actually `listen`s, so the keep-alive timeouts
  // `configureApp` sets are the ones a real socket gets.
  configureApp(app, { ...TEST_CONFIG, redisUrl });
  await app.init();

  // Wait for the dedicated subscriber connection to actually be subscribed
  // before this handle is usable: `main.ts` never waits on this (a Redis
  // outage at boot must not block startup), but a test that publishes right
  // after boot would otherwise race "connected" against "published" and lose
  // the message — flaking rather than failing honestly.
  await app.get(RedisSubscriber).ready;

  await app.listen(0);
  app.get(SubmissionsGateway).attach(app.getHttpServer());

  const address = app.getHttpServer().address() as AddressInfo;
  const url = `ws://127.0.0.1:${address.port}`;

  return {
    app,
    url,
    // A short-lived connection per call, not a connection held for the whole
    // handle's lifetime: this is a test helper called once or twice per
    // test, so the extra connect/quit round trip costs nothing and needs no
    // cleanup wired into `app.close()`.
    publish: async (submissionId: number) => {
      const publisher = new Redis(redisUrl);
      try {
        await publisher.publish(SUBMISSION_CHANNEL, String(submissionId));
      } finally {
        publisher.disconnect();
      }
    },
  };
}
