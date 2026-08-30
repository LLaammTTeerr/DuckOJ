import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import { problemTags, problems } from '@duckoj/db/guarded';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { insertUser } from './submissions.fixtures.js';

async function seedTagged(db: Db, code: string, slugs: string[], difficulty: number | null): Promise<void> {
  const owner = await insertUser(db, `${code}-owner`);
  const [problem] = await db
    .insert(problems)
    .values({ code, name: code, statement: 's', visibility: 'public', difficulty, createdBy: owner.id })
    .returning();
  if (slugs.length > 0) {
    const rows = await db.select().from(schema.tags).where(inArray(schema.tags.slug, slugs));
    await db.insert(problemTags).values(rows.map((t) => ({ problemId: problem!.id, tagId: t.id })));
  }
}

describe('GET /tags', () => {
  it('serves the whole seeded vocabulary with no credentials at all', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const res = await request(app.getHttpServer()).get('/api/v1/tags');
        expect(res.status).toBe(200);
        expect(res.body.items).toHaveLength(25);
        // Ordered by slug, so the filter bar and a problem's chip row agree.
        const slugs = res.body.items.map((t: { slug: string }) => t.slug);
        expect(slugs).toEqual([...slugs].sort());
        expect(res.body.items).toContainEqual({ slug: 'do-thi', nameVi: 'Đồ thị', nameEn: 'Graphs' });
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('GET /problems?tag=', () => {
  it('accepts the parameter repeated, and ANDs it', async () => {
    await withTestDb(async (db) => {
      await seedTagged(db, 'both', ['do-thi', 'quy-hoach-dong'], 5);
      await seedTagged(db, 'one', ['do-thi'], 2);
      const app = await buildApp(db);
      try {
        // Express hands a single `?tag=` over as a bare string and a repeated
        // one as an array; `ProblemListQueryParse` normalises both, which is
        // the whole reason it exists beside `ProblemListQuery`.
        const single = await request(app.getHttpServer()).get('/api/v1/problems?tag=do-thi');
        expect(single.status).toBe(200);
        expect(single.body.items.map((p: { code: string }) => p.code).sort()).toEqual(['both', 'one']);

        const paired = await request(app.getHttpServer()).get('/api/v1/problems?tag=do-thi&tag=quy-hoach-dong');
        expect(paired.status).toBe(200);
        expect(paired.body.items.map((p: { code: string }) => p.code)).toEqual(['both']);

        const ranged = await request(app.getHttpServer()).get('/api/v1/problems?difficultyMin=3&difficultyMax=8');
        expect(ranged.body.items.map((p: { code: string }) => p.code)).toEqual(['both']);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses a difficulty bound outside 1..10 with 422', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const res = await request(app.getHttpServer()).get('/api/v1/problems?difficultyMin=0');
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('validation_failed');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
