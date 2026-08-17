import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { schema } from '../src/index.js';
import { withTestDb } from './harness.js';

describe('identity schema', () => {
  it('stores and reads back a user', async () => {
    await withTestDb(async (db) => {
      const [inserted] = await db
        .insert(schema.users)
        .values({
          username: 'alice',
          email: 'alice@example.com',
          passwordHash: 'argon2id$placeholder',
          displayName: 'Alice',
        })
        .returning();

      expect(inserted?.globalRole).toBe('user');
      expect(inserted?.status).toBe('active');
      expect(inserted?.rating).toBeNull();

      const found = await db.query.users.findFirst({
        where: eq(schema.users.username, 'alice'),
      });
      expect(found?.email).toBe('alice@example.com');
    });
  }, 120_000);

  it('rejects a duplicate username differing only in case', async () => {
    await withTestDb(async (db) => {
      const base = { passwordHash: 'x', displayName: 'X' };
      await db.insert(schema.users).values({ ...base, username: 'bob', email: 'b@example.com' });
      await expect(
        db.insert(schema.users).values({ ...base, username: 'BOB', email: 'b2@example.com' }),
      ).rejects.toThrow();
    });
  }, 120_000);
});
