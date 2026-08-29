import { asc, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { problemTags, problems } from '../src/schema/guarded.js';
import { schema, type Db } from '../src/index.js';
import { withTestDb } from './harness.js';

/**
 * Migration 0018's claims, asserted against a real migrated database rather
 * than against the drizzle schema object: the seeded vocabulary, the
 * difficulty CHECK, and `problem_tags`' delete rules (cascade from a
 * problem, restrict from a tag).
 *
 * Every "this must be refused" assertion goes through `expectRejected`.
 * `withTestDb` runs the whole test inside one transaction it rolls back, and
 * a constraint violation aborts that transaction outright — every later
 * statement then fails with `25P02` instead of testing anything. Running the
 * doomed statement inside a nested transaction (a SAVEPOINT) confines the
 * abort to it, so a test can assert both halves of a rule.
 */
async function expectRejected(db: Db, run: (tx: Db) => Promise<unknown>): Promise<void> {
  await expect(
    db.transaction(async (tx) => {
      await run(tx as unknown as Db);
    }),
  ).rejects.toThrow();
}

async function insertUser(db: Db, username: string) {
  const [user] = await db
    .insert(schema.users)
    .values({
      username,
      email: `${username}@example.com`,
      passwordHash: 'x',
      displayName: username,
    })
    .returning();
  return user!;
}

describe('tags schema and seed (migration 0018)', () => {
  it('seeds the standard olympiad vocabulary, slugs unique and both names filled', async () => {
    await withTestDb(async (db) => {
      const rows = await db.select().from(schema.tags).orderBy(asc(schema.tags.slug));

      expect(rows.length).toBe(25);
      expect(new Set(rows.map((r) => r.slug)).size).toBe(25);
      // A handful pinned by value: these slugs are API surface (`?tag=`),
      // so a rename is a breaking change and must red a test, not pass one.
      expect(rows.map((r) => r.slug)).toContain('quy-hoach-dong');
      expect(rows.map((r) => r.slug)).toContain('do-thi');
      expect(rows.find((r) => r.slug === 'do-thi')).toMatchObject({
        nameVi: 'Đồ thị',
        nameEn: 'Graphs',
      });
      for (const row of rows) {
        expect(row.nameVi.trim(), `${row.slug} has no Vietnamese name`).not.toBe('');
        expect(row.nameEn.trim(), `${row.slug} has no English name`).not.toBe('');
        // Decomposed diacritics render identically and break every
        // comparison downstream — the same rule `i18n.spec.tsx` enforces on
        // the web catalogues, enforced here on the data.
        expect(row.nameVi.normalize('NFC'), `${row.slug} is not NFC`).toBe(row.nameVi);
      }
    });
  }, 120_000);

  it('refuses a difficulty outside 1..10, and accepts null', async () => {
    await withTestDb(async (db) => {
      const user = await insertUser(db, 'diff-setter');
      const insert = (tx: Db, code: string, difficulty: number | null) =>
        tx.insert(problems).values({ code, name: code, statement: 's', difficulty, createdBy: user.id });

      await expectRejected(db, (tx) => insert(tx, 'd-zero', 0));
      await expectRejected(db, (tx) => insert(tx, 'd-eleven', 11));
      await expectRejected(db, (tx) => insert(tx, 'd-negative', -3));
      await insert(db, 'd-null', null);
      await insert(db, 'd-one', 1);
      await insert(db, 'd-ten', 10);

      const kept = await db.select({ code: problems.code }).from(problems).orderBy(asc(problems.code));
      expect(kept.map((r) => r.code)).toEqual(['d-null', 'd-one', 'd-ten']);
    });
  }, 120_000);

  it('cascades problem_tags from a deleted problem but refuses to drop a tag still in use', async () => {
    await withTestDb(async (db) => {
      const user = await insertUser(db, 'tagger');
      const [problem] = await db
        .insert(problems)
        .values({ code: 'tagged', name: 'Tagged', statement: 's', createdBy: user.id })
        .returning();
      const [tag] = await db.select().from(schema.tags).where(eq(schema.tags.slug, 'do-thi'));
      await db.insert(problemTags).values({ problemId: problem!.id, tagId: tag!.id });

      // A tag still carried by a problem may not be deleted — dropping one
      // would silently untag content instead of failing loudly.
      await expectRejected(db, (tx) => tx.delete(schema.tags).where(eq(schema.tags.id, tag!.id)));

      await db.delete(problems).where(eq(problems.id, problem!.id));
      expect(await db.select().from(problemTags)).toEqual([]);
      // ...and the tag itself survives its last problem.
      expect(await db.select().from(schema.tags).where(eq(schema.tags.id, tag!.id))).toHaveLength(1);
    });
  }, 120_000);

  it('refuses the same tag twice on one problem', async () => {
    await withTestDb(async (db) => {
      const user = await insertUser(db, 'dup-tagger');
      const [problem] = await db
        .insert(problems)
        .values({ code: 'dup', name: 'Dup', statement: 's', createdBy: user.id })
        .returning();
      const [tag] = await db.select().from(schema.tags).where(eq(schema.tags.slug, 'cay'));
      await db.insert(problemTags).values({ problemId: problem!.id, tagId: tag!.id });

      await expectRejected(db, (tx) =>
        tx.insert(problemTags).values({ problemId: problem!.id, tagId: tag!.id }),
      );

      const count = await db.select({ n: sql<number>`count(*)::int` }).from(problemTags);
      expect(count[0]!.n).toBe(1);
    });
  }, 120_000);
});
