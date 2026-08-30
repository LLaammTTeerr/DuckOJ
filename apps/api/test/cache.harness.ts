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
import { ScoreboardCache, type ScoreboardCacheStore } from '../src/authz/scoreboard.cache.js';

const MISSES_EVERYTHING: ScoreboardCacheStore = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve(),
  del: () => Promise.resolve(),
};

export function bypassCache(): ScoreboardCache {
  return new ScoreboardCache(MISSES_EVERYTHING);
}
