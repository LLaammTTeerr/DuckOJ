/**
 * `GET /orgs/{slug}/teams` reads from the NEW end of the list (D177), and its
 * cursor still walks every row exactly once.
 *
 * **The defect this pins.** The list was `ORDER BY teams.id ASC` — oldest
 * first — with a page of twenty-five. In a school with more than twenty-five
 * teams, the team a teacher had just assembled was on the LAST page, which is
 * the one row they had opened the panel to look at. F-48's organiser walk
 * found it the hard way: a fortnight of runs left twenty-seven teams in one
 * shared school and the walk's own team fell off the page it navigates to.
 *
 * **Why both halves are asserted here.** Reversing the order without
 * reversing the seek is the failure mode that matters — `ORDER BY id DESC`
 * paired with `id > cursor` serves page one forever — and it is invisible
 * from page one alone. So the walk below collects every page and asserts the
 * union is the whole school with no repeats, which is the property a keyset
 * exists to have.
 *
 * The fixture is sixty teams because the point is a school PAST the page
 * size; at twenty-four teams every ordering looks the same and this file
 * would prove nothing.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { organizations, teams } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin } from './submissions.fixtures.js';

/** Past the 25-row page, and far enough past it to need three pages. */
const TEAM_COUNT = 60;
const SLUG = 'thpt-nhieu-doi';

type Agent = ReturnType<typeof request.agent>;

interface Row {
  slug: string;
  name: string;
}

/** A school whose owner is a plain teacher, with `TEAM_COUNT` teams in it. */
async function seedSchool(app: Awaited<ReturnType<typeof buildApp>>, db: Db): Promise<Agent> {
  const root = request.agent(app.getHttpServer());
  await registerAndLogin(root, 'nhieu-doi-root');
  await db
    .update(schema.users)
    .set({ globalRole: 'admin' })
    .where(eq(schema.users.username, 'nhieu-doi-root'));
  const created = await root
    .post('/api/v1/orgs')
    .send({ slug: SLUG, name: SLUG, visibility: 'public', joinPolicy: 'invite' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);

  const teacher = request.agent(app.getHttpServer());
  await registerAndLogin(teacher, 'nhieu-doi-teacher');
  const owner = await root
    .post(`/api/v1/orgs/${SLUG}/members`)
    .send({ username: 'nhieu-doi-teacher', role: 'owner' });
  expect(owner.status, JSON.stringify(owner.body)).toBe(201);

  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, SLUG));
  const [author] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, 'nhieu-doi-root'));
  // Inserted in one statement, so every row shares `created_at` to the
  // microsecond — which is exactly why the cursor is the id and not the
  // instant, and why this fixture would break a `created_at` keyset.
  await db.insert(teams).values(
    Array.from({ length: TEAM_COUNT }, (_, index) => ({
      orgId: org!.id,
      slug: `doi-${String(index + 1).padStart(2, '0')}`,
      name: `Đội ${String(index + 1)}`,
      createdBy: author!.id,
    })),
  );
  return teacher;
}

/** Every page of the list, walked through its own `nextCursor`. */
async function walk(agent: Agent, limit: number): Promise<{ rows: Row[]; pages: number }> {
  const rows: Row[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const url =
      cursor === null
        ? `/api/v1/orgs/${SLUG}/teams?limit=${String(limit)}`
        : `/api/v1/orgs/${SLUG}/teams?limit=${String(limit)}&cursor=${encodeURIComponent(cursor)}`;
    const page = await agent.get(url);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    rows.push(...(page.body.items as Row[]));
    cursor = page.body.nextCursor as string | null;
    pages += 1;
    expect(pages, 'the walk did not terminate').toBeLessThan(20);
  } while (cursor !== null);
  return { rows, pages };
}

