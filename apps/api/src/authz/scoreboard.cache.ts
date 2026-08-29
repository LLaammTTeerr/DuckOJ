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
import type { Scoreboard } from '@duckoj/contest-formats';
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

@Injectable()
export class ScoreboardCache {
  /**
   * Per worker, per key: the fold currently running. Not shared through
   * Redis, deliberately — a distributed lock would add a round trip and a
   * lease to every read to save at most `API_WORKERS − 1` folds per TTL.
   */
  private readonly inFlight = new Map<string, Promise<Scoreboard>>();

  constructor(@Inject(SCOREBOARD_CACHE_STORE) private readonly store: ScoreboardCacheStore) {}

  /**
   * The board for `key`, from the store if it is there and fresh, otherwise
   * folded exactly once per key per worker.
   *
   * `cache` says where the *body* came from. A coalesced waiter reports
   * `miss`: it did not read the store, it waited on a fold.
   */
  async through(
    key: string,
    compute: () => Promise<Scoreboard>,
  ): Promise<{ board: Scoreboard; cache: ScoreboardCacheState }> {
    const cached = await this.store.get(key).catch(() => null);
    if (cached !== null) {
      const parsed = parse(cached);
      if (parsed) return { board: parsed, cache: 'hit' };
      // An entry this process cannot read is an entry that does not exist.
      // Answering 500 because a cache holds garbage would make the cache the
      // most dangerous component in the request path.
    }

    const pending = this.inFlight.get(key);
    if (pending) return { board: await pending, cache: 'miss' };

    // The write is inside the shared promise so a coalesced waiter cannot
    // return before the entry exists — and a fold that THREW never writes,
    // which is what keeps a 409 out of the cache.
    const fold = compute().then(async (board) => {
      await this.store
        .set(key, JSON.stringify(board), SCOREBOARD_CACHE_TTL_MS)
        .catch(() => undefined);
      return board;
    });
    this.inFlight.set(key, fold);
    try {
      return { board: await fold, cache: 'miss' };
    } finally {
      this.inFlight.delete(key);
    }
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

function parse(value: string): Scoreboard | null {
  try {
    return JSON.parse(value) as Scoreboard;
  } catch {
    return null;
  }
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
  private redis: Redis | null = null;
  /** One line per outage, not one per request: this is on the hot path. */
  private reportedDown = false;

  constructor(@Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'redisUrl'>) {}

  async get(key: string): Promise<string | null> {
    try {
      const value = await this.connection().get(key);
      this.reportedDown = false;
      return value;
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
      this.reportedDown = false;
    } catch (error) {
      this.reportDown(error);
    }
  }

  async del(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.connection().del(...keys);
      this.reportedDown = false;
    } catch (error) {
      this.reportDown(error);
    }
  }

  private reportDown(error: unknown): void {
    if (this.reportedDown) return;
    this.reportedDown = true;
    this.logger.warn(
      'scoreboard cache unavailable, folding every board until Redis returns: ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  private connection(): Redis {
    if (this.redis) return this.redis;
    const redis = new Redis(this.config.redisUrl, {
      // A cache command that cannot be sent must fail NOW. Queued offline it
      // would turn a Redis outage into a latency outage on the one endpoint
      // this whole change exists to make fast.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    // ioredis re-raises 'error' on the process when nothing listens; the
    // reporting that matters happens at the call sites above, once per
    // outage, so this listener exists only to keep the process alive.
    redis.on('error', () => undefined);
    this.redis = redis;
    return redis;
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
    this.redis = null;
  }
}
