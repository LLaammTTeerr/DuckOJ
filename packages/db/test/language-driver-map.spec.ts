import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { loadDriverLanguageMap, schema } from '../src/index.js';
import { withTestDb } from './harness.js';

/**
 * F-47 / D172, D173 — `loadDriverLanguageMap`, against the real table.
 *
 * The incident this file exists for, in full: on 2026-09-01 migration 0046
 * seeded `pascal -> PAS` against a **running** `judged`. The judge had
 * self-tested `PAS` and announced it. The map had been read at boot, before
 * the row existed, so the lookup missed and `executorToLanguage` fell back to
 * **lowercasing the executor name**. `PAS` became `pas`; no language has that
 * key; every Pascal submission was blocked against a judge that could in fact
 * run it, and `judged` reported its supported languages as
 * `["c11","cpp14","cpp17","cpp20","java","pas","python3"]` — a list that
 * looks entirely plausible and is wrong by one character.
 *
 * Two properties, one per half of the defect:
 *
 *  1. an executor no row names resolves to **nothing**, never to a
 *     manufactured key (D172);
 *  2. `reload()` picks up a row inserted after the load, and says whether
 *     anything moved (D173).
 */
describe('loadDriverLanguageMap (F-47)', () => {
  it('maps both directions for a seeded language', async () => {
    await withTestDb(async (db) => {
      const map = await loadDriverLanguageMap(db, 'dmoj');
      expect(map.languageToExecutor('python3')).toBe('PY3');
      expect(map.executorToLanguage('PY3')).toBe('python3');
      expect(map.executorToLanguage('PAS')).toBe('pascal');
    });
  });

  it('answers undefined for an executor no language names, and never lowercases it', async () => {
    await withTestDb(async (db) => {
      const map = await loadDriverLanguageMap(db, 'dmoj');
      // Real executors this image announces and this deployment has no row
      // for. `AWK`/`SED`/`TEXT` ship with judge-server; `JAVA8` is in the
      // image and fails its own self-test (F-46), so nothing maps to it.
      for (const executor of ['AWK', 'SED', 'TEXT', 'JAVA8', 'NODEJS']) {
        expect(map.executorToLanguage(executor)).toBeUndefined();
      }
    });
  });

  it('ignores another driver’s rows entirely', async () => {
    await withTestDb(async (db) => {
      const [python] = await db
        .select({ id: schema.languages.id })
        .from(schema.languages)
        .where(eq(schema.languages.key, 'python3'));
      await db
        .insert(schema.languageDriverKeys)
        .values({ languageId: python!.id, driver: 'not-dmoj', executorKey: 'PYTHON' });

      const map = await loadDriverLanguageMap(db, 'dmoj');
      expect(map.executorToLanguage('PYTHON')).toBeUndefined();
    });
  });

  it('reload() picks up a language seeded after the map was read (D173)', async () => {
    await withTestDb(async (db) => {
      // The state `judged` was in at 0046: a map read before the row landed.
      await db.execute(sql`delete from language_driver_keys where executor_key = 'PAS'`);
      await db.execute(sql`delete from languages where key = 'pascal'`);

      const map = await loadDriverLanguageMap(db, 'dmoj');
      expect(map.executorToLanguage('PAS')).toBeUndefined();

      // Nothing changed, so nothing to act on — this is what stops the claim
      // loop re-announcing capabilities every five seconds forever.
      expect(await map.reload()).toBe(false);

      const [pascal] = await db
        .insert(schema.languages)
        .values({ key: 'pascal', name: 'Pascal', extension: 'pas' })
        .returning({ id: schema.languages.id });
      await db
        .insert(schema.languageDriverKeys)
        .values({ languageId: pascal!.id, driver: 'dmoj', executorKey: 'PAS' });

      expect(await map.reload()).toBe(true);
      expect(map.executorToLanguage('PAS')).toBe('pascal');
      expect(map.languageToExecutor('pascal')).toBe('PAS');
      // Idempotent: a second reload over the same rows reports no change.
      expect(await map.reload()).toBe(false);
    });
  });

  it('reload() notices a row that disappeared, not only one that appeared', async () => {
    await withTestDb(async (db) => {
      const map = await loadDriverLanguageMap(db, 'dmoj');
      expect(map.executorToLanguage('PAS')).toBe('pascal');

      await db.execute(sql`delete from language_driver_keys where executor_key = 'PAS'`);

      expect(await map.reload()).toBe(true);
      expect(map.executorToLanguage('PAS')).toBeUndefined();
      // And the inverse went with it, in the same swap — the pair can never
      // be observed half-updated (D68).
      expect(map.languageToExecutor('pascal')).toBe('PASCAL');
    });
  });
});