describe('GET /orgs/{slug}/teams — newest first, walked whole (D177)', () => {
  it('puts the team a teacher just assembled on page ONE', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const teacher = await seedSchool(app, db);

        // The team made last, after the school is already past a page.
        const made = await teacher
          .post(`/api/v1/orgs/${SLUG}/teams`)
          .send({ slug: 'doi-vua-lap', name: 'Đội vừa lập', members: [] });
        expect(made.status, JSON.stringify(made.body)).toBe(201);

        const page = await teacher.get(`/api/v1/orgs/${SLUG}/teams`);
        expect(page.status).toBe(200);
        expect(page.body.items).toHaveLength(25);
        // FIRST row, not merely "somewhere on the page": the panel is read
        // from the top and this is the row the teacher came for.
        expect(page.body.items[0].slug).toBe('doi-vua-lap');
        // And the oldest team is NOT on page one any more, which is the half
        // of the change that would otherwise pass unnoticed.
        expect((page.body.items as Row[]).map((row) => row.slug)).not.toContain('doi-01');
      } finally {
        await app.close();
      }
    });
  });

  it('walks every team exactly once, and the whole school is reachable', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const teacher = await seedSchool(app, db);
        const { rows, pages } = await walk(teacher, 25);

        expect(pages).toBe(3);
        expect(rows).toHaveLength(TEAM_COUNT);
        // No repeats — the failure a mismatched seek produces.
        expect(new Set(rows.map((row) => row.slug)).size).toBe(TEAM_COUNT);
        // No gaps — the other failure it produces.
        expect(new Set(rows.map((row) => row.slug))).toEqual(
          new Set(
            Array.from({ length: TEAM_COUNT }, (_, i) => `doi-${String(i + 1).padStart(2, '0')}`),
          ),
        );
        // Descending across page boundaries, not merely within a page.
        expect(rows[0]!.slug).toBe('doi-60');
        expect(rows.at(-1)!.slug).toBe('doi-01');
      } finally {
        await app.close();
      }
    });
  });

  /**
   * D182 — the page carries every roster on it, so the panel needs no second
   * request per row.
   *
   * The N+1 this removes, measured by F-49: one screen of twenty-five teams
   * was 26 HTTP requests and 181 statements (≈20 ms), each detail
   * re-resolving the session and re-running the org visibility gate before it
   * answered — against ONE statement at 0.175 ms for every roster on the
   * page. `memberCount` is now derived from the array rather than counted
   * separately, which is what makes the two incapable of disagreeing.
   */
  it('carries every roster on the page, and a count that agrees with it', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const teacher = await seedSchool(app, db);
        const made = await teacher
          .post(`/api/v1/orgs/${SLUG}/teams`)
          .send({ slug: 'doi-co-nguoi', name: 'Đội có người', members: ['nhieu-doi-teacher'] });
        expect(made.status, JSON.stringify(made.body)).toBe(201);

        const page = await teacher.get(`/api/v1/orgs/${SLUG}/teams`);
        expect(page.status).toBe(200);
        const rows = page.body.items as { slug: string; memberCount: number; members: unknown[] }[];
        // EVERY row, not just the one with a member on it: a summary that
        // carries the array for some rows and not others is the same N+1 with
        // a harder-to-find edge.
        for (const row of rows) {
          expect(Array.isArray(row.members), `${row.slug} has no roster`).toBe(true);
          expect(row.members).toHaveLength(row.memberCount);
        }
        const seeded = rows.find((row) => row.slug === 'doi-co-nguoi');
        expect(seeded?.members).toEqual([
          expect.objectContaining({ username: 'nhieu-doi-teacher' }),
        ]);
      } finally {
        await app.close();
      }
    });
  });

  it('walks the same rows at a page size the caller chose', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const teacher = await seedSchool(app, db);
        const wide = await walk(teacher, 25);
        const narrow = await walk(teacher, 7);
        expect(narrow.pages).toBe(9);
        expect(narrow.rows.map((row) => row.slug)).toEqual(wide.rows.map((row) => row.slug));
      } finally {
        await app.close();
      }
    });
  });

  it('refuses a cursor this list could not have issued', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const teacher = await seedSchool(app, db);
        for (const cursor of ['abc', '-1', '1.5', '1_2']) {
          const page = await teacher.get(
            `/api/v1/orgs/${SLUG}/teams?cursor=${encodeURIComponent(cursor)}`,
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
