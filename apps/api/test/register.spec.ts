import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { schema } from '@qhhoj/db';
import { PasswordService } from '../src/authn/password.service.js';
import { AuthService } from '../src/authn/auth.service.js';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';

/**
 * `assertAvailable` is private; this widened type is only so the test below
 * can stub it out to reach the racing-INSERT path. See the test's comment
 * for why that's necessary.
 */
type AuthServiceWithPrivates = AuthService & {
  assertAvailable(field: 'username' | 'email', value: string): Promise<void>;
};

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

  it('translates a racing unique-constraint violation into 409 username_taken', async () => {
    // The pre-insert SELECT in `assertAvailable` closes the common,
    // uncontended case cleanly. To exercise the INSERT-time backstop that
    // catches the race it can't close (two concurrent callers both passing
    // the SELECT before either commits), this test has to reach the INSERT
    // with the username already taken *without* going through that SELECT
    // — otherwise the SELECT itself would report the conflict and the
    // backstop would never run. `withTestDb` gives the whole test one
    // Postgres transaction, so two real concurrent connections aren't
    // available here to reproduce the race directly. Instead,
    // `assertAvailable` is stubbed out (the only stubbed part) so the
    // request reaches the real `.insert(...).returning()` call against a
    // row inserted directly beforehand — Postgres itself then raises a
    // genuine 23505 on `users_username_lower_idx`, which is what
    // `toRegistrationConflict` in auth.service.ts must translate.
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const auth = app.get(AuthService) as AuthServiceWithPrivates;
      const spy = vi.spyOn(auth, 'assertAvailable').mockResolvedValue(undefined);

      await db.insert(schema.users).values({
        username: 'gina',
        email: 'gina@example.com',
        displayName: 'Gina',
        passwordHash: 'not-a-real-hash-this-row-is-only-here-to-collide',
      });

      const res = await request(app.getHttpServer()).post('/auth/register').send({
        username: 'gina',
        email: 'gina-two@example.com',
        password: 'a-long-enough-password',
        displayName: 'Gina Two',
      });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('username_taken');

      spy.mockRestore();
      await app.close();
    });
  }, 120_000);
});
