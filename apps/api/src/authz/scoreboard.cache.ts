/**
 * The scoreboard cache — D25.
 *
 * `ContestAccessService.getScoreboard` loads every participation and every
 * submission in the contest and folds the board in JavaScript on every
 * request. That is the right thing to do once and the wrong thing to do two
 * hundred times a second: P7 measured it at a 3.57 s p95 under 2000 VUs while
 * the response itself was 520 bytes (`load/RESULTS.md`).
 *
 * **Why this is safe, and where the safety comes from.** The fold takes a
 * clock (D22), and the clock reaches it in exactly one place: `isFrozenAt`,
 * per participation. So the board is *piecewise constant* in `now`, with
 * breakpoints only at a participation's own freeze instant and its own end.
 * The cache key therefore carries which of those intervals `now` fell in, and
 * the entry lives 2 s — long enough to collapse a read storm, short enough
 * that nothing anyone is watching is visibly behind.
 *
 * Two boundaries are named in the key: the *contest's* freeze instant and its
 * end. A virtual or time-limited participation has its own, shifted, pair
 * (D22 again) which the key cannot see without loading the participations —
 * which is the expensive thing this exists to avoid. Those ride the TTL: such
 * a board thaws at most 2 s late. That is the whole of the staleness this
 * design admits by construction.
 *
 * Redis-backed rather than in-process because `main.ts` forks `API_WORKERS`
 * workers: an in-process map would be four caches with four independent miss
 * rates. Coalescing IS in-process — it is about not folding the same board
 * twice inside one worker at one instant, which needs no coordination.
 */
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { freezeAtMs, isFrozenAt } from '@duckoj/contest-formats';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';

/** Where the response header's value comes from. Never appears in a body. */
export type ScoreboardCacheState = 'hit' | 'miss';

/**
 * Two seconds. Short enough that a spectator refreshing during a contest
 * cannot tell, long enough that 2000 VUs hitting one contest collapse into
 * one fold every two seconds per key.
 */
export const SCOREBOARD_CACHE_TTL_MS = 2_000;

/** Everything key derivation needs from a `contests` row. */
export interface ScoreboardCacheContest {
  id: number;
  endTime: Date;
  frozenLastMinutes: number;
}

const PREFIX = 'duckoj:sb:v1';

/**
 * The key for one board.
 *
 * The privileged view is folded with no clock at all, so it gets one key
 * whatever the time is. The public view gets the instant its current phase
 * *began*: `0` before the freeze (or when there is no freeze window), the
 * freeze instant while frozen, the end instant once thawed.
 *
 * The two comparisons come from `window.ts` rather than being rewritten here.
 * The freeze window is closed at the freeze and open at the end, and a key
 * that disagreed with the fold by one millisecond at either boundary would
 * publish a frozen board after the thaw for a whole TTL. D22 and D23 each
 * record a bug from a second derivation of this predicate; this is not the
 * third.
 */
export function scoreboardCacheKey(
  contest: ScoreboardCacheContest,
  privileged: boolean,
  now: Date,
): string {
  if (privileged) return `${PREFIX}:${String(contest.id)}:priv`;
  return `${PREFIX}:${String(contest.id)}:pub:${String(publicBucket(contest, now))}`;
}

/**
 * Every key `scoreboardCacheKey` can ever produce for this contest — what a
 * write deletes.
 *
 * Enumerable, and small, because the only thing that varies is which of at
 * most three phases `now` is in. That is why invalidation is an exact `DEL`
 * of a computed list rather than a `SCAN` over a prefix or a generation
 * counter costing a round trip on every read.
 */
export function scoreboardCacheKeys(contest: ScoreboardCacheContest): string[] {
  const base = `${PREFIX}:${String(contest.id)}`;
  const keys = [`${base}:priv`, `${base}:pub:0`];
  const freezeMs = freezeAtMs(contest.endTime.getTime(), contest.frozenLastMinutes);
  if (freezeMs !== null) {
    keys.push(`${base}:pub:${String(freezeMs)}`, `${base}:pub:${String(contest.endTime.getTime())}`);
  }
  return keys;
}

function publicBucket(contest: ScoreboardCacheContest, now: Date): number {
  const endMs = contest.endTime.getTime();
  const freezeMs = freezeAtMs(endMs, contest.frozenLastMinutes);
  if (freezeMs === null) return 0;
  if (isFrozenAt(now.getTime(), freezeMs, endMs)) return freezeMs;
  return now.getTime() >= endMs ? endMs : 0;
}

/**
 * The store, behind an interface so the cache can be tested without a Redis
 * and so a future backend is a provider swap. A method **should** not reject
 * — `RedisScoreboardCacheStore` reports an outage and answers as if the key
 * were absent — but `ScoreboardCache` swallows a rejection anyway. A cache is
 * an optimisation, and an optimisation that can fail a request is a new way
 * to have an outage; that guarantee is worth holding structurally rather than
 * by convention across every store anyone writes later.
 */
