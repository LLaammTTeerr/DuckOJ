import { existsSync } from 'node:fs';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrations, type Db } from '@qhhoj/db';

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
