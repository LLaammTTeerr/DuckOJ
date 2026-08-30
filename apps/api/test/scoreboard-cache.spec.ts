/**
 * The scoreboard cache (D25): key derivation, in-flight coalescing, and what
 * happens when Redis is not there.
 *
 * The key derivation tests are the load-bearing ones. `getScoreboard` folds
 * the board against an injected `now` (D22), and `now` enters the fold in
 * exactly one place: `isFrozenAt` per participation. That makes the board
 * piecewise-constant in `now`, changing only at a participation's own freeze
 * instant and its own end — so a cache key that did not move at those two
 * instants would serve a frozen board after the thaw, which is the one
 * failure a scoreboard cache must not have.
 */
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Scoreboard } from '@duckoj/contest-formats';
import {
  RedisScoreboardCacheStore,
  SCOREBOARD_CACHE_TTL_MS,
  ScoreboardCache,
  scoreboardCacheKey,
  scoreboardCacheKeys,
  type ScoreboardCacheStore,
} from '../src/authz/scoreboard.cache.js';

const END = Date.parse('2026-03-01T14:00:00Z');
const MINUTE = 60_000;

/** A contest that freezes for its last 30 minutes. */
const FROZEN = { id: 7, endTime: new Date(END), frozenLastMinutes: 30 };
/** The same contest with no freeze window at all. */
const LIVE = { id: 7, endTime: new Date(END), frozenLastMinutes: 0 };

const FREEZE_AT = END - 30 * MINUTE;

/** Small enough to compare by identity; the cache never inspects the board. */
function board(name: string): Scoreboard {
  return { tag: name } as unknown as Scoreboard;
}

describe('scoreboardCacheKey', () => {
  it('separates the privileged view from the public one', () => {
    const now = new Date(END - MINUTE);
    expect(scoreboardCacheKey(FROZEN, true, now)).not.toBe(
      scoreboardCacheKey(FROZEN, false, now),
    );
  });

  it('gives the privileged view one key whatever the clock says', () => {
    // The privileged board is folded with no `now` at all (D22), so its
    // content cannot depend on the clock — one key, or the cache would hold
    // three identical copies and miss twice as often.
    const keys = new Set(
      [END - 10 * MINUTE, FREEZE_AT, END - MINUTE, END, END + MINUTE].map((ms) =>
        scoreboardCacheKey(FROZEN, true, new Date(ms)),
      ),
    );
    expect(keys.size).toBe(1);
  });

  it('gives an unfrozen contest one public key whatever the clock says', () => {
    const keys = new Set(
      [END - 10 * MINUTE, END, END + MINUTE].map((ms) =>
        scoreboardCacheKey(LIVE, false, new Date(ms)),
      ),
    );
    expect(keys.size).toBe(1);
  });

  it('moves the public key across the freeze instant and again at the end', () => {
    const before = scoreboardCacheKey(FROZEN, false, new Date(FREEZE_AT - 1));
    const during = scoreboardCacheKey(FROZEN, false, new Date(FREEZE_AT));
    const after = scoreboardCacheKey(FROZEN, false, new Date(END));
    expect(new Set([before, during, after]).size).toBe(3);
  });

  it('agrees with isFrozenAt at both boundaries: closed at the freeze, open at the end', () => {
    // `isFrozenAt` is `now >= freeze && now < end`. A key derived with the
    // boundaries the other way round would disagree with the fold for one
    // millisecond in each direction — long enough, at 2s of TTL, to publish a
    // frozen board after the thaw.
    const during = scoreboardCacheKey(FROZEN, false, new Date(FREEZE_AT));
    expect(scoreboardCacheKey(FROZEN, false, new Date(END - 1))).toBe(during);
    expect(scoreboardCacheKey(FROZEN, false, new Date(FREEZE_AT - 1))).not.toBe(during);
    expect(scoreboardCacheKey(FROZEN, false, new Date(END))).not.toBe(during);
  });

  it('names the freeze boundary in the key itself', () => {
    expect(scoreboardCacheKey(FROZEN, false, new Date(FREEZE_AT))).toContain(String(FREEZE_AT));
    expect(scoreboardCacheKey(FROZEN, false, new Date(END))).toContain(String(END));
  });

  it('keys two contests apart', () => {
    const now = new Date(END - MINUTE);
    expect(scoreboardCacheKey({ ...FROZEN, id: 8 }, false, now)).not.toBe(
      scoreboardCacheKey(FROZEN, false, now),
    );
  });
});

