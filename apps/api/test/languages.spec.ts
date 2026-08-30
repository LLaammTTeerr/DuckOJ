import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { schema } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';

describe('GET /languages', () => {
  it('is reachable with no credentials at all', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const res = await request(app.getHttpServer()).get('/api/v1/languages');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ items: [] });
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
      await db.insert(schema.languages).values([
        { key: 'cpp17', name: 'C++17', extension: 'cpp', isActive: true },
        { key: 'py2', name: 'Python 2', extension: 'py', isActive: false },
      ]);
      const app = await buildApp(db);
      try {
        const res = await request(app.getHttpServer()).get('/api/v1/languages');
        expect(res.status).toBe(200);
        expect(res.body.items).toEqual([
          { key: 'cpp17', name: 'C++17', extension: 'cpp', isActive: true },
          { key: 'py2', name: 'Python 2', extension: 'py', isActive: false },
        ]);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
