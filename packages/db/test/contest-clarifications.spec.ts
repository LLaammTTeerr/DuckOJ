/**
 * The two things the *table* promises, independent of any service (D31):
 * `visibility` starts `private`, and a row with neither a question nor an
 * answer is refused by the database rather than by whoever happened to be
 * calling.
 */
import { describe, expect, it } from 'vitest';
import { contestClarifications, contests } from '../src/schema/guarded.js';
import { schema } from '../src/index.js';
import { withTestDb } from './harness.js';
import type { Db } from '../src/index.js';

async function seed(db: Db): Promise<{ contestId: number; userId: number }> {
  const [user] = await db
    .insert(schema.users)
    .values({
      username: 'clar-asker',
      email: 'clar-asker@example.com',
      passwordHash: 'x',
      displayName: 'Asker',
    })
    .returning();
  const [contest] = await db
    .insert(contests)
    .values({
      key: 'clar-cup',
      name: 'Clarification Cup',
      startTime: new Date('2026-01-01T00:00:00Z'),
      endTime: new Date('2026-01-01T05:00:00Z'),
      format: 'default',
      createdBy: user!.id,
    })
    .returning();
  return { contestId: contest!.id, userId: user!.id };
}

describe('contest_clarifications schema', () => {
  it('a question defaults to private and carries no answer yet', async () => {
    await withTestDb(async (db) => {
      const { contestId, userId } = await seed(db);
      const [row] = await db
        .insert(contestClarifications)
        .values({ contestId, askedBy: userId, question: 'Is the array 1-indexed?' })
        .returning();

      expect(row?.visibility).toBe('private');
      expect(row?.answer).toBeNull();
      expect(row?.answeredBy).toBeNull();
      expect(row?.answeredAt).toBeNull();
      expect(row?.problemId).toBeNull();
    });
  }, 120_000);

  it('an announcement — answer text, no question — is a legal row', async () => {
    await withTestDb(async (db) => {
      const { contestId, userId } = await seed(db);
      const [row] = await db
        .insert(contestClarifications)
        .values({
          contestId,
          askedBy: userId,
          answer: 'Problem B has been rejudged.',
          answeredBy: userId,
          answeredAt: new Date(),
          visibility: 'public',
        })
        .returning();

      expect(row?.question).toBeNull();
      expect(row?.visibility).toBe('public');
    });
  }, 120_000);

  it('refuses a row with neither a question nor an answer', async () => {
    await withTestDb(async (db) => {
      const { contestId, userId } = await seed(db);
      // Drizzle wraps the driver error, so the constraint name lives on
      // `cause` — asserting it (rather than a bare `toThrow()`) is what
      // distinguishes "the CHECK fired" from "some other column complained".
      const error = await db
        .insert(contestClarifications)
        .values({ contestId, askedBy: userId })
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect(error).not.toBeNull();
      const cause = (error as { cause?: { constraint_name?: string } }).cause;
      expect(cause?.constraint_name).toBe('contest_clarifications_text_ck');
    });
  }, 120_000);
});