describe('scoreboardCacheKeys', () => {
  it('enumerates every key the derivation can produce for a frozen contest', () => {
    const enumerated = new Set(scoreboardCacheKeys(FROZEN));
    for (const ms of [FREEZE_AT - 1, FREEZE_AT, END - 1, END, END + MINUTE]) {
      for (const privileged of [true, false]) {
        expect(enumerated).toContain(scoreboardCacheKey(FROZEN, privileged, new Date(ms)));
      }
    }
  });

  it('enumerates every key the derivation can produce for an unfrozen contest', () => {
    const enumerated = new Set(scoreboardCacheKeys(LIVE));
    for (const ms of [END - MINUTE, END, END + MINUTE]) {
      for (const privileged of [true, false]) {
        expect(enumerated).toContain(scoreboardCacheKey(LIVE, privileged, new Date(ms)));
      }
    }
  });

  it('names only this contest', () => {
    for (const key of scoreboardCacheKeys(FROZEN)) expect(key).toContain(':7:');
    expect(scoreboardCacheKeys({ ...FROZEN, id: 8 })).not.toContain(scoreboardCacheKeys(FROZEN)[0]);
  });
});

/** A store that answers from a Map, counting what it was asked to do. */
function fakeStore(): ScoreboardCacheStore & {
  entries: Map<string, string>;
  ttls: number[];
  gets: string[];
  deleted: string[];
} {
  const entries = new Map<string, string>();
  const ttls: number[] = [];
  const gets: string[] = [];
  const deleted: string[] = [];
  return {
    entries,
    ttls,
    gets,
    deleted,
    get: (key) => {
      gets.push(key);
      return Promise.resolve(entries.get(key) ?? null);
    },
    set: (key, value, ttlMs) => {
      entries.set(key, value);
      ttls.push(ttlMs);
      return Promise.resolve();
    },
    del: (keys) => {
      deleted.push(...keys);
      for (const key of keys) entries.delete(key);
      return Promise.resolve();
    },
  };
}

/** A store whose every command rejects — Redis down, or not there at all. */
const deadStore: ScoreboardCacheStore = {
  get: () => Promise.reject(new Error('ECONNREFUSED')),
  set: () => Promise.reject(new Error('ECONNREFUSED')),
  del: () => Promise.reject(new Error('ECONNREFUSED')),
};

