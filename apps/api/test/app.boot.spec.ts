/**
 * The boot test — the one that would have caught the 2026-08-30 outage.
 *
 * ## What went wrong, and why 913 green tests said nothing
 *
 * `RedisScoreboardCacheStore` grew two default-valued constructor parameters
 * as test seams. Nest reads a constructor's dependencies from the
 * `design:paramtypes` metadata TypeScript emits under `emitDecoratorMetadata`,
 * so those two parameters were read as dependencies of type `Function`,
 * nothing provides `Function`, and every api worker died at boot with
 * `Nest can't resolve dependencies of the RedisScoreboardCacheStore
 * (APP_CONFIG, ?, Function)`. The fix is `@Optional() @Inject(token)`.
 *
 * `app.smoke.spec.ts` already compiles the real `AppModule` — and it stayed
 * green through the whole outage. It could not have gone red, and neither
 * could any other spec in this suite, for a reason that has nothing to do
 * with which providers it overrides:
 *
 * **Vitest transforms TypeScript with esbuild, and esbuild does not
 * implement `emitDecoratorMetadata`** — it needs the type checker, which
 * esbuild does not have. Measured, not assumed: under the test transform
 * `Reflect.getMetadata('design:paramtypes', RedisScoreboardCacheStore)` is
 * `undefined`, while `apps/api/dist/authz/scoreboard.cache.js` — the tsc
 * output the container actually runs — carries
 * `__metadata("design:paramtypes", [Object, Function, Function])`.
 *
 * So in every spec that imports from `src/`, Nest sees NO constructor
 * dependencies at all beyond the explicitly `@Inject()`-ed ones. The
 * un-annotated `Function` parameters are invisible. A spec importing `src/`
 * cannot fail on this class of bug no matter what it does.
 *
 * ## Therefore: this spec imports `dist/`
 *
 * `apps/api`'s `test` script is `tsc -b && vitest run`, so `dist/` is the
 * freshly-compiled production JavaScript by the time this runs. Importing it
 * is what makes the decorator metadata real, and it is the only difference
 * that matters between this file and `app.smoke.spec.ts`.
 *
 * Everything else is production's own path: `NestFactory.create(AppModule)`,
 * not `Test.createTestingModule`, so there is no `overrideProvider` seam to
 * accidentally reach for; the real `ConfigModule` factory running
 * `loadConfig(process.env)` against real environment variables; a real
 * Postgres. Only the addresses are substituted — `DATABASE_URL` points at
 * this file's Testcontainers Postgres and `REDIS_URL` at a closed port (the
 * same deliberately-unreachable address `TEST_CONFIG` documents: the Redis
 * subscriber's dial is never awaited into the boot path, exactly as in
 * production).
 *
 * `import 'reflect-metadata'` is first and the `dist` import is dynamic, in
 * that order, deliberately: tsc's `__metadata` helper is a no-op unless
 * `Reflect.metadata` exists when the class module *evaluates*. Load them the
 * other way round and this file boots happily with no metadata — green, and
 * blind again.
 */
import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { INestApplication, Type } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_PREFIX } from '@duckoj/api-prefix';
import { testDbUrl } from './db.harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');

const REQUEST_METHOD_NAME: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
  [RequestMethod.ALL]: 'ALL',
};

interface BootRoute {
  key: string;
  controller: Type<unknown>;
  resolved: boolean;
}

/**
 * Every route Nest registered, read off the container of the *booted*
 * application — the same place `RoutesResolver` reads it — together with
 * whether the controller behind it actually got an instance.
 *
 * `resolved` is the load-bearing field. A controller whose dependency graph
 * cannot be satisfied never reaches `instance`, and that is precisely the
 * shape of the outage: the route is declared, the class exists, and nothing
 * can construct it.
 */
