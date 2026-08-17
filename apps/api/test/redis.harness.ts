import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';

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
