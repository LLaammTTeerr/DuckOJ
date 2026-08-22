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
import { and, count, eq, gt, lte } from 'drizzle-orm';
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
}
