import { availableParallelism } from 'node:os';
import cluster from 'node:cluster';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { resolveWorkerCount, runPrimary } from './cluster.js';
import { warnIfRedisUnbounded } from './common/redis-maxmemory.js';
import { loadConfig } from './config/config.schema.js';
import { SubmissionsGateway } from './realtime/submissions.gateway.js';
import { listenForWorkerCount } from './worker-count.js';

async function bootstrap(): Promise<void> {
  // D86. Before anything else that can fail: the primary broadcasts the live
  // worker count the moment it forks this process, and `/healthz` reports it.
  // Only a worker has a channel to listen on — with `API_WORKERS=1` there is
  // no primary at all, and `reportedWorkerCount()` answers 1 because this
  // process is the one worker.
  if (cluster.isWorker) {
    listenForWorkerCount((handler) => {
      process.on('message', handler);
    });
  }

  const config = loadConfig(process.env);
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  configureApp(app, config);
  await app.listen(config.port);
  // After `listen`, so `getHttpServer()` returns the server that is actually
  // accepting connections rather than one still being bound.
  app.get(SubmissionsGateway).attach(app.getHttpServer());
  // After `listen` too, and never awaited into the boot path: an unbounded
  // Redis is worth a line in the log and is not worth a second of startup.
  // Only ONE worker asks — `API_WORKERS=4` saying the same thing four times
  // reads as four problems. Deliberately here rather than in a Nest provider:
  // every API spec builds the module, and a provider would have each of them
  // dial a Redis that `TEST_CONFIG` points at a closed port on purpose.
  if (!cluster.isWorker || cluster.worker?.id === 1) {
    void warnIfRedisUnbounded(config.redisUrl, new Logger('RedisConfig'));
  }
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
