import { existsSync } from 'node:fs';
import { afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrations, type Db } from '@duckoj/db';

// Testcontainers speaks the Docker API. This local sandbox has no Docker
// daemon but does have rootless Podman exposing a Docker-compatible socket.
// Point Testcontainers at it when Docker's own socket is absent, so tests
// work here without manual setup. On CI (which has /var/run/docker.sock)
// this block is a no-op.
if (!process.env.DOCKER_HOST) {
  const podmanSocket = `/run/user/${process.getuid?.() ?? 1000}/podman/podman.sock`;
  if (!existsSync('/var/run/docker.sock') && existsSync(podmanSocket)) {
    process.env.DOCKER_HOST = `unix://${podmanSocket}`;
  }
}

let container: StartedPostgreSqlContainer | undefined;
let url: string | undefined;

async function ensureContainer(): Promise<string> {
  if (url) return url;
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  url = container.getConnectionUri();
  await runMigrations(url);
  return url;
}

const STOP_RETRY_DELAYS_MS = [500, 1000, 2000];

// Rootless Podman occasionally fails to remove a container's network
// namespace when several containers are torn down within the same second
// ("rootless netns: kill network process: permission denied"), even though
// the container itself has already stopped — this has been observed when
// several spec files finish at once. Retrying clears it in practice; if
// every attempt still fails, warn and move on rather than fail this spec
// file over a stopped container Ryuk (or the next manual sweep) can still
// clean up — a teardown that intermittently reds the whole suite would be
// worse than the leak it replaces.
async function stopWithRetry(target: { stop(): Promise<unknown> }): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await target.stop();
      return;
    } catch (error) {
      if (attempt >= STOP_RETRY_DELAYS_MS.length) {
        console.warn('[judged/db.harness] failed to stop Testcontainers container after retries:', error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, STOP_RETRY_DELAYS_MS[attempt]));
    }
  }
}

// Vitest gives each spec file its own module graph (see the comment on
// `testDbUrl` below), so this `afterAll` — registered once, at module load,
// against whichever file imported this harness — stops exactly the one
// container this file started, once every test in the file has finished
// (including failed ones; `afterAll` still runs). Without this, nothing
// ever stops the container Testcontainers starts, and Ryuk can't be relied
// on to reap orphans here: 99 containers accumulated with no Ryuk running
// when this leak was measured (Ryuk does work in this environment today
// and stays enabled as a second line of defense, but this teardown is the
// deterministic fix).
afterAll(async () => {
  if (!container) return;
  await stopWithRetry(container);
  container = undefined;
  url = undefined;
}, 30_000);

/**
 * This spec file's Postgres connection URL, for tests that need real
 * committed data across independent connections — `withTestDb`'s rollback
 * transaction cannot provide that. Vitest isolates by file, not by test: it
 * gives each db-using spec file its own module graph and therefore its own
 * container (a mid-run sample of `podman ps` during a full-suite run showed
 * four concurrent `postgres:16-alpine` containers), but nothing here is
 * shared *across* files. See the concurrent-claim tests in
 * `job-store.concurrency.spec.ts` for why the rollback-transaction
 * distinction still matters within one file.
 */
export async function testDbUrl(): Promise<string> {
  return ensureContainer();
}

/**
 * Runs `fn` against a migrated database inside a transaction that is always
 * rolled back, so every `it()` in this file reuses the one container Vitest
 * gave this file without leaking state between tests.
 */
export async function withTestDb(fn: (db: Db) => Promise<void>): Promise<void> {
  const connectionUrl = await ensureContainer();
  const { db, close } = createDb(connectionUrl);
  try {
    await db
      .transaction(async (tx) => {
        await fn(tx as unknown as Db);
        throw new RollbackSignal();
      })
      .catch((error: unknown) => {
        if (!(error instanceof RollbackSignal)) throw error;
      });
  } finally {
    await close();
  }
}

class RollbackSignal extends Error {}
