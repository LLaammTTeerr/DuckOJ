/**
 * `GET /orgs` is read by NAME, so it is served by name (D186).
 *
 * **The defect this pins.** The list was `ORDER BY organizations.id ASC` —
 * the order the province's schools happened to be created in — and F-49's
 * sweep called it "the one list whose reader's order genuinely is not the
 * served order". Nobody opens a list of schools to see which was registered
 * first; they open it to find theirs. F-50 gave it a "load more" button and
 * deliberately did not touch the order, because fixing the order needs a
 * second cursor grammar over a textual column, which is what this is.
 *
 * **Why the whole walk is collected.** A keyset over a textual key gets one
 * of two things wrong and neither is visible from page one: an order and a
 * seek that disagree serve page one forever, and a seek without the tiebreak
 * its order carries can skip a row or repeat it. So every page below is
 * walked through its own `nextCursor` and the union is checked against the
 * whole set, sorted, with no gaps and no repeats — the property a keyset
 * exists to have.
 *
 * The fixture is forty schools with slugs that DO NOT sort in creation order.
 * At fewer than a page, or in a fixture where the two orders agree, this file
 * would pass against the code it was written to red.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { organizations } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin } from './submissions.fixtures.js';

type Agent = ReturnType<typeof request.agent>;

/**
 * Forty schools whose alphabetical order is the REVERSE of their id order,
 * so an id-ordered server and a name-ordered one cannot both pass.
 */
const SCHOOLS = Array.from({ length: 40 }, (_, i) => ({
  slug: `truong-${String(40 - i).padStart(2, '0')}`,
  name: `THPT số ${String(40 - i)}`,
}));

async function seed(app: Awaited<ReturnType<typeof buildApp>>, db: Db): Promise<Agent> {
  const root = request.agent(app.getHttpServer());
  await registerAndLogin(root, 'orgs-order-root');
  await db
    .update(schema.users)
    .set({ globalRole: 'admin' })
    .where(eq(schema.users.username, 'orgs-order-root'));
  // Inserted directly and in creation order, so `id` ascends while `slug`
  // descends — the whole point of the fixture.
  await db.insert(organizations).values(
    SCHOOLS.map((s) => ({ slug: s.slug, name: s.name, visibility: 'public' as const, joinPolicy: 'request' as const })),
  );
  return root;
}

/** Every page, walked through the cursor the server itself issued. */
async function walk(agent: Agent, limit: number): Promise<{ slugs: string[]; pages: number }> {
  const slugs: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const url =
      cursor === null
        ? `/api/v1/orgs?limit=${String(limit)}`
        : `/api/v1/orgs?limit=${String(limit)}&cursor=${encodeURIComponent(cursor)}`;
    const page = await agent.get(url);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    slugs.push(...(page.body.items as { slug: string }[]).map((o) => o.slug));
    cursor = page.body.nextCursor as string | null;
    pages += 1;
    expect(pages, 'the walk did not terminate').toBeLessThan(20);
  } while (cursor !== null);
  return { slugs, pages };
}

describe('GET /orgs — alphabetical, walked whole (D186)', () => {
  it('puts the first school alphabetically on page ONE, not the oldest', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const root = await seed(app, db);
        const first = await root.get('/api/v1/orgs?limit=5');
        expect(first.status, JSON.stringify(first.body)).toBe(200);
        expect((first.body.items as { slug: string }[]).map((o) => o.slug)).toEqual([
          'truong-01',
          'truong-02',
          'truong-03',
          'truong-04',
          'truong-05',
        ]);
        // `truong-01` was the LAST row inserted. Under the old ordering it
        // was on page eight of a forty-school province.
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('walks every school exactly once, at two different page sizes', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const root = await seed(app, db);
        const expected = [...SCHOOLS.map((s) => s.slug)].sort();

        const small = await walk(root, 7);
        expect(small.pages).toBe(6);
        expect(small.slugs).toEqual(expected);
        expect(new Set(small.slugs).size).toBe(small.slugs.length);

        const big = await walk(root, 25);
        expect(big.pages).toBe(2);
        expect(big.slugs).toEqual(expected);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('issues a `<slug>_<id>` cursor, and refuses the id-only grammar it replaced', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const root = await seed(app, db);
        const first = await root.get('/api/v1/orgs?limit=3');
        expect(first.body.nextCursor).toMatch(/^truong-03_\d+$/);

        // A cursor a client held from before this change. It has no `_`, so
        // it cannot be mistaken for a slug and read as a position in a
        // completely different order — which is the one thing a stale cursor
        // must never do silently.
        for (const bad of ['53', '', 'truong-03_', '_7', 'truong-03_x', 'truong-03_-1']) {
          const res = await root.get(`/api/v1/orgs?limit=3&cursor=${encodeURIComponent(bad)}`);
          expect(res.status, `cursor ${JSON.stringify(bad)} was accepted`).toBe(422);
          expect(res.body.code).toBe('invalid_cursor');
        }
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
