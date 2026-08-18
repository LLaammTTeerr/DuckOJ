import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import { SUBMISSION_CHANNEL } from '@qhhoj/realtime';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { SubmissionsGateway } from './submissions.gateway.js';

/**
 * Subscribes to the channel `judged`'s `SubmissionEvents` publishes on and
 * forwards each id to `SubmissionsGateway.notify`. Uses a **dedicated**
 * `ioredis` connection: once a connection issues `SUBSCRIBE` it can serve no
 * other command, so it must not be shared with anything that needs to.
 */
@Injectable()
export class RedisSubscriber implements OnModuleInit, OnModuleDestroy {
  private readonly redis: Redis;

  /**
   * Resolves once the subscription is actually live. Production code never
   * awaits this — a Redis outage at boot must degrade this subscriber, not
   * block `main.ts`'s `app.listen`. Tests that publish immediately after
   * boot do need it, to avoid racing "connected" against "published".
   */
  readonly ready: Promise<void>;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(SubmissionsGateway) private readonly gateway: SubmissionsGateway,
  ) {
    this.redis = new Redis(config.redisUrl);
    this.redis.on('error', (error: unknown) => {
      // ioredis suppresses 'error' emissions entirely when nothing is
      // listening, so without this a dead Redis fails silently: every
      // wake-up signal would quietly never arrive. Mirrors judged's own
      // `main.ts`, which documents the same footgun.
      console.error(
        JSON.stringify({
          msg: 'redis subscriber error',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
    this.redis.on('message', (channel: string, message: string) => {
      if (channel !== SUBMISSION_CHANNEL) return;
      const submissionId = Number(message);
      // `Number('')` is `0`, which is finite — an empty message would
      // otherwise call `notify(0)`. Harmless today (`submissions.id` is a
      // `bigserial`, which never issues `0`), but nothing here should rely
      // on that fact holding forever; require an actual positive id.
      if (Number.isFinite(submissionId) && submissionId > 0) this.gateway.notify(submissionId);
    });

    this.ready = this.redis.subscribe(SUBMISSION_CHANNEL).then(() => undefined);
  }

  onModuleInit(): void {
    // Deliberately not awaited: connecting starts as soon as this provider is
    // instantiated (in the constructor, via the first command), and a Redis
    // outage at boot must not block application startup. `this.ready` exists
    // for callers — tests — that need to know the subscription is live.
    this.ready.catch(() => {
      /* already reported via the 'error' listener above */
    });
  }

  async onModuleDestroy(): Promise<void> {
    // `disconnect()` rather than `quit()`: `quit()` sends a command and waits
    // on a reply, which is a known ioredis footgun against a connection that
    // never finished connecting (exactly the state a dead Redis leaves this
    // in) — it would make a throwing shutdown hook fail every test's
    // `app.close()`. `disconnect()` tears down immediately and never rejects.
    this.redis.disconnect();
  }
}