function bootRoutes(container: ModulesContainer): BootRoute[] {
  const routes: BootRoute[] = [];
  for (const module of container.values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = (wrapper.metatype ?? wrapper.instance?.constructor) as
        | Type<unknown>
        | undefined;
      if (!controller) continue;
      const prefixRaw = Reflect.getMetadata(PATH_METADATA, controller) as
        | string
        | string[]
        | undefined;
      const prefix = Array.isArray(prefixRaw) ? (prefixRaw[0] ?? '') : (prefixRaw ?? '');
      const prototype = controller.prototype as Record<string, unknown>;
      for (const methodName of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[methodName];
        if (typeof handler !== 'function') continue;
        const methodMeta = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        if (methodMeta === undefined) continue;
        const handlerPathRaw = Reflect.getMetadata(PATH_METADATA, handler) as
          | string
          | string[]
          | undefined;
        const handlerPath = Array.isArray(handlerPathRaw)
          ? (handlerPathRaw[0] ?? '')
          : (handlerPathRaw ?? '');
        const segments = [prefix, handlerPath].filter((s) => s && s !== '/');
        const path = '/' + segments.join('/').replace(/\/+/g, '/').replace(/^\/+/, '');
        routes.push({
          key: `${REQUEST_METHOD_NAME[methodMeta] ?? String(methodMeta)} ${path}`,
          controller,
          resolved: wrapper.instance !== undefined && wrapper.instance !== null,
        });
      }
    }
  }
  return routes;
}

