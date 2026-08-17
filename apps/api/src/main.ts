import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { loadConfig } from './config/config.schema.js';
import { SubmissionsGateway } from './realtime/submissions.gateway.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env);
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  configureApp(app, config);
  await app.listen(config.port);
  // After `listen`, so `getHttpServer()` returns the server that is actually
  // accepting connections rather than one still being bound.
  app.get(SubmissionsGateway).attach(app.getHttpServer());
}

void bootstrap();