export interface ScoreboardCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  del(keys: string[]): Promise<void>;
}

export const SCOREBOARD_CACHE_STORE = Symbol('SCOREBOARD_CACHE_STORE');

/**
 * Named for the board it was built for (D25) and generic since D48: the
 * contest booklet and the problem statistics are the same read-through
 * shape — an expensive computation, a key that changes when the answer
 * does, a short TTL — and a second copy of the coalescing, the
 * swallow-every-store-failure rule and the never-cache-a-throw rule is
 * exactly how two of the three quietly stop holding. `ttlMs` is per call,
 * because 2 s is right for a live board and wrong for a PDF.
 */
@Injectable()
export class ScoreboardCache {
  /**
   * Per worker, per key: the fold currently running. Not shared through
   * Redis, deliberately — a distributed lock would add a round trip and a
   * lease to every read to save at most `API_WORKERS − 1` folds per TTL.
   */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(@Inject(SCOREBOARD_CACHE_STORE) private readonly store: ScoreboardCacheStore) {}

  /**
   * The board for `key`, from the store if it is there and fresh, otherwise
   * folded exactly once per key per worker.
   *
   * `cache` says where the *body* came from. A coalesced waiter reports
   * `miss`: it did not read the store, it waited on a fold.
   */
  async through<T>(
    key: string,
    compute: () => Promise<T>,
    ttlMs: number = SCOREBOARD_CACHE_TTL_MS,
  ): Promise<{ value: T; cache: ScoreboardCacheState }> {
    const cached = await this.store.get(key).catch(() => null);
    if (cached !== null) {
      const parsed = parse<T>(cached);
      if (parsed !== null) return { value: parsed, cache: 'hit' };
      // An entry this process cannot read is an entry that does not exist.
      // Answering 500 because a cache holds garbage would make the cache the
      // most dangerous component in the request path.
    }

    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) return { value: await pending, cache: 'miss' };

    // The write is inside the shared promise so a coalesced waiter cannot
    // return before the entry exists — and a fold that THREW never writes,
    // which is what keeps a 409 out of the cache.
    const fold = compute().then(async (value) => {
      await this.store.set(key, JSON.stringify(value), ttlMs).catch(() => undefined);
      return value;
    });
    this.inFlight.set(key, fold);
    try {
      return { value: await fold, cache: 'miss' };
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * The read-through shape for a PAGE of things: many keys, but at most ONE
   * call to `compute`, for whatever missed.
   *
   * `through` in a loop would be the obvious way to cache a page and is the
   * wrong one: it turns a single grouped aggregate into one round trip per
   * row, which is the N+1 the catalogue endpoints are explicitly built to
   * avoid (`problem-me-verdict.spec.ts` pins the statement count as
   * INDEPENDENT of page size, and it catches exactly that mistake). So the
   * misses are gathered first and computed together, and the statement count
   * goes from D49's one-per-page to **one on a cold page and none on a warm
   * one** — strictly better than the uncached version it replaces, never
   * worse.
   *
   * `compute` is handed only the ids it must answer for, and may return
   * fewer than it was asked about; an id it omits is simply absent from the
   * result and is not cached, so "no such row" stays the caller's decision.
   *
   * No coalescing map here, unlike `through`. Two workers racing a cold page
   * duplicate one aggregate, which is the same duplication `through` allows
   * ACROSS workers anyway, and keying the in-flight map by an id SET would
   * miss almost always — the very objection that makes the per-id key right
   * in the first place.
   */
  async throughMany<T>(
    ids: readonly number[],
    keyFor: (id: number) => string,
    compute: (missing: number[]) => Promise<Map<number, T>>,
    ttlMs: number,
  ): Promise<Map<number, T>> {
    const found = new Map<number, T>();
    if (ids.length === 0) return found;

    const missing: number[] = [];
    await Promise.all(
      ids.map(async (id) => {
        const cached = await this.store.get(keyFor(id)).catch(() => null);
        const parsed = cached === null ? null : parse<T>(cached);
        // An entry this process cannot read is an entry that does not exist —
        // `through`'s rule, for `through`'s reason.
        if (parsed === null) missing.push(id);
        else found.set(id, parsed);
      }),
    );
    if (missing.length === 0) return found;

    // A throw here propagates and nothing is written, so a failed aggregate
    // is never cached — again `through`'s rule.
    const computed = await compute(missing);
    await Promise.all(
      [...computed].map(async ([id, value]) => {
        found.set(id, value);
        await this.store.set(keyFor(id), JSON.stringify(value), ttlMs).catch(() => undefined);
      }),
    );
    return found;
  }

  /**
   * Drop these keys. Best-effort, like everything else here: if the delete
   * does not land, the 2 s TTL is the floor and the board is right again a
   * moment later.
   *
   * A fold already in flight when a write commits can still store the
   * pre-write board afterwards, for one TTL. Closing that needs a
   * cross-worker epoch read on every request, which costs more than the two
   * seconds it buys.
   */
  async invalidate(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.store.del(keys).catch(() => undefined);
  }
}

function parse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/**
 * At most one line a minute out of a store whose Redis is misbehaving.
 *
 * The bound is on TIME, not on "the outage", and the distinction is the whole
 * point. The first version of this was a boolean set on the first failure and
 * cleared by the next success — one line per outage, which is right for a
 * Redis that is either up or down. B12 measured the shape that actually
 * happens: transient `Stream isn't writeable` drop-outs under load, one failed
 * command between successful ones. Every failure there follows a success, so
 * the boolean was clear every time and the "one line per outage" rule produced
 * one line per failed request — on the hot path, in the middle of the load
 * that caused it, which is exactly when the log is least affordable and least
 * informative.
 *
 * A minute rather than "once, ever": an outage that lasts an hour should leave
 * sixty lines saying so, not one at the start that has scrolled away by the
 * time anyone looks.
 */
export const OUTAGE_LOG_INTERVAL_MS = 60_000;

/**
 * The subset of `ioredis` this store uses, named so a test can supply a
 * connection that fails on demand.
 *
 * Not for mocking convenience: a flapping connection is a state a real Redis
 * on a real port cannot be asked to enter, and the alternative — asserting the
 * throttle only against a Redis that is uniformly down — cannot see the bug at
 * all, because a store that never succeeds never re-arms.
 */
export interface CacheRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  disconnect(): void;
}

