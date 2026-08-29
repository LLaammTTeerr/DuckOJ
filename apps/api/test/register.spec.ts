import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { count, eq, sql } from 'drizzle-orm';
import { schema } from '@duckoj/db';
import { MeResponse } from '@duckoj/contracts';
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
  isTaken(field: 'username' | 'email', value: string): Promise<boolean>;
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

/**
 * D26 — registration is metered, and a taken EMAIL answers like a success.
 *
 * Usernames stay public (`username_taken` is unchanged: a username is on
 * every scoreboard). An address is not, and `email_taken` made this endpoint
 * an enumeration oracle against a roster of minors — contradicting the
 * app's own posture two files over, where forgot-password answers identically
 * whether or not the account exists.
 */
describe('POST /auth/register — enumeration and metering (D26)', () => {
  const BODY = {
    username: 'newcomer',
    email: 'taken@example.com',
    password: 'a-long-enough-password',
    displayName: 'Newcomer',
  };

  it('answers a taken email exactly like a success, and creates nothing', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const first = await request(app.getHttpServer())
          .post('/auth/register')
          .send({ ...BODY, username: 'incumbent' });
        expect(first.status).toBe(201);

        const second = await request(app.getHttpServer()).post('/auth/register').send(BODY);
        // Same status, same body SHAPE, and the submitted values echoed back
        // — anything that differed would be the oracle all over again.
        expect(second.status).toBe(201);
        expect(MeResponse.safeParse(second.body).success).toBe(true);
        expect(second.body.username).toBe('newcomer');
        expect(second.body.email).toBe('taken@example.com');
        expect(second.body.displayName).toBe('Newcomer');
        expect(second.body.globalRole).toBe('user');
        expect(second.body.emailVerified).toBe(false);
        expect(second.body.totpEnabled).toBe(false);
        // A fabricated id, not `0` — a fixed sentinel would be a fresh
        // oracle in the field meant to close one.
        expect(second.body.id).toBeGreaterThan(0);

        // Nothing was written.
        const [users] = await db.select({ n: count() }).from(schema.users);
        expect(users?.n).toBe(1);
        const rows = await db
          .select({ username: schema.users.username })
          .from(schema.users)
          .where(sql`lower(${schema.users.email}) = 'taken@example.com'`);
        expect(rows).toEqual([{ username: 'incumbent' }]);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('answers a racing unique violation on the email the same way', async () => {
    // The INSERT-time backstop, reached the same way the username race test
    // reaches it: `assertAvailable` stubbed out so Postgres itself raises
    // 23505 on `users_email_lower_idx`. That path used to surface
    // `email_taken`, which would have left the oracle open under a race.
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const auth = app.get(AuthService) as AuthServiceWithPrivates;
      const spy = vi.spyOn(auth, 'assertAvailable').mockResolvedValue(undefined);
      const readSpy = vi.spyOn(auth, 'isTaken').mockResolvedValue(false);
      try {
        await db.insert(schema.users).values({
          username: 'incumbent',
          email: 'taken@example.com',
          displayName: 'Incumbent',
          passwordHash: 'not-a-real-hash-this-row-is-only-here-to-collide',
        });

        const res = await request(app.getHttpServer()).post('/auth/register').send(BODY);
        expect(res.status).toBe(201);
        expect(res.body.username).toBe('newcomer');
        expect(res.body.email).toBe('taken@example.com');
        // No row count is asserted here, deliberately: the 23505 this test
        // provokes aborts `withTestDb`'s enclosing transaction, so every
        // later statement on that connection fails. What matters is the
        // answer, and the answer is a 201 — the same one the pre-check path
        // gives, which the previous test pins against the real table.
      } finally {
        spy.mockRestore();
        readSpy.mockRestore();
        await app.close();
      }
    });
  }, 120_000);

  it('refuses the thirty-first registration from one IP with 429 and a Retry-After', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        for (let i = 0; i < 30; i++) {
          const res = await request(app.getHttpServer())
            .post('/auth/register')
            .set('X-Forwarded-For', '203.0.113.7')
            .send({ ...BODY, username: `member${String(i)}`, email: `member${String(i)}@x.test` });
          expect(res.status).toBe(201);
        }

        const refused = await request(app.getHttpServer())
          .post('/auth/register')
          .set('X-Forwarded-For', '203.0.113.7')
          .send({ ...BODY, username: 'member30', email: 'member30@x.test' });
        expect(refused.status).toBe(429);
        expect(refused.body.code).toBe('register_rate_limited');
        expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
        // Refused BEFORE the argon2 hash, so nothing was written.
        const [users] = await db.select({ n: count() }).from(schema.users);
        expect(users?.n).toBe(30);

        // A different IP has its own window, and the refusal recorded
        // nothing — the same shape D16 gives login.
        const other = await request(app.getHttpServer())
          .post('/auth/register')
          .set('X-Forwarded-For', '198.51.100.4')
          .send({ ...BODY, username: 'elsewhere', email: 'elsewhere@x.test' });
        expect(other.status).toBe(201);
        const events = await db
          .select({ key: schema.rateEvents.key })
          .from(schema.rateEvents)
          .where(eq(schema.rateEvents.purpose, 'register'));
        expect(events.filter((row) => row.key === 'ip:203.0.113.7')).toHaveLength(30);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('meters a refused registration too — a taken email still burns the window', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await request(app.getHttpServer())
          .post('/auth/register')
          .set('X-Forwarded-For', '203.0.113.9')
          .send({ ...BODY, username: 'incumbent' });
        // Twenty-nine more attempts, all on the SAME (now taken) address:
        // each one is a fake 201 and each one still counts, or the meter
        // would not cover the enumeration it exists to make expensive.
        for (let i = 0; i < 29; i++) {
          await request(app.getHttpServer())
            .post('/auth/register')
            .set('X-Forwarded-For', '203.0.113.9')
            .send({ ...BODY, username: `probe${String(i)}` });
        }
        const refused = await request(app.getHttpServer())
          .post('/auth/register')
          .set('X-Forwarded-For', '203.0.113.9')
          .send({ ...BODY, username: 'probe99' });
        expect(refused.status).toBe(429);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
