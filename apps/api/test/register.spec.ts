import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { PasswordService } from '../src/authn/password.service.js';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('produces an argon2id hash that is not the plaintext', async () => {
    const hash = await service.hash('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('correct horse battery');
  });

  it('verifies a correct password', async () => {
    const hash = await service.hash('correct horse battery');
    await expect(service.verify(hash, 'correct horse battery')).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await service.hash('correct horse battery');
    await expect(service.verify(hash, 'wrong horse battery')).resolves.toBe(false);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    await expect(service.verify('not-a-hash', 'anything')).resolves.toBe(false);
  });

  it('salts — the same password hashes differently each time', async () => {
    const [a, b] = await Promise.all([service.hash('same'), service.hash('same')]);
    expect(a).not.toBe(b);
  });
});

describe('POST /auth/register', () => {
  it('creates a user and returns the profile without the password', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const res = await request(app.getHttpServer()).post('/auth/register').send({
        username: 'dave',
        email: 'dave@example.com',
        password: 'a-long-enough-password',
        displayName: 'Dave',
      });
      expect(res.status).toBe(201);
      expect(res.body.username).toBe('dave');
      expect(res.body.globalRole).toBe('user');
      expect(JSON.stringify(res.body)).not.toContain('password');
      await app.close();
    });
  }, 120_000);

  it('rejects a duplicate username with 409 and a stable code', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const body = {
        username: 'erin',
        email: 'erin@example.com',
        password: 'a-long-enough-password',
        displayName: 'Erin',
      };
      await request(app.getHttpServer()).post('/auth/register').send(body);
      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ ...body, email: 'erin2@example.com' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('username_taken');
      await app.close();
    });
  }, 120_000);

  it('rejects a short password with 422 and a field message', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const res = await request(app.getHttpServer()).post('/auth/register').send({
        username: 'frank',
        email: 'frank@example.com',
        password: 'short',
        displayName: 'Frank',
      });
      expect(res.status).toBe(422);
      expect(res.body.fields.password).toBeDefined();
      await app.close();
    });
  }, 120_000);
});
