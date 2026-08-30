# B-15 — deploy safety after the 2026-08-30 boot outage

## The finding that reframes item 1
`app.smoke.spec.ts` already compiled the real `AppModule` with no store override and stayed green
through the outage. **It could not have failed, and neither could any spec importing `src/`:** vitest
transforms TypeScript with esbuild, which does not implement `emitDecoratorMetadata` (it needs the
type checker) — so Nest sees no `design:paramtypes` and the un-annotated `Function` parameters are
invisible. Measured: that metadata is `undefined` under the test transform and
`[Object, Function, Function]` in `apps/api/dist`.

## Shipped
1. **`apps/api/test/app.boot.spec.ts`** (63c15b5) — dynamically imports `apps/api/dist` (built by the
   package's own `tsc -b && vitest run`), boots it with `NestFactory.create` (that path has no
   `overrideProvider` seam) through the real `ConfigModule`/`loadConfig` against real env, only
   `DATABASE_URL` (Testcontainers Postgres) and `REDIS_URL` substituted. Asserts every registered
   route's controller resolved, a route-surface floor, `/healthz`, `/readyz`, `GET /api/v1/languages`,
   plus a `design:paramtypes` canary so a "tidy" back to `src/` fails loudly. **Red proof:** reverting
   1ee3796 + rebuilding fails it with the exact outage message — `Nest can't resolve dependencies of
   the RedisScoreboardCacheStore (Symbol(APP_CONFIG), ?, Function)` — while `app.smoke.spec.ts`
   passes all 15, as on the day. Used the real provider, not a scratch one: strictly stronger. CI
   already runs every api spec via `pnpm -r test`, so no workflow change.
2. **`scripts/deploy.sh <service…>` + `scripts/test/deploy.test.sh`** (75e64c5) — builds from a `git
   archive HEAD` export with `COMPOSE_PROJECT_NAME` exported (else the /tmp build tags `tmpdir_api`)
   and `.env` copied in; `:previous` tagged before the build; migrate first when
   `packages/db/migrations` moved since `.deploy/last-deploy` (gitignored), rebuilding the migrate
   image with it; recreate from the repo dir; 45 s poll for healthy + `/api/v1/languages` 200 through
   Caddy + no re-fork lines; automatic rollback, logs, non-zero exit, marker not advanced. 35 shell
   cases against stub podman/compose/curl. **Mutation:** building from the working tree, dropping the
   probe and dropping the re-fork check red 9 of them. Runbook "Deploying" now opens with it;
   `deploy/duckoj.service` untouched.
3. **Crash-loop breaker, D85** (5e6b9cf) — `runPrimary` exits 1 on zero live workers within 60 s of
   primary start; one worker of four dying, a fleet lost long after start, and a SIGTERM shutdown are
   all unchanged. Seams (`cluster`/`now`/`exit`/`schedule`/`onSignal`) drive a fake exit stream.
   **Mutation:** `if (false && …)` reds 2 of 21.
4. **Healthcheck hardening, D86** (9b86794) — `/healthz` answers `{ status, workers }`, the primary
   broadcasting the live count over cluster IPC; the compose probe parses the body, requires
   `workers >= 1`, and carries `AbortSignal.timeout(4000)` + `.catch`. `healthcheck-probe.spec.ts`
   **extracts the command from `docker-compose.yml`** and runs it. **Mutation:** the old one-liner
   reds 4 of 7 — the accept-and-never-answer case by hanging past 30 s, the outage exactly.

## Harness audit (item 5) — recorded, not fixed
- `app.harness.ts::buildApp` imports a **hand-maintained subset of modules** (omits `ConfigModule`,
  `RealtimeModule`, `HealthModule`, `DocsModule`) and applies `cookieParser` + `ProblemFilter` **but
  not `configureApp`** — so ~900 specs run unprefixed, with no CORS, body limits or keep-alive; and
  `APP_CONFIG` → `TEST_CONFIG` everywhere, so `loadConfig(process.env)` runs only in `config.spec.ts`
  and now `app.boot`. Those two specs are the whole cover for both gaps.
- `cache.harness.ts::bypassCache` builds `ScoreboardCache` **by hand** — the shape that hid the
  outage; `TEST_CONFIG.redisUrl` is a closed port, so the suite only ever exercises the
  cache/subscriber failure paths (three dedicated specs cover success). `browserOrigin` stamps
  `Origin`; `csrf-origin.spec.ts` owns the refuse path — faithful, left alone.
- **Fixed (trivial):** `app.boot.spec.ts` sets `SMTP_HOST`/`TYPST_BIN`, so `SmtpMailer` and
  `TypstStatementRenderer` — the production branch of two factories no spec constructed — now build.

## Rulings
- The boot test imports `dist/` rather than adding an swc/vitest transform plugin: no new dependency,
  and `dist` is what the container runs. `abortOnError: false` there is the only concession to the
  runner (Nest's `process.abort()` kills the vitest worker silently); the graph is unchanged.
- `/healthz`'s `workers` is a floor, never 0 — a worker answering the probe is itself alive.
- **Limitation:** `deploy.sh judge-2` fails loudly — podman-compose filters profile-gated services
  out without `--profile scale`, which only `compose-up.sh` passes.
