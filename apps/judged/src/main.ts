import { Redis } from 'ioredis';
import { createDb, verifyJudgeCredential } from '@qhhoj/db';
import { describeError } from '@qhhoj/observability';
import { loadConfig } from './config.js';
import { startHealthServer } from './health.js';
import { JobStore } from './job-store.js';
import { EventWriter } from './event-writer.js';
import { SubmissionEvents } from './submission-events.js';
import { BridgeServer } from './drivers/dmoj/bridge-server.js';
import { DmojDriver } from './drivers/dmoj/dmoj-driver.js';
import { Worker } from './worker.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const { db } = createDb(config.databaseUrl);
  // commandTimeout, not enableOfflineQueue: false — the latter would also
  // fail commands issued during the initial connect, which is worse. A
  // publish that cannot complete in 5s should fail (and get logged, and
  // the job re-lease) rather than hang the worker loop forever.
  const redis = new Redis(config.redisUrl, { commandTimeout: 5000 });
  redis.on('error', (error: unknown) => {
    // ioredis suppresses 'error' emissions entirely when nothing is
    // listening, so without this a dead Redis fails silently: judged
    // reports a clean startup while every publish quietly never lands.
    console.error(
      JSON.stringify({ msg: 'redis error', error: error instanceof Error ? error.message : String(error) }),
    );
  });

  const jobs = new JobStore(db);
  const writer = new EventWriter(db, jobs, new SubmissionEvents(redis));

  const bridge = new BridgeServer({
    // Phase 1 serves exactly one seeded problem, so the mapping is a constant.
    // Phase 2 replaces this with judge-agent's fetch-by-hash.
    hashToProblemCode: () => config.problemCode,
    languageToExecutor: (key) => (key === 'cpp17' ? 'CPP17' : key.toUpperCase()),
    // Same check, same table, as the API's `JudgeGuard` — see
    // `verifyJudgeCredential`'s doc comment in `@qhhoj/db`.
    verifyJudge: (id, key) => verifyJudgeCredential(db, id, key),
  });
  const driver = new DmojDriver(bridge);

  const port = await bridge.listen(config.bridgePort);
  startHealthServer(config.healthPort);
  console.log(JSON.stringify({ msg: 'bridge listening', port }));

  await new Worker(jobs, writer, driver, config.workerId).start();
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ msg: 'judged failed to start', error: describeError(error) }));
  process.exit(1);
});
