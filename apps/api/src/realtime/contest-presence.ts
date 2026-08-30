/**
 * Who has a live page open, as the gateway's own registry knows it (D95).
 *
 * **The problem this solves.** `SubmissionsGateway` holds one `Actor` per
 * open socket — but only for *this* worker's sockets. `main.ts` forks
 * `API_WORKERS` of them, and a `GET /contests/{key}/monitor` served by worker
 * 3 must count the competitors connected to workers 0, 1 and 2 as well.
 * `ScoreboardCache`'s reasoning exactly (D25): the one thing every worker
 * shares is Redis.
 *
 * **One set for the whole deployment, not one per contest.** The gateway
 * cannot know which contest a socket belongs to — the participant's page
 * subscribes to a SUBMISSION (D23), and D31 ruled the contest page takes no
 * socket of its own — so it writes the only fact it actually has: this user
 * is connected. The monitor then intersects that set with
 * `contest_participations`, which is the half of the question the database
 * can answer. Marking presence per contest instead would need a contest the
 * gateway was never told.
 *
 * **A sorted set, scored by the instant of the last sighting**, so "seen in
 * the last five minutes" is one `ZRANGEBYSCORE` and expiry costs no timer:
 * a `ZREMRANGEBYSCORE` on every write trims what has aged out, which bounds
 * the key at "people connected in the last five minutes" rather than at
 * "people who have ever connected".
 *
 * **Nothing here may fail a caller.** A presence store that throws would take
 * down a WebSocket handshake on one side and the monitor on the other, to
 * report a number that is decoration beside the queue depth. Every method
 * swallows, exactly as `ScoreboardCache` does, and answers as if the set were
 * empty.
 */
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';

/**
 * How long a sighting counts for.
 *
 * Five minutes, and the gateway refreshes every connection on its 30-second
 * heartbeat sweep, so a socket that is genuinely open is re-scored ten times
 * inside its own window. What the width actually buys is the other
 * direction: a laptop lid closed for two minutes, or a phone that dropped to
 * 3G and reconnected, is still "in the room" — which is the honest answer,
 * and a one-minute window would report the room emptying every time a
 * classroom's wifi hiccuped.
 */
export const PRESENCE_WINDOW_MS = 5 * 60_000;

export const CONTEST_PRESENCE = Symbol('CONTEST_PRESENCE');

export interface ContestPresence {
  /** Records that these users hold a live socket, as of now. Never rejects. */
  seen(userIds: readonly number[]): Promise<void>;
  /** Users seen inside {@link PRESENCE_WINDOW_MS}. Empty on any failure. */
  recent(): Promise<number[]>;
}

const KEY = 'duckoj:ws:presence:v1';

/**
 * The production store. Mirrors `RedisHealthProbe` and
 * `RedisSubmissionPublisher` deliberately, down to their reasoning: a lazily
 * opened connection (so every spec that never opens a socket dials nothing),
 * no offline queue, an `error` listener attached with the connection, and
 * `disconnect()` rather than `quit()` on shutdown.
 */
@Injectable()
export class RedisContestPresence implements ContestPresence, OnModuleDestroy {
  private readonly logger = new Logger(RedisContestPresence.name);
  private redis: Redis | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'redisUrl'>) {}

  async seen(userIds: readonly number[]): Promise<void> {
    if (userIds.length === 0) return;
    const now = Date.now();
    try {
      // One round trip for the three commands. The trim rides along with
      // every write rather than on a timer: a deployment whose gateway is
      // idle writes nothing and therefore needs no trim, and one that is
      // busy trims constantly, which is the shape a bounded key wants.
      await this.connection()
        .multi()
        .zadd(KEY, ...userIds.flatMap((id) => [now, String(id)] as [number, string]))
        .zremrangebyscore(KEY, '-inf', `(${String(now - PRESENCE_WINDOW_MS)}`)
        // An expiry as well as the trim: if every API worker dies, the key
        // must not outlive the connections it describes forever.
        .pexpire(KEY, PRESENCE_WINDOW_MS * 2)
        .exec();
    } catch (error) {
      this.report(error);
    }
  }

  async recent(): Promise<number[]> {
    try {
      const members = await this.connection().zrangebyscore(
        KEY,
        Date.now() - PRESENCE_WINDOW_MS,
        '+inf',
      );
      // A member that is not a positive integer cannot be a user id, and
      // handing one to a `= any($1::bigint[])` would make a decorative number
      // able to 500 the monitor.
      return members.map((raw) => Number(raw)).filter((id) => Number.isInteger(id) && id > 0);
    } catch (error) {
      this.report(error);
      return [];
    }
  }

  private report(error: unknown): void {
    // Debug, not warn, for `RedisHealthProbe`'s reason: this runs on every
    // handshake and every heartbeat sweep, so a Redis that is legitimately
    // down must not become a log flood.
    this.logger.debug(
      `presence store unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  private connection(): Redis {
    if (this.redis) return this.redis;
    const redis = new Redis(this.config.redisUrl, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    redis.on('error', () => undefined);
    this.redis = redis;
    return redis;
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
    this.redis = null;
  }
}
