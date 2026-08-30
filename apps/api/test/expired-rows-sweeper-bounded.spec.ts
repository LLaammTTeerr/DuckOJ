/**
 * B12 — the sweep is bounded, in rows per statement and in rows scanned.
 *
 * `expired-rows.sweeper.ts` used to rule that one DELETE by age is fine:
 * *"A DELETE by age against `rate_events_lookup_idx`'s trailing `created_at`
 * (and the sessions / one-time-token expiry columns) is cheap at any table
 * size this deployment will see."* Both halves of that sentence were false.
 *
 * 1. **`created_at` is the TRAILING column** of `rate_events_lookup_idx
 *    (purpose, key, created_at)`. A btree bounds a scan only by a PREFIX of
 *    its columns, so a predicate naming just the third one cannot use it —
 *    Postgres seq-scans instead. `sessions.expires_at` and
 *    `one_time_tokens.expires_at` were not indexed at all; the parenthetical
 *    asserted an index that was never created. Migration 0029 adds all three.
 * 2. **One statement, whatever the size.** The module's own header estimates
 *    `rate_events` at ~8.6M rows a day, and that is the case the sweep exists
 *    for. The sibling spec already proved the sweep does not *materialise*
 *    what it deletes — that bounds this process's memory and says nothing
 *    about the database's.
 *
 * **How the red half works** — `admin-dashboard-plan.spec.ts`'s pattern, for
 * its reason. The indexes live in a migration, so a harness database always
 * has them and "run the suite without 0029" is not a thing a spec can ask
 * for. Each plan test therefore DROPs the index inside the transaction
 * `withTestDb` is already going to roll back, and asserts the plan on exactly
 * the same rows both ways. That is the mutation check, run on every CI pass:
 * delete migration 0029 and the "with" assertions fail; keep it and the
 * "without" assertions prove the index is what changed the plan, rather than
 * the fixture being too small to have a choice.
 */
