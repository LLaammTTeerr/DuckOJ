/**
 * The API's own end of the realtime `submissions` channel.
 *
 * Until now only `judged` ever published on `SUBMISSION_CHANNEL` — the API
 * was purely a subscriber (`RedisSubscriber`), because every state change a
 * client cares about was written by a judge. Rejudging breaks that: the API
 * itself resets a submission to `queued`, and an open page must see it
 * without polling.
 *
 * Publishing rather than calling `SubmissionsGateway.notify` directly: the
 * gateway only holds the sockets of *this* API instance, and the whole point
 * of routing wake-ups through Redis is that every instance's subscriber
 * forwards to its own clients. A direct call would work in a single-process
 * deployment and silently drop half the notifications in any other.
 */
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { SUBMISSION_CHANNEL } from '@duckoj/realtime';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';

export const SUBMISSION_PUBLISHER = Symbol('SUBMISSION_PUBLISHER');

export interface SubmissionPublisher {
  /**
   * Best-effort: a realtime wake-up that never arrives costs a client one
   * refresh, so an implementation must never make its caller fail.
   */
  publish(submissionId: number): Promise<void>;
}

@Injectable()
export class RedisSubmissionPublisher implements SubmissionPublisher, OnModuleDestroy {
  private readonly logger = new Logger(RedisSubmissionPublisher.name);
  /**
   * Created on the FIRST publish, not in the constructor.
   *
   * This provider is reachable from `AuthzModule`, which every API test
   * builds; connecting eagerly would open (and endlessly retry) a socket in
   * every one of them. Rejudge is rare, so paying the connect on first use
   * costs nothing real and keeps the rest of the application — and the
   * suite — exactly as it was.
   */
  private redis: Redis | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async publish(submissionId: number): Promise<void> {
    try {
      await this.connection().publish(SUBMISSION_CHANNEL, String(submissionId));
    } catch (error) {
      this.logger.warn(
        `realtime publish for submission ${String(submissionId)} failed: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /** Opens the connection once, and attaches its error listener once with it. */
  private connection(): Redis {
    if (this.redis) return this.redis;
    const redis = new Redis(this.config.redisUrl, {
      // No offline queue: a publish issued while the connection is down must
      // fail immediately and be logged, not sit in memory waiting for a Redis
      // that may never come back. The event it carries is a wake-up, and a
      // wake-up delivered minutes late is worse than none.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    // ioredis suppresses 'error' emissions when nothing listens, which turns a
    // dead Redis into an unhandled 'error' event on the process. Mirrors
    // `RedisSubscriber`'s own listener, for the same reason — attached here,
    // with the connection, rather than per publish, which would leak a
    // listener on every call.
    redis.on('error', () => undefined);
    this.redis = redis;
    return redis;
  }

  onModuleDestroy(): void {
    // `disconnect()`, not `quit()` — the same ioredis footgun `RedisSubscriber`
    // documents: `quit()` waits on a reply from a connection that may never
    // have finished connecting, which would make shutdown hang.
    this.redis?.disconnect();
    this.redis = null;
  }
}
