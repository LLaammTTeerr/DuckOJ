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
 * **This used to be a sweep and not a schema change**, on the reasoning that
 * "a DELETE by age against `rate_events_lookup_idx`'s trailing `created_at`
 * (and the sessions / one-time-token expiry columns) is cheap at any table
 * size this deployment will see." Measured in B12, both halves of that
 * sentence were false, and migration 0029 plus the batching below is the
 * correction (D78).
 *
 * - **A btree bounds a scan by a PREFIX of its columns.** `created_at` is the
 *   *third* column of `rate_events_lookup_idx (purpose, key, created_at)`, and
 *   the sweep's predicate names neither of the first two — so the index could
 *   never serve it. `sessions.expires_at` and `one_time_tokens.expires_at` had
 *   no index at all; the parenthetical above asserted one that was never
 *   created. All three predicates therefore sequentially scanned a table this
 *   file's own header estimates at 8.6M rows a day.
 * - **One statement is not a bounded amount of work.** Deleting 8.6M rows in a
 *   single DELETE is one transaction holding one long lock, one WAL burst, and
 *   — the part that matters — no progress kept if it is interrupted, so the
 *   next hour's attempt redoes all of it and fails the same way. The sibling
 *   spec already proved the sweep does not *materialise* what it deletes,
 *   which bounds this process's memory and says nothing about the database's.
 *
 * The fix is deliberately the pair, not either half: an index with no batching
 * still deletes 8.6M rows in one transaction, and batching with no index still
 * scans the whole table once per batch.
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
import { lt, sql } from 'drizzle-orm';
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

/**
 * The most rows any one DELETE this file issues may remove.
 *
 * Ten thousand, because the number has to sit between two costs that pull in
 * opposite directions: a batch too small turns an hourly sweep into thousands
 * of round trips, and a batch too large reintroduces exactly the unbounded
 * transaction this bounds. At 10k the sweep of a full 8.6M-row day is 860
 * statements — each one a short transaction that commits, so an interruption
 * loses at most the last batch and the next hour resumes where this one
 * stopped, rather than starting the same 8.6M-row DELETE again.
 */
export const SWEEP_BATCH_SIZE = 10_000;

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

  /**
   * Deletes what is past its usefulness; returns the row counts, for the log
   * line and for tests.
   *
   * **Counted by the driver, never by `.returning()`.** This module's own
   * opening paragraph estimates `rate_events` at ~8.6M rows a day on a
   * login-stuffing run, and that is precisely the case the sweep exists for
   * — so a first sweep after a quiet week is exactly when `.returning({ id })`
   * would drag every deleted id back over the wire and build an array of
   * them, in the API process, to do nothing with but read `.length`. That
   * turns a table this file was written to bound into an allocation that can
   * take the process down: the failure moved from the database to the API
   * rather than being fixed. postgres.js already reports the affected-row
   * count on a plain DELETE, which is the same number for none of the cost.
   */
  async sweep(
    now: Date = new Date(),
    batchSize: number = SWEEP_BATCH_SIZE,
  ): Promise<{
    rateEvents: number;
    sessions: number;
    oneTimeTokens: number;
  }> {
    const cutoff = new Date(now.getTime() - RATE_EVENT_RETENTION_MS);
    // `ctid in (select … limit n)`, because Postgres has no `DELETE … LIMIT`:
    // the subquery picks n physical row addresses through the index migration
    // 0029 adds, and the DELETE removes exactly those.
    //
    // The comparison stays a drizzle `lt()` on the COLUMN rather than raw
    // `created_at < ${…}`. Interpolating the Date straight into the template
    // hands postgres.js a value it has no column to infer a type from, and it
    // throws `ERR_INVALID_ARG_TYPE` at bind time — every sweep failing as a
    // warning line nothing reads. `lt()` carries the column's own mapper.
    const rateEvents = await this.deleteInBatches(batchSize, () =>
      this.db
        .delete(schema.rateEvents)
        .where(
          sql`ctid in (select ctid from rate_events where ${lt(schema.rateEvents.createdAt, cutoff)} limit ${batchSize})`,
        ),
    );
    const sessions = await this.deleteInBatches(batchSize, () =>
      this.db
        .delete(schema.sessions)
        .where(
          sql`ctid in (select ctid from sessions where ${lt(schema.sessions.expiresAt, now)} limit ${batchSize})`,
        ),
    );
    const oneTimeTokens = await this.deleteInBatches(batchSize, () =>
      this.db
        .delete(schema.oneTimeTokens)
        .where(
          sql`ctid in (select ctid from one_time_tokens where ${lt(schema.oneTimeTokens.expiresAt, now)} limit ${batchSize})`,
        ),
    );
    return { rateEvents, sessions, oneTimeTokens };
  }

  /**
   * Runs `statement` until it removes less than a full batch, and returns the
   * total.
   *
   * "Less than a full batch" is the termination condition rather than "zero"
   * on purpose: a short batch means the predicate has no more matching rows,
   * so one extra round trip per table per sweep is saved on the common case of
   * a queue that is already drained. A table with nothing to sweep therefore
   * costs exactly one statement, not two.
   */
  private async deleteInBatches(
    batchSize: number,
    statement: () => Promise<unknown>,
  ): Promise<number> {
    let total = 0;
    for (;;) {
      const removed = affected(await statement());
      total += removed;
      if (removed < batchSize) return total;
    }
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

/**
 * How many rows a DELETE removed, from whatever the driver handed back.
 *
 * postgres.js resolves a statement with no `RETURNING` to an empty `RowList`
 * carrying `count`; drizzle passes that object straight through, and its
 * static type says nothing about it. Read here, once, with a `0` fallback,
 * so the sweep's log line degrades to "nothing swept" rather than to `NaN`
 * if the driver ever stops reporting it.
 */
function affected(result: unknown): number {
  const count = (result as { count?: unknown } | null)?.count;
  return typeof count === 'number' ? count : 0;
}
