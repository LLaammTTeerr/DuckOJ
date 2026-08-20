import { Redis } from 'ioredis';
import { createDb, touchJudgeLastSeen, verifyJudgeCredential } from '@duckoj/db';
import { describeError } from '@duckoj/observability';
import { loadConfig } from './config.js';
import { startHealthServer } from './health.js';
import { JobStore } from './job-store.js';
import { EventWriter } from './event-writer.js';
import { SubmissionEvents } from './submission-events.js';
import { HttpAgentClient } from './drivers/dmoj/agent-client.js';
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
    languageToExecutor: (key) => (key === 'cpp17' ? 'CPP17' : key.toUpperCase()),
    // Same check, same table, as the API's `JudgeGuard` — see
    // `verifyJudgeCredential`'s doc comment in `@duckoj/db`.
    verifyJudge: (id, key) => verifyJudgeCredential(db, id, key),
    // Design §8: "`lastSeen` gets written on handshake and heartbeat" — see
    // `touchJudgeLastSeen`'s and `BridgeOptions.recordLastSeen`'s doc
    // comments for exactly which two signals that means.
    recordLastSeen: (id) => touchJudgeLastSeen(db, id),
  });
  const agent = new HttpAgentClient({ agentOrigin: config.agentOrigin });
  const driver = new DmojDriver(bridge, agent);

  const port = await bridge.listen(config.bridgePort);
  startHealthServer(config.healthPort);
  console.log(JSON.stringify({ msg: 'bridge listening', port }));

  await new Worker(jobs, writer, driver, config.workerId).start();
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ msg: 'judged failed to start', error: describeError(error) }));
  process.exit(1);
});
