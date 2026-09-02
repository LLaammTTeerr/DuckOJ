import { Redis } from 'ioredis';
import {
  admittedJudgeCredentials,
  createDb,
  loadDriverLanguageMap,
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
      JSON.stringify({
        msg: 'redis error',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });

  const jobs = new JobStore(db);
  const writer = new EventWriter(db, jobs, new SubmissionEvents(redis));

  // The `python3` -> `PY3` row F-39 seeds is exactly the language the old
  // hard-coded closure here warned about ("must extend BOTH lines here, not
  // one"). Rather than extend it, both directions now come from
  // `language_driver_keys` — one source of truth, and the same one the
  // migration writes (D68, D154).
  //
  // Read at startup and RE-READ thereafter (D173). "Once at startup" held
  // only while adding a language meant a deploy; F-46 made it a migration,
  // and on 2026-09-01 0046 landed against this running process. The judge had
  // self-tested `PAS` and announced it; this map had booted before the row
  // existed; and the executor came back as the language key `pas`, which no
  // row names. Every Pascal submission was blocked against a judge that could
  // run it, and only a restart fixed it.
  const languageMap = await loadDriverLanguageMap(db, 'dmoj');

  const bridge = new BridgeServer({
    // Still passed as a pair, and still for D68's reason: dispatch asks "does
    // this judge have the executor for python3", capability recording asks
    // "what language is PY3", and a fleet gets the wrong answer to one of
    // them the moment the two drift. `loadDriverLanguageMap` is what now
    // guarantees they cannot.
    languageToExecutor: (key) => languageMap.languageToExecutor(key),
    executorToLanguage: (executor) => languageMap.executorToLanguage(executor),
    // The other half of D173: the bridge calls this on every handshake, and
    // `DmojDriver` hands it to the claim loop, which is the trigger a
    // migration against a live stack actually reaches (no judge reconnects
    // when a row is inserted).
    refreshLanguageMap: () => languageMap.reload(),
    // Same check, same table, as the API's `JudgeGuard` — see
    // `verifyJudgeCredential`'s doc comment in `@duckoj/db`.
    verifyJudge: (id, key) => verifyJudgeCredential(db, id, key),
    // `verifyJudge` answers once, at the handshake. This answers again every
    // five seconds for the judges already connected, so `judge:node revoke`
    // and `judge:node rotate` reach a judge that is holding a socket open
    // rather than only the ones that have yet to dial (D81, D204). It asks by
    // (name, token hash), because a rotated node's row is neither gone nor
    // burned and a name-only question would answer "still admitted".
    admittedJudges: (credentials) => admittedJudgeCredentials(db, credentials),
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