describe('the real AppModule boots the way the container boots it', () => {
  let app: INestApplication;
  let routes: BootRoute[];
  let cacheStore: Type<unknown>;

  beforeAll(async () => {
    if (!existsSync(join(DIST, 'app.module.js'))) {
      throw new Error(
        `apps/api/dist is missing — this spec loads the tsc-compiled application on purpose ` +
          `(see the header). Run \`corepack pnpm --filter @duckoj/api exec tsc -b\` first; the ` +
          `package's own \`test\` script already does.`,
      );
    }

    // Real environment, real `loadConfig`, real `ConfigModule` factory. Only
    // the addresses differ from production.
    process.env.NODE_ENV = 'production';
    // Never actually bound — `app.init()` does not listen; supertest dispatches
    // in memory. A real port number because `loadConfig` rejects 0.
    process.env.PORT = '3000';
    process.env.DATABASE_URL = await testDbUrl();
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    process.env.TOTP_ENC_KEY = '11'.repeat(32);
    process.env.PUBLIC_ORIGIN = 'http://localhost:5173';
    process.env.LOG_LEVEL = 'fatal';
    process.env.PACKAGE_STORE_DIR = await mkdtemp(join(tmpdir(), 'duckoj-boot-packages-'));
    // The PRODUCTION branch of two factories nothing else boots.
    // `TEST_CONFIG` sets `smtp: null` and `typstBin: null`, so every other
    // spec in this suite constructs `LogMailer` and `NullStatementRenderer`
    // and neither `SmtpMailer` nor `TypstStatementRenderer` is ever built by
    // a module at all. Neither construction dials or spawns anything — a
    // nodemailer transport is lazy and the renderer only stores a path — so
    // naming them here costs nothing and closes the gap.
    process.env.SMTP_HOST = 'smtp.invalid';
    process.env.TYPST_BIN = '/nonexistent/typst';

    const [{ AppModule }, { configureApp }, { loadConfig }, { RedisScoreboardCacheStore }, core] =
      await Promise.all([
        import('../dist/app.module.js'),
        import('../dist/app.setup.js'),
        import('../dist/config/config.schema.js'),
        import('../dist/authz/scoreboard.cache.js'),
        import('@nestjs/core'),
      ]);
    cacheStore = RedisScoreboardCacheStore;

    // `NestFactory.create`, not `Test.createTestingModule`: there is no
    // `overrideProvider` on this path, so "no provider overrides" is a
    // property of the API used rather than a promise in a comment. This is
    // also where the outage threw — Nest instantiates the whole provider
    // graph during `create`.
    // `abortOnError: false` is the ONE concession to running inside a test
    // runner: Nest's default is `process.abort()` on an initialisation error,
    // which kills the vitest worker outright and reports "Worker exited
    // unexpectedly" instead of the dependency Nest could not resolve. It
    // changes nothing about how the graph is built — only what happens after
    // it has already failed.
    app = await core.NestFactory.create(AppModule, { bufferLogs: true, abortOnError: false });
    configureApp(app, loadConfig(process.env));
    await app.init();

    routes = bootRoutes(app.get(ModulesContainer));
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  /**
   * The canary for the mechanism this whole file rests on.
   *
   * If this ever reads `undefined`, the spec below has silently become a
   * duplicate of `app.smoke.spec.ts` — still green, and no longer able to
   * see a `Function` dependency. That would happen if someone "tidied" the
   * dynamic `dist` imports above into `src` imports, moved
   * `import 'reflect-metadata'` down, or turned `emitDecoratorMetadata` off.
   *
   * The three entries are the outage itself, frozen: `[Object, Function,
   * Function]` — `APP_CONFIG`, and the two test seams whose design type is
   * `Function`. `@Optional()` on those two is the entire fix, and it is
   * invisible in this metadata; what the metadata proves is that the
   * question is being ASKED here, which is what no other spec does.
   */
  it('loads production decorator metadata, not the test transform which emits none', () => {
    const paramtypes = Reflect.getMetadata('design:paramtypes', cacheStore) as unknown[] | undefined;
    expect(paramtypes, 'no design:paramtypes — this spec is not loading dist/').toBeDefined();
    expect(paramtypes).toHaveLength(3);
    expect(paramtypes?.[1]).toBe(Function);
    expect(paramtypes?.[2]).toBe(Function);
  });

  /**
   * The assertion the outage needed. Every controller Nest registered got an
   * instance, which means every provider it transitively depends on resolved.
   *
   * Nest actually throws during `NestFactory.create` on an unresolvable
   * dependency, so `beforeAll` fails first and this never gets to report —
   * which is fine; this states the property in the file so the next reader
   * knows it is the point rather than incidental.
   */
  it('resolves every controller behind every registered route', () => {
    const unresolved = routes.filter((r) => !r.resolved).map((r) => r.key);
    expect(unresolved).toEqual([]);
  });

  it('registers the whole route surface, not a subset of the modules', () => {
    // A floor, not an exact count — new routes are added constantly. It
    // catches an `AppModule` that lost a module import wholesale, which is
    // the failure `app.harness.ts`'s hand-maintained parallel module list
    // makes easy to introduce.
    expect(routes.length).toBeGreaterThan(70);
    const keys = routes.map((r) => r.key);
    for (const required of [
      'GET /healthz',
      'GET /readyz',
      'GET /languages',
      'GET /problems',
      'GET /contests',
      'POST /submissions',
      'POST /auth/login',
    ]) {
      expect(keys, `${required} is not registered`).toContain(required);
    }
  });

  it('answers /healthz, unprefixed and anonymously, with the body the healthcheck parses', async () => {
    const res = await request(app.getHttpServer()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    // D86: `docker-compose.yml`'s probe requires `workers >= 1` out of the
    // COMPILED build — the one the container runs.
    expect(res.body.workers).toBeGreaterThanOrEqual(1);
  });

  /**
   * The exact route `scripts/deploy.sh` polls through Caddy after a recreate,
   * asserted here against the same compiled build the container runs. It is a
   * real 200 with a real body — a route that reaches a service, not just a
   * port that accepts a connection, which is the whole distinction the
   * outage turned on.
   */
  it(`answers ${API_PREFIX}/languages 200 — the route the deploy poll uses`, async () => {
    const res = await request(app.getHttpServer()).get(`/${API_PREFIX}/languages`);
    expect(res.status).toBe(200);
    // A real body from a real query against a real (migrated) database — the
    // `languages` table is seeded by `scripts/seed-problem.ts`, not by a
    // migration, so an empty list here is correct and a 500 would not be.
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('reaches the database it was given, through the real ConfigModule factory', async () => {
    const res = await request(app.getHttpServer()).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.database).toBe('ok');
  });
});
