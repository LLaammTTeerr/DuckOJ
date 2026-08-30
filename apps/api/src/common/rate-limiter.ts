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
import { and, asc, count, eq, gt, lte, sql } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import { DB } from '../config/config.module.js';

/**
 * The prefix a refusal is recorded under (D47).
 *
 * `rate_events` holds one row per ATTEMPT, admitted or not — which is right
 * for counting a window and useless for the operator question "how many
 * callers did the limiter turn away in the last hour". So a refusal writes a
 * SECOND row, under `refused:<purpose>`, against the same key.
 *
 * A prefixed purpose rather than a `refused boolean` column because
 * `purpose` is plain text by design ("a new limited action must not require
 * a migration" — the column's own doc comment), and because it keeps the two
 * populations disjoint for free: every existing count filters on an exact
 * purpose, so no marker can ever be mistaken for an attempt, and the
 * limiter cannot end up rate-limiting its own bookkeeping. The expired-rows
 * sweeper already deletes `rate_events` by age alone, so markers stay
 * bounded with no new cleanup.
 */
export const REFUSAL_PREFIX = 'refused:';

/** The purpose a refusal of `purpose` is recorded under. */
export function refusalPurpose(purpose: string): string {
  return `${REFUSAL_PREFIX}${purpose}`;
}

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
    const admitted = (row?.n ?? 0) < limit;
    if (!admitted) await this.markRefused(purpose, key);
    return admitted;
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
    options: { mark?: boolean } = {},
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
    // Refusing is the caller's only reason to ask, and every caller does
    // refuse on a non-null answer — so this branch IS the refusal, and it is
    // where the marker belongs. The wart: login asks twice, once per key
    // (user and IP), so one refused sign-in can leave two markers. Counting
    // refusals slightly high during a credential-stuffing run is the
    // harmless direction, and de-duplicating would mean teaching the limiter
    // what a request is.
    //
    // `mark: false` is for a caller asking about the SAME purpose and key
    // twice — D80's submission meter asks its burst window and its sustained
    // window, both keyed `user:<id>`, so that the `Retry-After` it answers is
    // the longer of the two. Login's two markers are two different keys and
    // arguably two facts; those are one request refused once, and counting it
    // twice doubles exactly the number D95's monitor shows an organiser when
    // somebody is running a script. So that caller asks with `mark: false`
    // and calls {@link markRefused} once itself.
    if (options.mark !== false) await this.markRefused(purpose, key);
    const expiresAt = rows[0]!.createdAt.getTime() + windowMs;
    return Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
  }

  /**
   * A limit of exactly one, made race-free: answers `true` for the first
   * caller to present `key` within `windowMs` and `false` for every one
   * after it.
   *
   * `allow(purpose, key, 1, windowMs)` looks like it does this and does not.
   * Its count-then-insert has no lock, which the class comment above
   * accepts *because* the limits it serves guard nuisance volume. A
   * single-use guard is the opposite: two concurrent presentations of the
   * same credential is precisely the case it exists to refuse — a
   * phishing relay forwards the victim's code the same instant the victim
   * submits it — so this variant takes a transaction-scoped advisory lock
   * on `(purpose, key)` first and serialises them.
   *
   * The lock id is md5-derived rather than `hashtext()`: the latter is an
   * internal function with no compatibility promise, and this needs one
   * stable number per key, not a good hash.
   */
  async consumeOnce(purpose: string, key: string, windowMs: number): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock((('x' || substr(md5(${purpose + ':' + key}), 1, 16))::bit(64))::bigint)`,
      );
      const [row] = await tx
        .select({ n: count() })
        .from(schema.rateEvents)
        .where(
          and(
            eq(schema.rateEvents.purpose, purpose),
            eq(schema.rateEvents.key, key),
            gt(schema.rateEvents.createdAt, new Date(Date.now() - windowMs)),
          ),
        );
      if ((row?.n ?? 0) > 0) {
        // Inside the transaction, so a refusal and its marker land together
        // or not at all.
        await tx.insert(schema.rateEvents).values({ purpose: refusalPurpose(purpose), key });
        return false;
      }
      await tx.insert(schema.rateEvents).values({ purpose, key });
      return true;
    });
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

  /**
   * Writes the refusal marker (D47), never throwing.
   *
   * Bookkeeping must not be able to turn a refusal into a 500: the caller
   * has already DECIDED to refuse by the time this runs, and a database blip
   * here is an observability gap, exactly as `touchJudgeLastSeen`'s is.
   */
  async markRefused(purpose: string, key: string): Promise<void> {
    try {
      await this.db.insert(schema.rateEvents).values({ purpose: refusalPurpose(purpose), key });
    } catch {
      // Swallow — see doc comment above.
    }
  }
}
