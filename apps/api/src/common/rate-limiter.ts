/**
 * A fixed-window rate limiter counted in the database (D13).
 *
 * DB-backed because it is the only variant that is both deterministic under
 * test and correct across several API instances; a window, not a token
 * bucket, because every use here is "a handful per hour" where burst shape
 * is irrelevant. The check is count-then-insert without a lock, so two
 * concurrent requests can both pass at the boundary — acceptable by design:
 * the limits guard nuisance volume (outbound mail), not a security
 * invariant that must be exact.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, gt, lte } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import { DB } from '../config/config.module.js';

@Injectable()
export class RateLimiter {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Records the attempt and answers whether it is within `limit` per
   * `windowMs`. The attempt is recorded even when refused: a refused caller
   * keeps burning their own window rather than probing its edge for free.
   */
  async allow(purpose: string, key: string, limit: number, windowMs: number): Promise<boolean> {
    const cutoff = new Date(Date.now() - windowMs);
    // Opportunistic cleanup: this key's expired rows die on this key's next
    // attempt, so the table stays bounded without a cron.
    await this.db
      .delete(schema.rateEvents)
      .where(
        and(
          eq(schema.rateEvents.purpose, purpose),
          eq(schema.rateEvents.key, key),
          lte(schema.rateEvents.createdAt, cutoff),
        ),
      );
    const [row] = await this.db
      .select({ n: count() })
      .from(schema.rateEvents)
      .where(
        and(
          eq(schema.rateEvents.purpose, purpose),
          eq(schema.rateEvents.key, key),
          gt(schema.rateEvents.createdAt, cutoff),
        ),
      );
    await this.db.insert(schema.rateEvents).values({ purpose, key });
    return (row?.n ?? 0) < limit;
  }

  /**
   * The read half of `allow`, split out for callers that must decide BEFORE
   * they know whether the attempt counts.
   *
   * `allow` fuses "count" and "record", which is right for the recovery
   * endpoints — every request there is an attempt. Login is not like that:
   * only a *failed* sign-in consumes the window, and whether it failed is
   * only known after the password has been checked, which is after the
   * refusal must already have been decided. So the two halves are separate
   * here: `retryAfterSeconds` to refuse, `record` on the way out of a
   * failure.
   *
   * Returns `null` when the caller is under the limit, or the whole seconds
   * until it will be — the instant the oldest in-window event falls out,
   * which is exactly when the count drops back below `limit`. Never returns
   * `0`: a `Retry-After: 0` invites an immediate retry that would be refused
   * again.
   */
  async retryAfterSeconds(
    purpose: string,
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<number | null> {
    const cutoff = new Date(Date.now() - windowMs);
    const rows = await this.db
      .select({ createdAt: schema.rateEvents.createdAt })
      .from(schema.rateEvents)
      .where(
        and(
          eq(schema.rateEvents.purpose, purpose),
          eq(schema.rateEvents.key, key),
          gt(schema.rateEvents.createdAt, cutoff),
        ),
      )
      .orderBy(asc(schema.rateEvents.createdAt))
      .limit(limit);
    if (rows.length < limit) return null;
    const expiresAt = rows[0]!.createdAt.getTime() + windowMs;
    return Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
  }

  /**
   * Records one attempt against `key`, and drops that key's expired rows on
   * the way past — the same opportunistic cleanup `allow` does, so a key
   * that is only ever recorded through here still stays bounded.
   */
  async record(purpose: string, key: string, windowMs: number): Promise<void> {
    await this.db
      .delete(schema.rateEvents)
      .where(
        and(
          eq(schema.rateEvents.purpose, purpose),
          eq(schema.rateEvents.key, key),
          lte(schema.rateEvents.createdAt, new Date(Date.now() - windowMs)),
        ),
      );
    await this.db.insert(schema.rateEvents).values({ purpose, key });
  }
}
