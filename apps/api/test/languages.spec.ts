import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { schema } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';

interface LanguageRow {
  key: string;
  name: string;
  extension: string;
  isActive: boolean;
  timeMultiplierPct: number;
  memoryExtraKb: number;
}

function byKey(items: LanguageRow[], key: string): LanguageRow | undefined {
  return items.find((item) => item.key === key);
}

describe('GET /languages', () => {
  // This used to assert `{ items: [] }` — true only while `languages` was a
  // table migrations left empty and `scripts/seed-problem.ts` filled. Since
  // 0042 the catalogue is seeded BY a migration (F-39/D154), so a migrated
  // database has five rows and an empty answer would mean the seed did not
  // run. The route's public reachability is what this test is about, and it
  // is asserted the same way it always was: a 200 with no credentials.
  it('is reachable with no credentials at all, and answers the seeded catalogue', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const res = await request(app.getHttpServer()).get('/api/v1/languages');
        expect(res.status).toBe(200);
        expect((res.body.items as LanguageRow[]).map((item) => item.key)).toEqual([
          'c11',
          'cpp14',
          'cpp17',
          'cpp20',
          'python3',
        ]);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  // D154 — the multiplier is on the wire, not a server constant. A pupil
  // whose Python submission is graded against 3× the authored limit must be
  // able to learn that from the API; a limit the judge enforces and the API
  // will not name is not a limit, it is a surprise.
  it('carries each language its own time multiplier and memory floor', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const res = await request(app.getHttpServer()).get('/api/v1/languages');
        const items = res.body.items as LanguageRow[];
        expect(byKey(items, 'python3')).toEqual({
          key: 'python3',
          name: 'Python 3',
          extension: 'py',
          isActive: true,
          timeMultiplierPct: 300,
          memoryExtraKb: 32_768,
        });
        // C++ is the language the limits were authored against, so it is the
        // one the adjustment must leave alone.
        expect(byKey(items, 'cpp17')).toMatchObject({ timeMultiplierPct: 100, memoryExtraKb: 0 });
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  // Spec §2.1: inactive languages are included, flagged via `isActive`, not
  // omitted. `POST /submissions` already 404s `language_not_found` for a
  // deactivated key (submissions.spec.ts), so a submission made against it
  // last year still needs this route to render its name today — an omitted
  // row would force every consumer to cope with a dangling `languageKey`.
  it('lists an inactive language, flagged rather than hidden', async () => {
    await withTestDb(async (db) => {
      // `py2` is deliberately NOT one of the five 0042 seeds: this asserts
      // the flagging rule, which needs a row no migration is going to
      // activate underneath it.
      await db
        .insert(schema.languages)
        .values({ key: 'py2', name: 'Python 2', extension: 'py', isActive: false });
      const app = await buildApp(db);
      try {
        const res = await request(app.getHttpServer()).get('/api/v1/languages');
        expect(res.status).toBe(200);
        const items = res.body.items as LanguageRow[];
        expect(byKey(items, 'py2')).toMatchObject({ name: 'Python 2', isActive: false });
        // Ordered by key throughout, seeded rows and inserted ones alike.
        expect(items.map((item) => item.key)).toEqual([
          'c11',
          'cpp14',
          'cpp17',
          'cpp20',
          'py2',
          'python3',
        ]);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
