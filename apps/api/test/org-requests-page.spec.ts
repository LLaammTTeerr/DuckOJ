/**
 * `GET /orgs/{slug}/requests` is bounded, and its cursor walks the queue in
 * the order a queue is worked (D181).
 *
 * **The defect this pins.** This was the ONE list in the API with no bound at
 * all: no `limit`, no cursor, no query parameters. It answered every pending
 * request a school held, and the web panel rendered every one of them into a
 * single `<table>` — for a school that opens enrolment to a province, 219 kB
 * of JSON and five thousand rows on the page a teacher opens to approve three
 * people (F-49 measured it; D179 recorded it).
 *
 * **The order is the other half of the ruling.** D177 flipped the teams list
 * to newest-first because a teacher tails it. A join queue is the opposite:
 * it is answered from its FRONT, oldest first, and that order is unchanged
 * here. What is asserted is that the cursor MATCHES it — `asc(id)` with a
 * `gt` seek — because a seek that disagrees with its order either serves page
 * one forever or skips rows, and neither is visible from page one alone.
 *
 * Sixty pending requests, because at twenty-four every ordering and every
 * seek look identical and this file would prove nothing.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { organizations, orgJoinRequests } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin } from './submissions.fixtures.js';

const PENDING = 60;
const SLUG = 'thpt-mo-tuyen-sinh';

type Agent = ReturnType<typeof request.agent>;
interface Row {
  id: number;
  username: string;
}

/**
 * A school with `PENDING` people waiting at its door.
 *
 * The requesters are inserted straight into `users` and `org_join_requests`
 * rather than driven through `POST /join` sixty times: this file is about the
 * shape of the READ, and sixty sign-ups would be sixty registrations, sixty
 * sessions and a minute of container time to prove nothing extra. One
 * `INSERT` also gives every row the same `created_at` to the microsecond,
 * which is precisely why the cursor is the id.
 */
async function seedQueue(app: Awaited<ReturnType<typeof buildApp>>, db: Db): Promise<Agent> {
  const owner = request.agent(app.getHttpServer());
  await registerAndLogin(owner, 'mo-tuyen-sinh-owner');
  await db
    .update(schema.users)
    .set({ globalRole: 'admin' })
    .where(eq(schema.users.username, 'mo-tuyen-sinh-owner'));
  const created = await owner
    .post('/api/v1/orgs')
    .send({ slug: SLUG, name: SLUG, visibility: 'public', joinPolicy: 'request' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);

  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, SLUG));

  const inserted = await db
    .insert(schema.users)
    .values(
      Array.from({ length: PENDING }, (_, i) => ({
        username: `hoc-sinh-${String(i + 1).padStart(2, '0')}`,
        email: `hoc-sinh-${String(i + 1).padStart(2, '0')}@example.test`,
        displayName: `Học sinh ${String(i + 1)}`,
        passwordHash: 'x',
      })),
    )
    .returning({ id: schema.users.id });
  await db.insert(orgJoinRequests).values(
    inserted.map((user) => ({ orgId: org!.id, userId: user.id, state: 'pending' as const })),
  );
  return owner;
}

/** Every page of the queue, walked through its own `nextCursor`. */
async function walk(agent: Agent, limit: number): Promise<{ rows: Row[]; pages: number }> {
  const rows: Row[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const url =
      cursor === null
        ? `/api/v1/orgs/${SLUG}/requests?limit=${String(limit)}`
        : `/api/v1/orgs/${SLUG}/requests?limit=${String(limit)}&cursor=${encodeURIComponent(cursor)}`;
    const page = await agent.get(url);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    rows.push(...(page.body.items as Row[]));
    cursor = page.body.nextCursor as string | null;
    pages += 1;
    expect(pages, 'the walk did not terminate').toBeLessThan(20);
  } while (cursor !== null);
  return { rows, pages };
}

describe('GET /orgs/{slug}/requests — a bounded FIFO queue (D181)', () => {
  it('answers a PAGE rather than the whole queue, oldest first', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await seedQueue(app, db);
        const page = await owner.get(`/api/v1/orgs/${SLUG}/requests`);
        expect(page.status).toBe(200);
        // The defect, said as a number: sixty pending, twenty-five answered.
        expect(page.body.items).toHaveLength(25);
        expect(page.body.nextCursor).not.toBeNull();
        // Front of the queue first — a decider answers the person who has
        // been waiting longest.
        expect((page.body.items as Row[])[0]!.username).toBe('hoc-sinh-01');
      } finally {
        await app.close();
      }
    });
  });

  it('walks every waiting person exactly once, with no gap and no repeat', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await seedQueue(app, db);
        const { rows, pages } = await walk(owner, 25);

        expect(pages).toBe(3);
        expect(rows).toHaveLength(PENDING);
        expect(new Set(rows.map((r) => r.username)).size).toBe(PENDING);
        // Ascending ACROSS page boundaries, not merely within a page: this is
        // the assertion a mismatched seek fails and page one cannot show.
        expect(rows.map((r) => r.id)).toEqual([...rows.map((r) => r.id)].sort((a, b) => a - b));
        expect(rows[0]!.username).toBe('hoc-sinh-01');
        expect(rows.at(-1)!.username).toBe('hoc-sinh-60');
      } finally {
        await app.close();
      }
    });
  });

  it('walks the same queue at a page size the caller chose', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await seedQueue(app, db);
        const wide = await walk(owner, 25);
        const narrow = await walk(owner, 7);
        expect(narrow.pages).toBe(9);
        expect(narrow.rows.map((r) => r.username)).toEqual(wide.rows.map((r) => r.username));
      } finally {
        await app.close();
      }
    });
  });

  it('refuses a cursor this list could not have issued', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await seedQueue(app, db);
        for (const cursor of ['abc', '-1', '1.5', '1_2']) {
          const page = await owner.get(
            `/api/v1/orgs/${SLUG}/requests?cursor=${encodeURIComponent(cursor)}`,
          );
          expect(page.status, `cursor ${cursor}`).toBe(422);
          expect(page.body.code).toBe('invalid_cursor');
        }
      } finally {
        await app.close();
      }
    });
  });
});
