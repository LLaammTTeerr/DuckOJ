import type { INestApplication } from '@nestjs/common';
import { API_PREFIX } from '@qhhoj/api-prefix';
import cookieParser from 'cookie-parser';
import type { DestinationStream } from 'pino';
import type { AppConfig } from './config/config.schema.js';
import { requestLogger } from './common/logger.js';
import { ProblemFilter } from './common/problem.filter.js';

/**
 * Everything that turns a bare `AppModule` into the application this project
 * actually serves: request logging, cookie parsing, problem+json errors, the
 * `API_PREFIX` (`@qhhoj/api-prefix`) with its health-probe exclusions, and CORS.
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
}
