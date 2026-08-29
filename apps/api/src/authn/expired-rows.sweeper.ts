/**
 * The janitor for the three authentication tables nothing else ever deletes
 * from (final review m3).
 *
 * Each of them was written with a filter instead of a delete, which is
 * correct for reads and leaves the rows on disk forever:
 *
 * - `rate_events` — `RateLimiter`'s cleanup is *per key*, so a key's expired
 *   rows die on that key's next attempt. Login records one row per failure
 *   under `user:<submitted identifier>`, and an attacker who never repeats an
 *   identifier leaves rows nothing will ever look at again (~8.6M a day at
 *   100 req/s). Registration's `ip:` keys and the recovery mail keys do
 *   revisit themselves, so they are already bounded; the sweep is for the
 *   ones that are not.
 * - `sessions` — `resolve` filters on `expires_at > now()` and only `logout`
 *   and a password reset (D32) ever delete. Every expired session of every
 *   user who simply closed the tab is still there.
 * - `one_time_tokens` — `redeem` filters on `used_at is null` and a live
 *   `expires_at`; a spent or stale reset link is never removed.
 *
 * **A sweep, not a schema change.** A partial index or a TTL extension would
 * be a migration, and this brief adds none. A DELETE by age against
 * `rate_events_lookup_idx`'s trailing `created_at` (and the sessions /
 * one-time-token expiry columns) is cheap at any table size this deployment
 * will see.
 *
 * **Runs in every worker.** `API_WORKERS` processes each hold one of these,
 * so the sweep happens up to that many times an hour. That is deliberate:
 * the alternative is leader election for a DELETE that is idempotent, whose
 * repeat costs one index scan that finds nothing. The timer is `unref`'d so
 * it never keeps a process alive, and cleared on module destroy so tests do
 * not leak it.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { lt } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import { DB } from '../config/config.module.js';

/** How often the sweep runs. */
export const SWEEP_INTERVAL_MS = 60 * 60_000;

/**
 * How long a `rate_events` row is kept. Comfortably longer than the longest
 * window any caller uses (D26's registration hour, D13's mail hour), so a
 * live window can never be swept out from under its own limiter — the
 * sweep's job is the rows *nothing* counts any more, not the ones that are
 * merely old.
 */
export const RATE_EVENT_RETENTION_MS = 24 * 60 * 60_000;

@Injectable()
export class ExpiredRowsSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ExpiredRowsSweeper.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(@Inject(DB) private readonly db: Db) {}

  onApplicationBootstrap(): void {
    // No sweep at boot: a test builds and tears down an application per
    // spec, and a DELETE firing inside its rolled-back fixture transaction
    // would be a surprise nothing asked for. Production stacks run for days,
    // which is the case this exists for.
    this.timer = setInterval(() => void this.sweepQuietly(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Deletes what is past its usefulness; returns the row counts, for tests. */
  async sweep(now: Date = new Date()): Promise<{
    rateEvents: number;
    sessions: number;
    oneTimeTokens: number;
  }> {
    const rateEvents = await this.db
      .delete(schema.rateEvents)
      .where(lt(schema.rateEvents.createdAt, new Date(now.getTime() - RATE_EVENT_RETENTION_MS)))
      .returning({ id: schema.rateEvents.id });
    const sessions = await this.db
      .delete(schema.sessions)
      .where(lt(schema.sessions.expiresAt, now))
      .returning({ id: schema.sessions.id });
    const oneTimeTokens = await this.db
      .delete(schema.oneTimeTokens)
      .where(lt(schema.oneTimeTokens.expiresAt, now))
      .returning({ id: schema.oneTimeTokens.id });
    return {
      rateEvents: rateEvents.length,
      sessions: sessions.length,
      oneTimeTokens: oneTimeTokens.length,
    };
  }

  /**
   * The timer's entry point. A failed sweep is a log line, never an unhandled
   * rejection: nothing depends on it having run, and a database blip at 3 a.m.
   * must not take the API process down with it.
   */
  private async sweepQuietly(): Promise<void> {
    try {
      const swept = await this.sweep();
      const total = swept.rateEvents + swept.sessions + swept.oneTimeTokens;
      if (total > 0) {
        this.logger.log(
          `swept ${String(swept.rateEvents)} rate events, ${String(swept.sessions)} sessions, ` +
            `${String(swept.oneTimeTokens)} one-time tokens`,
        );
      }
    } catch (error) {
      this.logger.warn(`sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
