/**
 * A `ScoreboardCache` that caches nothing — what the specs which construct
 * `ContestAccessService` or `RejudgeService` by hand pass in.
 *
 * This is not a stub of the cache: it is the cache, wired to a store that
 * behaves exactly as `RedisScoreboardCacheStore` does with no Redis to talk
 * to (D25's documented bypass). Every one of those specs is about what the
 * fold computes, and a real 2 s entry between two of their assertions would
 * make them measure the cache instead. `scoreboard-cache.spec.ts` covers the
 * caching itself, and `contest-scoreboard-cache.spec.ts` covers it over HTTP
 * with a real Redis.
 */
import { ScoreboardCache, type ScoreboardCacheStore } from '../src/authz/scoreboard.cache.js';

const NOTHING: ScoreboardCacheStore = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve(),
  del: () => Promise.resolve(),
};

export function uncachedScoreboards(): ScoreboardCache {
  return new ScoreboardCache(NOTHING);
}
