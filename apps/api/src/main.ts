import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import { loadConfig } from './config/config.schema.js';
import { requestLogger } from './common/logger.js';
import { ProblemFilter } from './common/problem.filter.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env);
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.use(requestLogger(config.logLevel));
  app.use(cookieParser());
  app.useGlobalFilters(new ProblemFilter());
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  app.enableCors({ origin: config.publicOrigin, credentials: true });
  await app.listen(config.port);
}

void bootstrap();
