import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { schema, type Db } from '@duckoj/db';
import { TokenService } from '../src/authn/token.service.js';
import { buildApp } from './app.harness.js';
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

describe('personal access tokens (HTTP)', () => {
  it('authenticates a guarded route via bearer token (case-insensitively), stops working once revoked, and list() never leaks the secret', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await agent.post('/auth/register').send({
          username: 'wren',
          email: 'wren@example.com',
          password: 'a-long-enough-password',
          displayName: 'Wren',
        });
        await agent
          .post('/auth/login')
          .send({ usernameOrEmail: 'wren', password: 'a-long-enough-password' });

        const create = await agent
          .post('/auth/tokens')
          .send({ name: 'cli', scopes: ['submissions:write'] });
        expect(create.status).toBe(201);
        const { id, token } = create.body as { id: number; token: string };
        expect(typeof token).toBe('string');

        // A fresh, cookie-less client authenticates purely off the bearer
        // token: `/auth/me` carries no `@RequireScope`, so `ScopeGuard`'s
        // deny-by-default now refuses it — 403 `scope_required`, not 401.
        // That distinction is the point: an unrecognized or revoked token
        // still fails 401 `invalid_token` (see below), so resolving to 403
        // here is itself proof the token authenticated.
        const me = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${token}`);
        expect(me.status).toBe(403);
        expect(me.body.code).toBe('scope_required');

        // RFC 6750: the scheme token is case-insensitive — same outcome.
        const meLowerScheme = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `bearer ${token}`);
        expect(meLowerScheme.status).toBe(403);
        expect(meLowerScheme.body.code).toBe('scope_required');

        // list() returns metadata only — never the raw token or its hash.
        const list = await agent.get('/auth/tokens');
        expect(list.status).toBe(200);
        expect(list.body).toHaveLength(1);
        expect(list.body[0].id).toBe(id);
        expect(list.body[0].name).toBe('cli');
        expect(list.body[0]).not.toHaveProperty('token');
        expect(list.body[0]).not.toHaveProperty('tokenHash');
        expect(JSON.stringify(list.body)).not.toContain(token);

        const revoke = await agent.delete(`/auth/tokens/${id}`);
        expect(revoke.status).toBe(204);

        // A revoked bearer token no longer authenticates anything.
        const afterRevoke = await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', `Bearer ${token}`);
        expect(afterRevoke.status).toBe(401);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
