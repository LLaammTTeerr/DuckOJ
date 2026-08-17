import { Redis } from 'ioredis';
import { createDb } from '@qhhoj/db';
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
  const redis = new Redis(config.redisUrl);

  const jobs = new JobStore(db);
  const writer = new EventWriter(db, jobs, new SubmissionEvents(redis));

  const bridge = new BridgeServer({
    // Phase 1 serves exactly one seeded problem, so the mapping is a constant.
    // Phase 2 replaces this with judge-agent's fetch-by-hash.
    hashToProblemCode: () => config.problemCode,
    languageToExecutor: (key) => (key === 'cpp17' ? 'CPP17' : key.toUpperCase()),
  });
  const driver = new DmojDriver(bridge);

  const port = await bridge.listen(config.bridgePort);
  startHealthServer(config.healthPort);
  console.log(JSON.stringify({ msg: 'bridge listening', port }));

  await new Worker(jobs, writer, driver, config.workerId).start();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