describe('ScoreboardCache', () => {
  it('folds once and serves the second read from the store', async () => {
    const store = fakeStore();
    const cache = new ScoreboardCache(store);
    const compute = vi.fn(() => Promise.resolve(board('a')));

    const first = await cache.through('k', compute);
    const second = await cache.through('k', compute);

    expect(first.cache).toBe('miss');
    expect(second.cache).toBe('hit');
    expect(second.value).toEqual(first.value);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('writes the entry with the 2s TTL', async () => {
    const store = fakeStore();
    await new ScoreboardCache(store).through('k', () => Promise.resolve(board('a')));
    expect(SCOREBOARD_CACHE_TTL_MS).toBe(2_000);
    expect(store.ttls).toEqual([SCOREBOARD_CACHE_TTL_MS]);
  });

  it('coalesces concurrent folds of the same key into one', async () => {
    const store = fakeStore();
    const cache = new ScoreboardCache(store);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const compute = vi.fn(async () => {
      await gate;
      return board('a');
    });

    const all = Promise.all([
      cache.through('k', compute),
      cache.through('k', compute),
      cache.through('k', compute),
    ]);
    release();
    const results = await all;

    expect(compute).toHaveBeenCalledTimes(1);
    // Nobody read this board out of the store, so nobody reports a hit: the
    // header describes where the body came from, and a coalesced waiter
    // waited on a fold.
    expect(results.map((result) => result.cache)).toEqual(['miss', 'miss', 'miss']);
    for (const result of results) expect(result.value).toEqual(board('a'));
  });

  it('does not coalesce across different keys', async () => {
    const cache = new ScoreboardCache(fakeStore());
    const compute = vi.fn(() => Promise.resolve(board('a')));
    await Promise.all([cache.through('one', compute), cache.through('two', compute)]);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('releases the in-flight slot once the fold settles', async () => {
    // Without the release a key would be folded exactly once per process and
    // then served from a promise that never expires — a permanent cache with
    // no TTL, which is the opposite of what this is.
    const store = fakeStore();
    const cache = new ScoreboardCache(store);
    const compute = vi.fn(() => Promise.resolve(board('a')));
    await cache.through('k', compute);
    store.entries.clear();
    await cache.through('k', compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('fails every coalesced caller together, and poisons nothing', async () => {
    const cache = new ScoreboardCache(fakeStore());
    const boom = vi.fn(() => Promise.reject(new Error('409')));
    const results = await Promise.allSettled([cache.through('k', boom), cache.through('k', boom)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(boom).toHaveBeenCalledTimes(1);
    // The failed key is not stuck: the next caller folds again.
    const ok = await cache.through('k', () => Promise.resolve(board('a')));
    expect(ok.cache).toBe('miss');
  });

  it('never caches a failed fold', async () => {
    const store = fakeStore();
    const cache = new ScoreboardCache(store);
    await expect(cache.through('k', () => Promise.reject(new Error('409')))).rejects.toThrow();
    expect(store.entries.size).toBe(0);
  });

  it('falls back to the fold when the store is dead, and still coalesces', async () => {
    const cache = new ScoreboardCache(deadStore);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const compute = vi.fn(async () => {
      await gate;
      return board('a');
    });

    const all = Promise.all([cache.through('k', compute), cache.through('k', compute)]);
    release();
    const results = await all;

    expect(compute).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.cache)).toEqual(['miss', 'miss']);
    // And again, since nothing was ever stored: every read is a fold.
    await cache.through('k', compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('treats an unparseable entry as a miss rather than a 500', async () => {
    const store = fakeStore();
    const cache = new ScoreboardCache(store);
    store.entries.set('k', 'not json');
    const result = await cache.through('k', () => Promise.resolve(board('a')));
    expect(result.cache).toBe('miss');
    expect(result.value).toEqual(board('a'));
  });

  it('deletes exactly the keys it is handed, and survives a dead store', async () => {
    const store = fakeStore();
    const cache = new ScoreboardCache(store);
    await cache.through('k', () => Promise.resolve(board('a')));
    await cache.invalidate(['k', 'other']);
    expect(store.deleted).toEqual(['k', 'other']);
    expect((await cache.through('k', () => Promise.resolve(board('b')))).cache).toBe('miss');
    await expect(new ScoreboardCache(deadStore).invalidate(['k'])).resolves.toBeUndefined();
  });

  it('issues no command for an empty key list', async () => {
    const store = fakeStore();
    await new ScoreboardCache(store).invalidate([]);
    expect(store.deleted).toEqual([]);
  });
});

describe('RedisScoreboardCacheStore, with no Redis to talk to', () => {
  const stores: RedisScoreboardCacheStore[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) store.onModuleDestroy();
    vi.restoreAllMocks();
  });

  function unreachable(): RedisScoreboardCacheStore {
    // Port 1 is the same deliberately-unreachable address `TEST_CONFIG` uses:
    // with `enableOfflineQueue: false` every command must reject at once
    // rather than sit in a queue waiting for a Redis that is not coming.
    const store = new RedisScoreboardCacheStore({ redisUrl: 'redis://127.0.0.1:1' });
    stores.push(store);
    return store;
  }

  it('answers null, swallows writes, and logs the outage exactly once', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const store = unreachable();

    await expect(store.get('k')).resolves.toBeNull();
    await expect(store.set('k', 'v', 2_000)).resolves.toBeUndefined();
    await expect(store.del(['k'])).resolves.toBeUndefined();
    await expect(store.get('k')).resolves.toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('scoreboard cache');
  });

  it('returns promptly rather than waiting on a connection that will not come', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const store = unreachable();
    const started = Date.now();
    await store.get('k');
    // The whole point of `enableOfflineQueue: false`: a bypass must cost
    // nothing measurable, or a Redis outage becomes a latency outage.
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