/**
 * The production store. Mirrors `RedisSubmissionPublisher` deliberately, down
 * to the comments' reasoning: lazy connection, no offline queue, an `error`
 * listener attached with the connection, and `disconnect()` rather than
 * `quit()` on shutdown.
 *
 * The lazy connection is what keeps the existing test suite untouched:
 * `TEST_CONFIG.redisUrl` points at a deliberately unreachable port, so every
 * spec that is not about this cache runs with the cache bypassed — which is
 * the fallback path, exercised a thousand times over.
 */
@Injectable()
export class RedisScoreboardCacheStore implements ScoreboardCacheStore, OnModuleDestroy {
  private readonly logger = new Logger(RedisScoreboardCacheStore.name);
  private redis: CacheRedis | null = null;
  /** When the outage line was last written. `null` until the first failure. */
  private reportedAt: number | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'redisUrl'>,
    /** How a connection is opened. Injected only by the flapping-connection tests. */
    private readonly connect: (url: string) => CacheRedis = openRedis,
    /** The throttle's clock. Injected only so a test can cross a minute in no time. */
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string): Promise<string | null> {
    try {
      return await this.connection().get(key);
    } catch (error) {
      this.reportDown(error);
      return null;
    }
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    try {
      // `PX` in the same command as the write: a SET followed by a separate
      // PEXPIRE can leave an entry with no expiry at all if the connection
      // drops between the two, and a scoreboard cached forever is worse than
      // no cache.
      await this.connection().set(key, value, 'PX', ttlMs);
    } catch (error) {
      this.reportDown(error);
    }
  }

  async del(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.connection().del(...keys);
    } catch (error) {
      this.reportDown(error);
    }
  }

  /**
   * Writes the outage line, at most once per {@link OUTAGE_LOG_INTERVAL_MS}.
   *
   * A success deliberately does NOT re-arm this — see the constant's comment.
   */
  private reportDown(error: unknown): void {
    const at = this.now();
    if (this.reportedAt !== null && at - this.reportedAt < OUTAGE_LOG_INTERVAL_MS) return;
    this.reportedAt = at;
    this.logger.warn(
      'scoreboard cache unavailable, folding every board until Redis returns: ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  private connection(): CacheRedis {
    if (this.redis) return this.redis;
    this.redis = this.connect(this.config.redisUrl);
    return this.redis;
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
    this.redis = null;
  }
}

/** The real connection, with the options this store depends on. */
function openRedis(url: string): CacheRedis {
  const redis = new Redis(url, {
    // A cache command that cannot be sent must fail NOW. Queued offline it
    // would turn a Redis outage into a latency outage on the one endpoint
    // this whole change exists to make fast.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  // ioredis re-raises 'error' on the process when nothing listens; the
  // reporting that matters happens at the call sites above, throttled, so
  // this listener exists only to keep the process alive.
  redis.on('error', () => undefined);
  return redis;
}
