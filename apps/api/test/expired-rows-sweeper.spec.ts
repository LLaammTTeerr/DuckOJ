/**
 * m3 — the three authentication tables nothing ever deleted from.
 *
 * The sweep is the only thing that bounds them: `RateLimiter`'s own cleanup
 * is per key and never revisits a key an attacker used once, and neither
 * `sessions` nor `one_time_tokens` is ever deleted from on expiry at all.
 * These tests assert both halves — what goes, and what must NOT go, because
 * a sweep that is one comparison too greedy signs everybody out.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import {
  ExpiredRowsSweeper,
  RATE_EVENT_RETENTION_MS,
} from '../src/authn/expired-rows.sweeper.js';
import { withTestDb } from './db.harness.js';

async function makeUser(db: Db, username: string): Promise<number> {
  const [user] = await db
    .insert(schema.users)
    .values({ username, email: `${username}@e.com`, passwordHash: 'x', displayName: username })
    .returning();
  return user!.id;
}

const HOUR = 60 * 60_000;

describe('ExpiredRowsSweeper', () => {
  it('deletes rows past their usefulness and keeps every live one', async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db, 'sweepee');
      const now = new Date();

      // One row per key, never revisited — the shape login's failure
      // counter leaves behind when an attacker never repeats an identifier.
      await db.insert(schema.rateEvents).values([
        { purpose: 'login', key: 'user:ghost-1' },
        { purpose: 'login', key: 'user:ghost-2' },
        { purpose: 'login', key: 'user:recent' },
      ]);
      await db
        .update(schema.rateEvents)
        .set({ createdAt: new Date(now.getTime() - RATE_EVENT_RETENTION_MS - HOUR) })
        .where(eq(schema.rateEvents.key, 'user:ghost-1'));
      await db
        .update(schema.rateEvents)
        .set({ createdAt: new Date(now.getTime() - RATE_EVENT_RETENTION_MS - HOUR) })
        .where(eq(schema.rateEvents.key, 'user:ghost-2'));

      await db.insert(schema.sessions).values([
        { userId, tokenHash: 'dead-session', expiresAt: new Date(now.getTime() - HOUR) },
        { userId, tokenHash: 'live-session', expiresAt: new Date(now.getTime() + HOUR) },
      ]);
      await db.insert(schema.oneTimeTokens).values([
        {
          userId,
          purpose: 'password_reset',
          tokenHash: 'stale-token',
          expiresAt: new Date(now.getTime() - HOUR),
        },
        {
          userId,
          purpose: 'email_verification',
          tokenHash: 'live-token',
          expiresAt: new Date(now.getTime() + HOUR),
        },
      ]);

      const swept = await new ExpiredRowsSweeper(db).sweep(now);
      expect(swept).toEqual({ rateEvents: 2, sessions: 1, oneTimeTokens: 1 });

      expect(
        (await db.select({ key: schema.rateEvents.key }).from(schema.rateEvents)).map((r) => r.key),
      ).toEqual(['user:recent']);
      // The load-bearing negative: a sweep that took live sessions would end
      // every signed-in person's session once an hour.
      expect(
        (await db.select({ h: schema.sessions.tokenHash }).from(schema.sessions)).map((r) => r.h),
      ).toEqual(['live-session']);
      expect(
        (await db.select({ h: schema.oneTimeTokens.tokenHash }).from(schema.oneTimeTokens)).map(
          (r) => r.h,
        ),
      ).toEqual(['live-token']);
    });
  }, 120_000);

  it('keeps a rate event that is old but still inside a live window', async () => {
    await withTestDb(async (db) => {
      const now = new Date();
      await db.insert(schema.rateEvents).values({ purpose: 'register', key: 'ip:203.0.113.7' });
      // Two hours old: outside D26's one-hour registration window, well
      // inside the retention. Retention is deliberately far longer than any
      // window, so the sweep can never be what reopens one.
      await db
        .update(schema.rateEvents)
        .set({ createdAt: new Date(now.getTime() - 2 * HOUR) });

      expect((await new ExpiredRowsSweeper(db).sweep(now)).rateEvents).toBe(0);
    });
  }, 120_000);
});

/**
 * The sweep counts what the driver already told it, and never asks the
 * database to hand back every deleted row.
 *
 * This is not a micro-optimisation. The module's own header estimates
 * `rate_events` at ~8.6M rows a day under a login-stuffing run — the exact
 * case the sweep exists for — so `.returning({ id })` would build an array
 * of eight million ids inside the API process on the first sweep after a
 * quiet week, to read `.length` off it. The table this file bounds would
 * then take the process down instead of the disk.
 *
 * A container proves nothing here: at three rows `.length` and `.count`
 * agree. So the stub below answers a plain DELETE with a count and a
 * `.returning()` with an empty list, which is exactly how postgres.js
 * behaves — and makes the two implementations give different answers.
 */
describe('the sweep does not materialise what it deletes', () => {
  function stubDb(count: number): { db: Db; returningCalls: number } {
    const state = { returningCalls: 0 };
    const result = { count };
    const db = {
      delete: () => ({
        where: () => ({
          // Awaiting the DELETE itself yields postgres.js's `RowList`: empty,
          // with the affected-row count on it.
          then: (resolve: (value: unknown) => void) => {
            resolve(result);
          },
          returning: () => {
            state.returningCalls += 1;
            return Promise.resolve([]);
          },
        }),
      }),
    };
    return { db: db as unknown as Db, returningCalls: state.returningCalls };
  }

  it('reads the affected-row count instead of returning every id', async () => {
    const { db } = stubDb(8_600_000);
    const swept = await new ExpiredRowsSweeper(db).sweep();
    expect(swept).toEqual({
      rateEvents: 8_600_000,
      sessions: 8_600_000,
      oneTimeTokens: 8_600_000,
    });
  });

  it('reports nothing swept rather than NaN if the driver stops counting', async () => {
    const db = {
      delete: () => ({ where: () => ({ then: (r: (v: unknown) => void) => { r([]); } }) }),
    } as unknown as Db;
    const swept = await new ExpiredRowsSweeper(db).sweep();
    expect(swept).toEqual({ rateEvents: 0, sessions: 0, oneTimeTokens: 0 });
  });
});
