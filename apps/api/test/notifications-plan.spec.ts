/**
 * The notification feed, as a query PLAN.
 *
 * `notifications.spec.ts` checks who is told what. This file checks the thing
 * it cannot see: that a person with a season's worth of notifications is
 * served the newest fifty of them without reading the table — and that the
 * unread count beside them is answered the same way.
 *
 * **The bell is the reason this matters.** `nav.tsx` polls `GET
 * /notifications` once a minute for every signed-in tab, and that one request
 * runs BOTH statements below. A plan that degrades with the size of the table
 * degrades on the busiest possible schedule.
 *
 * **The fixture is `contest-monitor-plan.spec.ts`'s**, for its reason: below a
 * few thousand rows a sequential scan genuinely is the cheaper plan, so a
 * fixture of fifty rows would produce `Seq Scan` whatever the index says and
 * prove nothing. 60 000 rows belong to other people and 4 000 to the reader,
 * which is the shape a province's second season produces.
 *
 * **Plans, not timings**: a millisecond threshold on a shared box measures the
 * box, and `Seq Scan on notifications` is the exact fact that stops being true
 * as the deployment grows.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Db } from '@duckoj/db';
import { withTestDb } from './db.harness.js';
import { insertUser } from './submissions.fixtures.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import type { Actor } from '../src/authz/actor.js';

/** Rows belonging to somebody else. */
const FOREIGN_ROWS = 60_000;
/** And to the person reading their own feed. */
const MINE = 4_000;

async function plan(db: Db, query: ReturnType<typeof sql>): Promise<string> {
  const rows = await db.execute<{ 'QUERY PLAN': string }>(sql`explain (analyze, costs off) ${query}`);
  return rows.map((row) => row['QUERY PLAN']).join('\n');
}

describe('the notification feed is bounded and indexed at scale', () => {
  it('reads the newest fifty and the unread count through notifications_user_idx, never the table', async () => {
    await withTestDb(async (db) => {
      const mine = await insertUser(db, 'plan-mine');
      const theirs = await insertUser(db, 'plan-theirs');

      // `generate_series` rather than a drizzle loop: sixty thousand round
      // trips would dominate the runtime of this file for no gain, and the
      // rows only have to exist. Half of the reader's are unread, so the
      // count below is answering a real question rather than an empty one.
      await db.execute(sql`
        insert into notifications (user_id, kind, payload, read_at)
        select ${theirs.id}, 'contest_announcement', '{}'::jsonb, null
          from generate_series(1, ${FOREIGN_ROWS})
      `);
      await db.execute(sql`
        insert into notifications (user_id, kind, payload, read_at)
        select ${mine.id}, 'contest_announcement', '{}'::jsonb,
               case when i % 2 = 0 then now() else null end
          from generate_series(1, ${MINE}) as i
      `);
      await db.execute(sql`analyze notifications`);

      const feed = await plan(
        db,
        sql`select * from notifications where user_id = ${mine.id} order by id desc limit 50`,
      );
      // Backward, because the feed is newest-first and the index is
      // `(user_id, id)` ascending — which is what makes "the newest fifty" a
      // fifty-row read rather than a sort of four thousand.
      expect(feed).toMatch(/Index Scan Backward using notifications_user_idx/);
      expect(feed).not.toMatch(/Seq Scan on notifications/);
      expect(feed).not.toMatch(/\bSort\b/);

      const unread = await plan(
        db,
        sql`select count(*) from notifications
             where user_id = ${mine.id} and read_at is null`,
      );
      expect(unread).toMatch(/notifications_user_idx/);
      expect(unread).not.toMatch(/Seq Scan on notifications/);

      // And the service itself answers, on this table, with the fifty the
      // contract promises and a count of the reader's own unread rows only —
      // sixty thousand of somebody else's are not in either number.
      const actor: Actor = { userId: mine.id, globalRole: 'user', via: 'session', scopes: [] };
      const page = await new NotificationsService(db).listFor(actor);
      expect(page.items).toHaveLength(50);
      expect(page.unreadCount).toBe(MINE / 2);
      expect(page.items.map((i) => i.id)).toEqual([...page.items.map((i) => i.id)].sort((a, b) => b - a));
    });
  }, 300_000);
});
