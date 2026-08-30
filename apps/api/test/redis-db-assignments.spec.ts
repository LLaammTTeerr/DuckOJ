/**
 * Every spec that WIPES Redis must own its logical database.
 *
 * `redis.harness.ts` explains the hazard in full: one container is cached
 * across the whole run, vitest reuses a worker process across spec files, and
 * a `flushdb` from one file lands between another's write and the read that
 * asserts on it — the `expected 'miss' to be 'hit'` failure that reddened the
 * ritual once already. The fix was a logical database per spec, and it holds
 * only as long as nobody picks a number twice.
 *
 * `contest-results.spec.ts` and `problem-counts-cache.spec.ts` had both
 * picked **4**. The two wipe each other under whole-suite load and pass alone,
 * which is the least useful failure mode a suite has; nothing but this file
 * would ever have said so, because a collision is invisible in either file on
 * its own.
 *
 * Derived from the SOURCE rather than from a list restated here, exactly as
 * `cors-exposed-headers.spec.ts` derives its header list: a hand-kept
 * register of who owns which number is one more thing to forget to update.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TEST_DIR = new URL('.', import.meta.url).pathname;
const ASSIGNMENT = /^const REDIS_DB = (\d+);$/m;

function assignments(): { file: string; db: number }[] {
  return readdirSync(TEST_DIR)
    .filter((name) => name.endsWith('.spec.ts'))
    .flatMap((file) => {
      const match = ASSIGNMENT.exec(readFileSync(join(TEST_DIR, file), 'utf8'));
      return match ? [{ file, db: Number(match[1]) }] : [];
    });
}

describe('logical Redis databases are owned, not shared', () => {
  it('gives every flushing spec a database of its own', () => {
    const owned = assignments();
    // A floor, so deleting the constant from every spec cannot make this
    // pass vacuously.
    expect(owned.length).toBeGreaterThanOrEqual(4);

    const byDb = new Map<number, string[]>();
    for (const { file, db } of owned) byDb.set(db, [...(byDb.get(db) ?? []), file]);
    const shared = [...byDb.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([db, files]) => `${String(db)}: ${files.join(', ')}`);
    expect(shared).toEqual([]);

    // Never `0`: that is the database a bare connection URL selects, so it is
    // the one `buildAppWithRealtime` and any future unnumbered caller land
    // in. A spec that flushed it would wipe theirs.
    expect(owned.map(({ db }) => db).filter((db) => db === 0)).toEqual([]);
  });
});
