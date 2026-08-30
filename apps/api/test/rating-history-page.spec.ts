/**
 * `GET /users/{username}/rating` is a page (D58's shape, applied to the one
 * collection B7 left unbounded).
 *
 * A rating history grows by one row per rated contest forever, and a province
 * running a weekly round hands a four-year-old account two hundred rows on
 * every profile view. The rows are built here directly rather than by
 * replaying golden contests: what is under test is the WALK — order, the
 * tiebreaker, and that nothing is skipped or served twice — and a Glicko fold
 * would only make that slower to set up.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { schema, type Db } from '@duckoj/db';
import { contests, ratingEvents } from '@duckoj/db/guarded';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';

async function seedHistory(db: Db, username: string, endTimes: string[]): Promise<void> {
  const [user] = await db
    .insert(schema.users)
    .values({
      username,
      email: `${username}@example.com`,
      passwordHash: 'x',
      displayName: username,
    })
    .returning();
  const rows = await db
    .insert(contests)
    .values(
      endTimes.map((endTime, index) => ({
        key: `${username}-c${String(index)}`,
        name: `Round ${String(index)}`,
        startTime: new Date(Date.parse(endTime) - 3 * 3600_000),
        endTime: new Date(endTime),
        format: 'icpc',
        isRated: true,
        createdBy: user!.id,
      })),
    )
    .returning({ id: contests.id });
  await db.insert(ratingEvents).values(
    rows.map((contest, index) => ({
      contestId: contest.id,
      userId: user!.id,
      ratingBefore: 1500 + index,
      rdBefore: 350,
      volatilityBefore: 0.06,
      ratingAfter: 1510 + index,
      rdAfter: 300,
      volatilityAfter: 0.06,
      rank: index + 1,
    })),
  );
}

describe('GET /users/{username}/rating is keyset-paged', () => {
  it('walks the whole history oldest-first, once each, over three pages', async () => {
    await withTestDb(async (db) => {
      await seedHistory(db, 'pager', [
        '2026-01-01T10:00:00Z',
        '2026-02-01T10:00:00Z',
        '2026-03-01T10:00:00Z',
        '2026-04-01T10:00:00Z',
        '2026-05-01T10:00:00Z',
      ]);
      const app = await buildApp(db);
      try {
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 3; page += 1) {
          const query: Record<string, string> = { limit: '2' };
          if (cursor !== null) query.cursor = cursor;
          const response = await request(app.getHttpServer())
            .get('/users/pager/rating')
            .query(query);
          expect(response.status).toBe(200);
          seen.push(...response.body.items.map((event: { contestKey: string }) => event.contestKey));
          cursor = response.body.nextCursor as string | null;
        }
        expect(seen).toEqual(['pager-c0', 'pager-c1', 'pager-c2', 'pager-c3', 'pager-c4']);
        // The last page is short, so it says the walk is over.
        expect(cursor).toBeNull();
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('does not lose a contest that ends at the same instant as the cursor', async () => {
    await withTestDb(async (db) => {
      // Two rounds finishing together is not exotic — a division-1 and a
      // division-2 contest end on the same bell. A cursor keyed on the
      // timestamp alone either skips the second or serves the first twice.
      await seedHistory(db, 'tied', [
        '2026-06-01T10:00:00Z',
        '2026-06-01T10:00:00Z',
        '2026-07-01T10:00:00Z',
      ]);
      const app = await buildApp(db);
      try {
        const first = await request(app.getHttpServer())
          .get('/users/tied/rating')
          .query({ limit: '1' });
        const second = await request(app.getHttpServer())
          .get('/users/tied/rating')
          .query({ limit: '1', cursor: first.body.nextCursor });
        expect(second.body.items).toHaveLength(1);
        expect(second.body.items[0].contestKey).not.toBe(first.body.items[0].contestKey);
        expect(second.body.items[0].endTime).toBe(first.body.items[0].endTime);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('serves a hundred by default and refuses a cursor it could never have issued', async () => {
    await withTestDb(async (db) => {
      const endTimes = Array.from({ length: 101 }, (_, index) =>
        new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString(),
      );
      await seedHistory(db, 'century', endTimes);
      const app = await buildApp(db);
      try {
        const page = await request(app.getHttpServer()).get('/users/century/rating');
        expect(page.body.items).toHaveLength(100);
        expect(page.body.nextCursor).not.toBeNull();

        const bad = await request(app.getHttpServer())
          .get('/users/century/rating')
          .query({ cursor: 'abc' });
        expect(bad.status).toBe(422);
        expect(bad.body.code).toBe('invalid_cursor');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
