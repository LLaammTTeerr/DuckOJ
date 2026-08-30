import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
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
import { ProblemFilter } from '../src/common/problem.filter.js';
import { requestLogger } from '../src/common/logger.js';
import type { AppConfig } from '../src/config/config.schema.js';
import { ensureRedisUrl } from './redis.harness.js';

export const TEST_CONFIG: AppConfig = {
  // No SMTP: tests use `LogMailer`, and a test that wants to read what was
  // sent injects the mailer and reads `sent`. A suite must never need a mail
  // server to register a user.
  smtp: null,
  mailFrom: 'DuckOJ <test@duckoj.local>',
  // No typst binary either: the PDF route answers 501 unless a test
  // injects a renderer, mirroring the LogMailer reasoning above.
  typstBin: null,
  nodeEnv: 'test',
  port: 0,
  databaseUrl: 'postgres://unused',
  // `AppModule` (only instantiated whole by `app.smoke.spec.ts`) now includes
  // `RealtimeModule`, whose `RedisSubscriber` dials this address. It is
  // deliberately unreachable rather than a real container: `buildApp` never
  // awaits the subscription, so a refused connection just logs and retries
  // in the background exactly as it would against a real, temporarily-down
  // Redis — it must never block `app.init()`. Tests that need a live
  // subscriber use `buildAppWithRealtime`, which overrides this with a real
  // container's URL.
  redisUrl: 'redis://127.0.0.1:1',
  sessionCookieName: 'duckoj_session',
  sessionTtlHours: 720,
  totpEncKey: Buffer.alloc(32, 1),
  publicOrigin: 'http://localhost:5173',
  wsAllowedOrigins: ['http://localhost:5173'],
  logLevel: 'silent',
  // `buildApp` overrides this with a fresh temp directory per call (mirrors
  // how `buildAppWithRealtime` overrides `redisUrl`), so tests that actually
  // upload get an isolated store. This default only backs callers — like
  // `app.smoke.spec.ts` — that use `TEST_CONFIG` as-is and never touch the
  // package store, so it never needs to exist on disk.
  packageStoreDir: join(tmpdir(), 'duckoj-test-packages-unused'),
  packageUploadMaxBytes: 256 * 1024 * 1024,
};

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
}

export async function buildApp(db: Db, options: BuildAppOptions = {}): Promise<INestApplication> {
  // A fresh directory per call, not the shared `TEST_CONFIG` default: tests
  // in `packages.spec.ts` actually write blobs, and sharing one directory
  // across every test in the file (or across files, since `mkdtemp` here is
  // per-`buildApp`-call rather than per-process) would let one test's store
  // state leak into another's.
  const packageStoreDir = await mkdtemp(join(tmpdir(), 'duckoj-test-packages-'));

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
    .useValue({ ...TEST_CONFIG, packageStoreDir, ...options.configOverrides });

  for (const override of options.overrides ?? []) {
    builder = builder.overrideProvider(override.provide).useValue(override.useValue);
  }

  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication();
  if (options.logging) {
    app.use(requestLogger(options.logging.level, options.logging.destination));
  }
  app.use(cookieParser());
  app.useGlobalFilters(new ProblemFilter());
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
  app.use(cookieParser());
  app.useGlobalFilters(new ProblemFilter());
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
