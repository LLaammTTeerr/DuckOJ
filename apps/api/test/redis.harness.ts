import { existsSync } from 'node:fs';
import { afterAll } from 'vitest';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';

// Testcontainers speaks the Docker API. This local sandbox has no Docker
// daemon but does have rootless Podman exposing a Docker-compatible socket.
// Point Testcontainers at it when Docker's own socket is absent, so tests
// work here without manual setup. On CI (which has /var/run/docker.sock)
// this block is a no-op.
//
// Duplicated from `db.harness.ts` rather than shared: this file has worked
// so far only because `db.harness`'s module body happens to run first and
// sets `process.env.DOCKER_HOST` as a side effect every spec in this suite
// inherits. A future spec that imports `app.harness` (and therefore this
// file, via `buildAppWithRealtime`) without ever importing `db.harness`
// would fail here for a reason that isn't visible from this file alone.
if (!process.env.DOCKER_HOST) {
  const podmanSocket = `/run/user/${process.getuid?.() ?? 1000}/podman/podman.sock`;
  if (!existsSync('/var/run/docker.sock') && existsSync(podmanSocket)) {
    process.env.DOCKER_HOST = `unix://${podmanSocket}`;
  }
}

// Mirrors `db.harness.ts`'s container-caching pattern: starting a container
// per test would make the realtime suite intolerably slow, and nothing in
// these tests needs isolation between them beyond what `withTestDb` already
// gives the database side — Redis pub/sub carries no state to leak between
// tests, only messages that are gone the instant nobody is subscribed.
let container: StartedRedisContainer | undefined;
let url: string | undefined;

export async function ensureRedisUrl(): Promise<string> {
  if (url) return url;
  container = await new RedisContainer('redis:7-alpine').start();
  url = container.getConnectionUrl();
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
        console.warn('[api/redis.harness] failed to stop Testcontainers container after retries:', error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, STOP_RETRY_DELAYS_MS[attempt]));
    }
  }
}

// Vitest gives each spec file its own module graph, so this `afterAll` —
// registered once, at module load, against whichever file imported this
// harness — stops exactly the one container this file started, once every
// test in the file has finished (including failed ones; `afterAll` still
// runs). Without this, nothing ever stops the container Testcontainers
// starts, and Ryuk can't be relied on to reap orphans here: 99 containers
// accumulated with no Ryuk running when this leak was measured (Ryuk does
// work in this environment today and stays enabled as a second line of
// defense, but this teardown is the deterministic fix).
afterAll(async () => {
  if (!container) return;
  await stopWithRetry(container);
  container = undefined;
  url = undefined;
}, 30_000);