import { describe, expect, it } from 'vitest';
import { lt, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import {
  ExpiredRowsSweeper,
  RATE_EVENT_RETENTION_MS,
  SWEEP_BATCH_SIZE,
} from '../src/authn/expired-rows.sweeper.js';
import { withTestDb } from './db.harness.js';

const HOUR = 60 * 60_000;

/**
 * 1,000,000 `rate_events` rows, of which ~4% are sweepable.
 *
 * The FRACTION is the load-bearing part of the fixture, not the total. An
 * hourly sweep deletes the hour that just fell out of a 24-hour retention —
 * a sliver, not most of the table — and a predicate that matched 96% of rows
 * would let a `LIMIT` seq scan stop almost immediately, so the planner would
 * pick it *with the index present* and the assertions below would be
 * unfalsifiable. Rows are seeded oldest-last, which is also what an
 * append-only table looks like on disk: the sweepable rows are at the far end
 * of the heap, so a seq scan has to walk everything else to reach them.
 */
const RATE_EVENT_ROWS = 1_000_000;
const EXPIRY_ROWS = 200_000;

/**
 * A timestamp as an ISO string with an explicit cast.
 *
 * postgres.js cannot infer a parameter's type inside these raw
 * `insert … select` templates — it is handed a `Date` for a column it has not
 * been told about and throws `ERR_INVALID_ARG_TYPE` — so the value goes over
 * as text and the cast tells the server what it is.
 */
function iso(at: Date): string {
  return at.toISOString();
}

/** The plan Postgres produced for `statement`, as one string. */
async function plan(db: Db, statement: SQL): Promise<string> {
  const rows = await db.execute<Record<string, string>>(sql`explain (costs off) ${statement}`);
  return rows.map((r) => Object.values(r)[0]).join('\n');
}

/**
 * Runs `statement` and prints its time and buffer count under `label`.
 *
 * Logged, never asserted on. A millisecond threshold on a shared CI box
 * measures the box (`admin-dashboard-plan.spec.ts`'s rule); but D47's
 * amendment cites ms and buffers in the ledger, and this is where D78's
 * equivalent numbers come from. Read them off a run, do not gate on them.
 */
async function cost(db: Db, label: string, statement: SQL): Promise<void> {
  const rows = await db.execute<Record<string, string>>(
    sql`explain (analyze, buffers, costs off) ${statement}`,
  );
  const text = rows.map((r) => Object.values(r)[0]).join('\n');
  const time = /Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? '?';
  const buffers = /Buffers: ([^\n]+)/.exec(text)?.[1] ?? '?';
  console.log(`[B12] ${label}: ${time} ms, buffers ${buffers}`);
}

describe('the sweep finds its rows by index, not by scanning the table', () => {
  it('plans an index scan on rate_events, and a seq scan without 0029', async () => {
    await withTestDb(async (db) => {
      const now = new Date();
      const cutoff = new Date(now.getTime() - RATE_EVENT_RETENTION_MS);
      // 90ms apart spreads 1M rows over 25 hours, so exactly the rows past
      // the 24-hour retention — the last hour of the range, ~4% — are
      // sweepable.
      await db.execute(sql`
        insert into rate_events (purpose, key, created_at)
        select 'login', 'user:ghost-' || g,
               ${iso(now)}::timestamptz - (g * interval '0.09 seconds')
          from generate_series(1, ${sql.raw(String(RATE_EVENT_ROWS))}) as g
      `);
      // Without stats the planner has no row estimate and picks whatever; the
      // claim under test is about the plan on a table Postgres knows.
      await db.execute(sql`analyze rate_events`);

      // The very expression `sweep` builds — a drizzle `lt()` on the column, not
      // a raw comparison — so this asserts the plan of the statement that runs.
      const pick = sql`select ctid from rate_events where ${lt(schema.rateEvents.createdAt, cutoff)} limit ${SWEEP_BATCH_SIZE}`;
      const withIndex = await plan(db, pick);
      expect(withIndex).toMatch(/Index (Only )?Scan.*rate_events_created_at_idx/s);
      await cost(db, 'rate_events pick WITH 0029', pick);

      // The other direction, on the same rows. `rate_events_lookup_idx`
      // survives the drop and is still no help: its first two columns are
      // unbounded here, which is the whole finding.
      await db.execute(sql`drop index rate_events_created_at_idx`);
      const withoutIndex = await plan(db, pick);
      expect(withoutIndex).toMatch(/Seq Scan on rate_events/);
      await cost(db, 'rate_events pick WITHOUT 0029', pick);
    });
  }, 900_000);

  it('plans an index scan on both expiry columns, and a seq scan without 0029', async () => {
    await withTestDb(async (db) => {
      const now = new Date();
      const [user] = await db
        .insert(schema.users)
        .values({ username: 'b12-idx', email: 'b12@e.com', passwordHash: 'x', displayName: 'b' })
        .returning();
      // 5% expired, and expiring in CREATION order — which is what a
      // sessions table actually looks like, every row carrying the same
      // fixed lifetime from when it was minted. That ordering matters to the
      // assertion, not only to realism: `expires_at` then correlates almost
      // perfectly with physical position, so an index scan reads a handful of
      // sequential heap pages. Scatter the same 10 000 expired rows evenly
      // through the heap instead and the index scan becomes ~8 000 RANDOM
      // page fetches, which the planner can rationally decline in favour of a
      // sequential scan of the very same pages — the "with index" assertion
      // would then fail for a reason that has nothing to do with 0029.
      await db.execute(sql`
        insert into sessions (user_id, token_hash, expires_at)
        select ${user!.id}, 'h-' || g,
               case when g <= 10000 then ${iso(now)}::timestamptz - interval '3 hours' + (g * interval '1 second')
                    else ${iso(now)}::timestamptz + interval '14 days' + (g * interval '1 second') end
          from generate_series(1, ${sql.raw(String(EXPIRY_ROWS))}) as g
      `);
      await db.execute(sql`analyze sessions`);
      const pickSessions = sql`select ctid from sessions where ${lt(schema.sessions.expiresAt, now)} limit ${SWEEP_BATCH_SIZE}`;
      expect(await plan(db, pickSessions)).toMatch(
        /Index (Only )?Scan.*sessions_expires_at_idx/s,
      );
      await db.execute(sql`drop index sessions_expires_at_idx`);
      expect(await plan(db, pickSessions)).toMatch(/Seq Scan on sessions/);

      await db.execute(sql`
        insert into one_time_tokens (user_id, purpose, token_hash, expires_at)
        select ${user!.id}, 'password_reset', 't-' || g,
               case when g <= 10000 then ${iso(now)}::timestamptz - interval '3 hours' + (g * interval '1 second')
                    else ${iso(now)}::timestamptz + interval '14 days' + (g * interval '1 second') end
          from generate_series(1, ${sql.raw(String(EXPIRY_ROWS))}) as g
      `);
      await db.execute(sql`analyze one_time_tokens`);
      const pickTokens = sql`select ctid from one_time_tokens where ${lt(schema.oneTimeTokens.expiresAt, now)} limit ${SWEEP_BATCH_SIZE}`;
      expect(await plan(db, pickTokens)).toMatch(
        /Index (Only )?Scan.*one_time_tokens_expires_at_idx/s,
      );
      await db.execute(sql`drop index one_time_tokens_expires_at_idx`);
      expect(await plan(db, pickTokens)).toMatch(/Seq Scan on one_time_tokens/);
    });
  }, 900_000);
});

describe('the sweep deletes in bounded batches', () => {
  it('never asks the database to delete more than one batch at a time', async () => {
    await withTestDb(async (db) => {
      const now = new Date();
      const stale = new Date(now.getTime() - RATE_EVENT_RETENTION_MS - HOUR);
      // Two full batches and a remainder, at a batch size small enough to run
      // in a test: the shape that distinguishes a loop from one statement.
      const batch = 40;
      const total = 2 * batch + 7;
      await db.execute(sql`
        insert into rate_events (purpose, key, created_at)
        select 'login', 'user:ghost-' || g, ${iso(stale)}::timestamptz
          from generate_series(1, ${sql.raw(String(total))}) as g
      `);
      // One row inside retention, so a "delete until the table is empty" loop
      // would be caught rather than passing.
      await db.insert(schema.rateEvents).values({ purpose: 'login', key: 'user:live' });

      const statements: string[] = [];
      const counting = countingDeletes(db, statements);

      const swept = await new ExpiredRowsSweeper(counting).sweep(now, batch);
      expect(swept.rateEvents).toBe(total);

      // ceil(87/40) = 3 statements for rate_events — the third removes 7,
      // which is short, which is what ends the loop — plus one each for the
      // two empty tables. One unbounded statement per table would be 3.
      expect(statements.length).toBe(3 + 1 + 1);

      expect(
        (await db.select({ key: schema.rateEvents.key }).from(schema.rateEvents)).map((r) => r.key),
      ).toEqual(['user:live']);
    });
  }, 180_000);

  it('costs one statement per table when there is nothing to sweep', async () => {
    await withTestDb(async (db) => {
      const statements: string[] = [];
      const swept = await new ExpiredRowsSweeper(countingDeletes(db, statements)).sweep(
        new Date(),
        40,
      );
      expect(swept).toEqual({ rateEvents: 0, sessions: 0, oneTimeTokens: 0 });
      // A loop that re-probed an empty table would be a wasted round trip
      // every hour, in every worker, forever. Ending on a SHORT batch rather
      // than on an empty one is what avoids it.
      expect(statements.length).toBe(3);
    });
  }, 180_000);
});

/** `db`, with every `.delete()` recorded in `into`. */
function countingDeletes(db: Db, into: string[]): Db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'delete') {
        const original = Reflect.get(target, prop, receiver) as (
          this: Db,
          ...a: unknown[]
        ) => unknown;
        return (...args: unknown[]) => {
          into.push('delete');
          return original.call(target, ...args);
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  }) as Db;
}
