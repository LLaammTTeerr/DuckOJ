import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { DestinationStream } from 'pino';
import type { Db } from '@qhhoj/db';
import { AuthnModule } from '../src/authn/authn.module.js';
import { OrgsModule } from '../src/orgs/orgs.module.js';
import { APP_CONFIG, DB } from '../src/config/config.module.js';
import { ProblemFilter } from '../src/common/problem.filter.js';
import { requestLogger } from '../src/common/logger.js';
import type { AppConfig } from '../src/config/config.schema.js';

export const TEST_CONFIG: AppConfig = {
  nodeEnv: 'test',
  port: 0,
  databaseUrl: 'postgres://unused',
  sessionCookieName: 'qhhoj_session',
  sessionTtlHours: 720,
  totpEncKey: Buffer.alloc(32, 1),
  publicOrigin: 'http://localhost:5173',
  logLevel: 'silent',
};

export interface BuildAppOptions {
  /**
   * Installs the production `requestLogger` middleware writing to this stream,
   * for tests that assert on what actually reaches the log. Omitted by default
   * so the rest of the suite stays silent.
   */
  logging?: { level: string; destination: DestinationStream };
}

export async function buildApp(db: Db, options: BuildAppOptions = {}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AuthnModule, OrgsModule] })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(APP_CONFIG)
    .useValue(TEST_CONFIG)
    .compile();

  const app = moduleRef.createNestApplication();
  if (options.logging) {
    app.use(requestLogger(options.logging.level, options.logging.destination));
  }
  app.use(cookieParser());
  app.useGlobalFilters(new ProblemFilter());
  await app.init();
  return app;
}
