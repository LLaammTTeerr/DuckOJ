/**
 * The homework export, bounded (D66 amended).
 *
 * F9 shipped the CSV as the WHOLE roster in one query and one array — the
 * documented exception to D58 — and its own report named the hole: 5,000
 * members × 200 problems is one owner-only response nothing ever measured.
 * The export still refuses to stop at a page (a file that ends after
 * twenty-five pupils is a file somebody would mark a class from), but it now
 * WALKS the roster in cursor pages and stops at a stated cap, saying so on
 * the last line.
 *
 * The bounds are injected, exactly as `MAX_SUBSCRIPTIONS` is: twenty
 * thousand rows cannot be built in a test, and a cap nobody can reach is a
 * cap nobody has tested.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import { schema, type Db } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin, seedProblemAndLanguage } from './submissions.fixtures.js';
import { PROGRESS_EXPORT_BOUNDS } from '../src/authz/problem-set.access.js';

type Agent = ReturnType<typeof request.agent>;

async function signIn(app: INestApplication, db: Db, name: string, admin = false): Promise<Agent> {
  const agent = request.agent(app.getHttpServer());
  await registerAndLogin(agent, name);
  if (admin) {
    await db.update(schema.users).set({ globalRole: 'admin' }).where(eq(schema.users.username, name));
  }
  return agent;
}

/** A school with `pupils` members plus its admin and its teacher-owner. */
async function seedClass(app: INestApplication, db: Db, slug: string, pupils: string[]) {
  const admin = await signIn(app, db, `${slug}-root`, true);
  expect(
    (await admin.post('/orgs').send({ slug, name: slug, visibility: 'public', joinPolicy: 'invite' }))
      .status,
  ).toBe(201);
  const teacher = await signIn(app, db, `${slug}-teacher`);
  await admin.post(`/orgs/${slug}/members`).send({ username: `${slug}-teacher`, role: 'owner' });
  for (const pupil of pupils) {
    await signIn(app, db, pupil);
    await admin.post(`/orgs/${slug}/members`).send({ username: pupil, role: 'member' });
  }
  expect(
    (
      await teacher
        .post(`/orgs/${slug}/sets`)
        .send({ slug: 'wk', name: 'Week 1', problems: [{ code: 'aplusb', points: 100 }] })
    ).status,
  ).toBe(201);
  return teacher;
}

/** Data lines only — the header off the front, the trailer left in place. */
function bodyLines(csv: string): string[] {
  return csv.trim().split('\n').slice(1);
}

describe('the progress CSV walks the roster and stops at a stated cap', () => {
  it('serves every member when the cap allows, in pages smaller than the class', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, {
        // Two members a page against a class of seven: a single-page export
        // would answer two rows and look perfectly well-formed.
        overrides: [{ provide: PROGRESS_EXPORT_BOUNDS, useValue: { pageSize: 2, rowCap: 100 } }],
      });
      try {
        await seedProblemAndLanguage(db);
        const teacher = await seedClass(app, db, 'wide', ['ann', 'ben', 'cyd', 'dia', 'eve']);
        const csv = await teacher.get('/orgs/wide/sets/wk/progress?format=csv');
        expect(csv.status).toBe(200);
        const lines = bodyLines(csv.text as string);
        // Five pupils, the teacher and the admin who created the school.
        expect(lines).toHaveLength(7);
        expect(lines.some((line) => line.startsWith('truncated'))).toBe(false);
        // Ordered by username, once each — the walk cannot repeat a page.
        expect(new Set(lines).size).toBe(lines.length);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('stops at the cap and says so on the last line', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, {
        overrides: [{ provide: PROGRESS_EXPORT_BOUNDS, useValue: { pageSize: 2, rowCap: 3 } }],
      });
      try {
        await seedProblemAndLanguage(db);
        const teacher = await seedClass(app, db, 'capped', ['ann', 'ben', 'cyd', 'dia', 'eve']);
        const csv = await teacher.get('/orgs/capped/sets/wk/progress?format=csv');
        expect(csv.status).toBe(200);
        const lines = bodyLines(csv.text as string);
        // Three rows, then one line that is not a pupil.
        expect(lines).toHaveLength(4);
        expect(lines.at(-1)).toBe('truncated,3');
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('leaves the JSON grid a page, with the cursor that continues it', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const teacher = await seedClass(app, db, 'json', ['ann', 'ben', 'cyd']);
        const first = await teacher.get('/orgs/json/sets/wk/progress?limit=2');
        expect(first.status).toBe(200);
        expect(first.body.rows).toHaveLength(2);
        expect(first.body.nextCursor).not.toBeNull();
        const second = await teacher.get(
          `/orgs/json/sets/wk/progress?limit=2&cursor=${encodeURIComponent(String(first.body.nextCursor))}`,
        );
        const seen = [...first.body.rows, ...second.body.rows].map(
          (row: { username: string }) => row.username,
        );
        expect(new Set(seen).size).toBe(seen.length);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});
