import { eq, isNull, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { problems } from '../src/schema/guarded.js';
import { schema, type Db } from '../src/index.js';
import { withTestDb } from './harness.js';

/**
 * Migration 0021's claims, asserted against a real migrated database rather
 * than against the drizzle schema object: two nullable columns on
 * `problems`, and the CHECK that makes "published" imply "has text".
 *
 * `expectRejected` runs the doomed statement inside a nested transaction (a
 * SAVEPOINT) for the reason `tags.spec.ts` documents at length: a constraint
 * violation aborts the enclosing transaction, and `withTestDb` is one
 * transaction for the whole test.
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
    .values({ username, email: `${username}@example.com`, passwordHash: 'x', displayName: username })
    .returning();
  return user!;
}

async function insertProblem(db: Db, code: string, createdBy: number) {
  const [problem] = await db
    .insert(problems)
    .values({ code, name: code, statement: 'statement', visibility: 'public', createdBy })
    .returning();
  return problem!;
}

describe('editorial columns (migration 0021)', () => {
  it('adds both columns nullable, so every pre-existing problem migrates into "no editorial"', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'ed-owner');
      const problem = await insertProblem(db, 'no-editorial', owner.id);

      expect(problem.editorial).toBeNull();
      expect(problem.editorialPublishedAt).toBeNull();

      const [found] = await db
        .select({ id: problems.id })
        .from(problems)
        .where(sql`${problems.id} = ${problem.id} and ${problems.editorial} is null`);
      expect(found).toBeDefined();
    });
  }, 120_000);

  it('stores a draft editorial with no published timestamp', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'ed-draft-owner');
      const problem = await insertProblem(db, 'draft-editorial', owner.id);

      await db.update(problems).set({ editorial: '# Lời giải' }).where(eq(problems.id, problem.id));

      const [row] = await db
        .select({ editorial: problems.editorial, publishedAt: problems.editorialPublishedAt })
        .from(problems)
        .where(eq(problems.id, problem.id));
      expect(row!.editorial).toBe('# Lời giải');
      expect(row!.publishedAt).toBeNull();
    });
  }, 120_000);

  it('refuses a published timestamp with no editorial text', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'ed-empty-owner');
      const problem = await insertProblem(db, 'empty-published', owner.id);

      // The CHECK, not the service: a psql session or an importer reaches
      // this table without passing `UpdateProblemRequest`, and a row with a
      // publish date and no text would promise a page that renders empty.
      await expectRejected(db, (tx) =>
        tx.update(problems).set({ editorialPublishedAt: new Date() }).where(eq(problems.id, problem.id)),
      );

      // And clearing the text out from under a published editorial is the
      // same illegal state reached from the other side.
      await db
        .update(problems)
        .set({ editorial: 'x', editorialPublishedAt: new Date() })
        .where(eq(problems.id, problem.id));
      await expectRejected(db, (tx) =>
        tx.update(problems).set({ editorial: null }).where(eq(problems.id, problem.id)),
      );

      // Unpublishing and clearing together is legal — that is what
      // `editorial: null` on a PATCH must compile to.
      await db
        .update(problems)
        .set({ editorial: null, editorialPublishedAt: null })
        .where(eq(problems.id, problem.id));
      const [row] = await db
        .select({ id: problems.id })
        .from(problems)
        .where(sql`${problems.id} = ${problem.id}`)
        .limit(1);
      expect(row).toBeDefined();
      const [stillNull] = await db
        .select({ id: problems.id })
        .from(problems)
        .where(isNull(problems.editorial));
      expect(stillNull).toBeDefined();
    });
  }, 120_000);
});
