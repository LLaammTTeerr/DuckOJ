import { Redis } from 'ioredis';
import {
  createDb,
  recordJudgeCapabilities,
  touchJudgeLastSeen,
  verifyJudgeCredential,
} from '@duckoj/db';
import { describeError } from '@duckoj/observability';
import { loadConfig } from './config.js';
import { startHealthServer } from './health.js';
import { JobStore } from './job-store.js';
import { EventWriter } from './event-writer.js';
import { SubmissionEvents } from './submission-events.js';
import { HttpAgentClient } from './drivers/dmoj/agent-client.js';
import { BridgeServer } from './drivers/dmoj/bridge-server.js';
import { DmojDriver } from './drivers/dmoj/dmoj-driver.js';
import { startWorkerPool } from './worker.js';

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
    // The two directions are written together because they must stay
    // inverses of each other: dispatch asks "does this judge have the
    // executor for cpp17", capability recording asks "what language is
    // CPP17", and a fleet with judges configured differently gets the wrong
    // answer to one of them the moment the pair drifts (D68). Today every
    // key is its executor lowercased, so both halves are one rule; a future
    // language whose executor is not simply its key uppercased (`python3` ->
    // `PY3`, say) must extend BOTH lines here, not one.
    languageToExecutor: (key) => (key === 'cpp17' ? 'CPP17' : key.toUpperCase()),
    executorToLanguage: (executor) => executor.toLowerCase(),
    // Same check, same table, as the API's `JudgeGuard` — see
    // `verifyJudgeCredential`'s doc comment in `@duckoj/db`.
    verifyJudge: (id, key) => verifyJudgeCredential(db, id, key),
    // Design §8: "`lastSeen` gets written on handshake and heartbeat" — see
    // `touchJudgeLastSeen`'s and `BridgeOptions.recordLastSeen`'s doc
    // comments for exactly which two signals that means.
    recordLastSeen: (id) => touchJudgeLastSeen(db, id),
    // `judge_nodes.capabilities` was written by nothing until now (D47's
    // report), so the dashboard could show a judge but not what it can run.
    recordCapabilities: (id, capabilities) => recordJudgeCapabilities(db, id, capabilities),
  });
  const agent = new HttpAgentClient({ agentOrigin: config.agentOrigin });
  const driver = new DmojDriver(bridge, agent);

  const port = await bridge.listen(config.bridgePort);
  startHealthServer(config.healthPort);
  console.log(JSON.stringify({ msg: 'bridge listening', port }));

  console.log(JSON.stringify({ msg: 'starting worker pool', concurrency: config.concurrency }));
  await startWorkerPool(jobs, writer, driver, config.workerId, config.concurrency).finished;
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ msg: 'judged failed to start', error: describeError(error) }));
  process.exit(1);
});
