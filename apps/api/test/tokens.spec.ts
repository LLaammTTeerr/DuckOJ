import { describe, expect, it } from 'vitest';
import { schema, type Db } from '@qhhoj/db';
import { TokenService } from '../src/authn/token.service.js';
import { withTestDb } from './db.harness.js';

async function makeUser(db: Db, username: string): Promise<number> {
  const [user] = await db
    .insert(schema.users)
    .values({ username, email: `${username}@e.com`, passwordHash: 'x', displayName: username })
    .returning();
  return user!.id;
}

describe('TokenService', () => {
  it('issues a token that resolves to a token-backed actor', async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db, 'quin');
      const service = new TokenService(db);
      const { token } = await service.issue(userId, 'cli', ['submissions:write']);

      const actor = await service.resolve(token);
      expect(actor?.userId).toBe(userId);
      expect(actor?.via).toBe('token');
      expect(actor?.scopes).toEqual(['submissions:write']);
    });
  }, 120_000);

  it('stores only a hash', async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db, 'rosa');
      const service = new TokenService(db);
      const { token } = await service.issue(userId, 'cli', []);
      const rows = await db.select().from(schema.accessTokens);
      expect(rows[0]?.tokenHash).not.toBe(token);
    });
  }, 120_000);

  it('returns null for a revoked token', async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db, 'sami');
      const service = new TokenService(db);
      const { id, token } = await service.issue(userId, 'cli', []);
      await service.revoke(userId, id);
      expect(await service.resolve(token)).toBeNull();
    });
  }, 120_000);

  it('returns null for an expired token', async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db, 'tara');
      const service = new TokenService(db);
      const { token } = await service.issue(userId, 'cli', [], new Date(Date.now() - 1000));
      expect(await service.resolve(token)).toBeNull();
    });
  }, 120_000);

  it('does not let one user revoke another user\'s token', async () => {
    await withTestDb(async (db) => {
      const owner = await makeUser(db, 'uma');
      const other = await makeUser(db, 'vlad');
      const service = new TokenService(db);
      const { id, token } = await service.issue(owner, 'cli', []);
      await service.revoke(other, id);
      expect(await service.resolve(token)).not.toBeNull();
    });
  }, 120_000);
});
