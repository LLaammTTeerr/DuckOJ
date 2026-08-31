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
/** A call, not a mention: the prose above and in `redis.harness.ts` says
 *  "flushdb" a dozen times and none of those wipe anything. */
const WIPE_CALL = /\.flush(?:db|all)\s*\(/;
/** This file quotes both patterns; scanning itself would be circular. */
const SELF = 'redis-db-assignments.spec.ts';

function specs(): { file: string; source: string }[] {
  return readdirSync(TEST_DIR)
    .filter((name) => name.endsWith('.spec.ts') && name !== SELF)
    .map((file) => ({ file, source: readFileSync(join(TEST_DIR, file), 'utf8') }));
}

function assignments(): { file: string; db: number }[] {
  return specs().flatMap(({ file, source }) => {
    const match = ASSIGNMENT.exec(source);
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

  // The assertion above can only see specs that DECLARE the constant, which
  // is the hole B-35 fell into: `problem-stats.spec.ts` wiped Redis through
  // an inline `ensureRedisUrl(2)` and was invisible here, so a second spec
  // claiming 2 would have collided in silence — the exact failure the guard
  // exists to prevent, reintroduced by writing a number instead of a name.
  it('names its database, so the assertion above can see it', () => {
    const undeclared = specs()
      .filter(({ source }) => WIPE_CALL.test(source) && !ASSIGNMENT.test(source))
      .map(({ file }) => file);
    expect(
      undeclared,
      'these specs wipe Redis without `const REDIS_DB = <n>;` — declare one (and pass it to `ensureRedisUrl`) so collisions are detectable',
    ).toEqual([]);
  });

  // `flushall` ignores the SELECT and empties every logical database at once,
  // which is precisely what the per-spec numbering exists to stop. Nothing in
  // the suite has any use for it.
  it('wipes its own database only, never the whole server', () => {
    const global = specs()
      .filter(({ source }) => /\.flushall\s*\(/.test(source))
      .map(({ file }) => file);
    expect(global, 'use `flushdb` on this spec’s own logical database').toEqual([]);
  });
});
