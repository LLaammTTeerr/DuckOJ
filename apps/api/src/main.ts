import { availableParallelism } from 'node:os';
import cluster from 'node:cluster';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { resolveWorkerCount, runPrimary } from './cluster.js';
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

// One process saturates one core (see cluster.ts). `API_WORKERS=1` is the
// old single-process behaviour, unchanged and still one `bootstrap()` call —
// the fork path is entered only when there is actually something to fork.
// The check is `isPrimary` as well as `> 1` because a forked worker
// re-executes this same file and must take the bootstrap branch.
const workers = resolveWorkerCount(process.env, availableParallelism());
if (workers > 1 && cluster.isPrimary) {
  runPrimary(workers);
} else {
  void bootstrap();
}
