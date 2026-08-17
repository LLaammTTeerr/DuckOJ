import { existsSync } from 'node:fs';
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
