/**
 * A `ScoreboardCache` that caches nothing.
 *
 * `ProblemAccessService` takes the cache as its third constructor argument
 * (D49's statistics read through it), and every spec that builds the service
 * by hand wants the uncached answer: an entry surviving between two
 * assertions in one test would make the second one read the first one's
 * database. This is the same bypass the whole suite already runs on over
 * HTTP — `TEST_CONFIG.redisUrl` points at an unreachable port, and a store
 * that cannot answer is a store that misses.
 */
import { Redis } from 'ioredis';
import {
  RedisScoreboardCacheStore,
  ScoreboardCache,
  type CacheRedis,
  type ScoreboardCacheStore,
} from '../src/authz/scoreboard.cache.js';

const MISSES_EVERYTHING: ScoreboardCacheStore = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve(),
  del: () => Promise.resolve(),
};

export function bypassCache(): ScoreboardCache {
  return new ScoreboardCache(MISSES_EVERYTHING);
}

/**
 * The production cache store, against a real Redis, with every entry's
 * expiry raised to a floor a test can rely on.
 *
 * **Why this exists (B-35).** `SCOREBOARD_CACHE_TTL_MS` is **2 s** — right
 * for a live board and deliberately short. Three specs assert the shape
 * "read twice, the second is a `hit`", which is only true if the two HTTP
 * round trips fit inside the TTL. They do, comfortably, when the suite runs
 * alone. Under `pnpm -r test` — twenty packages at once, `apps/api` alone
 * folding 134 spec files through a hundred and thirty Postgres containers —
 * two seconds of wall clock can pass inside one request, the entry expires
 * between the write and the read, and the assertion reads `miss`. Measured:
 * `contest-scoreboard-cache` and `contest-booklet` (60 s TTL, same shape)
 * each went red once in seven whole-workspace runs, and never in six runs of
 * `apps/api` alone.
 *
 * That is NOT the D149 defect and no timeout fixes it: the case did not run
 * out of time, the DATA did. The stable mechanism is to stop asserting
 * against the wall clock — the TTL's own value is pinned by
 * `scoreboard.cache`'s unit tests, and these specs are about keying,
 * coalescing and invalidation, none of which the floor touches.
 *
 * It is the real `RedisScoreboardCacheStore` — same class, same `get`, same
 * `set … PX`, same `del`, so invalidation is still proved against a real
 * server — built through the `connect` seam its constructor already offers
 * the flapping-connection tests. Only the expiry argument is raised, and
 * only upwards: a spec that deliberately asks for a LONGER life keeps it.
 */
export function longLivedCacheStore(url: string, floorMs = 10 * 60_000): ScoreboardCacheStore {
  const connect = (target: string): CacheRedis => {
    const redis = new Redis(target, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    redis.on('error', () => undefined);
    return {
      get: (key) => redis.get(key),
      set: (key, value, mode, ttlMs) => redis.set(key, value, mode, Math.max(ttlMs, floorMs)),
      del: (...keys) => redis.del(...keys),
      disconnect: () => {
        redis.disconnect();
      },
    };
  };
  return new RedisScoreboardCacheStore({ redisUrl: url }, connect);
}
