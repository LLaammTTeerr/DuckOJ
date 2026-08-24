/**
 * Phase 3f — password reset and address verification.
 *
 * The two properties that carry this suite are the ones a happy-path test
 * cannot see: that a token is good for exactly one use of exactly one purpose,
 * and that redeeming a reset ends every session the account had.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import { schema } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin, userIdOf } from './submissions.fixtures.js';
import { MAILER, type LogMailer } from '../src/mail/mailer.js';

const PASSWORD = 'a-long-enough-password';
const NEW_PASSWORD = 'an-even-longer-password';

/** `LogMailer` is what a test gets, because `TEST_CONFIG.smtp` is null. */
function mailerOf(app: INestApplication): LogMailer {
  return app.get<LogMailer>(MAILER);
}

/** The token out of the most recent message — how a real user gets it. */
function tokenFromLastMail(app: INestApplication): string {
  const mail = mailerOf(app).sent.at(-1);
  if (!mail) throw new Error('no mail was sent');
  const match = /token=([A-Za-z0-9_-]+)/.exec(mail.text);
  if (!match) throw new Error(`no token in mail: ${mail.text}`);
  return match[1]!;
}

async function seedUser(app: INestApplication, name: string) {
  const agent = request.agent(app.getHttpServer());
  await registerAndLogin(agent, name);
  return agent;
}

describe('POST /auth/password/forgot', () => {
  it('answers identically for a known and an unknown address', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedUser(app, 'knownuser');
        // Registration itself now sends a verification mail; count from here
        // so the assertion below stays about the forgot endpoint alone.
        const before = mailerOf(app).sent.length;
        const known = await request(app.getHttpServer())
          .post('/auth/password/forgot')
          .send({ email: 'knownuser@example.com' });
        const unknown = await request(app.getHttpServer())
          .post('/auth/password/forgot')
          .send({ email: 'nobody@example.com' });

        // Byte-identical, not merely both-2xx: any difference makes this a
        // membership oracle for an email list.
        expect(known.status).toBe(202);
        expect(unknown.status).toBe(known.status);
        expect(unknown.text).toEqual(known.text);
        // …and only the real one produced mail.
        expect(mailerOf(app).sent.length - before).toBe(1);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('redeeming a reset', () => {
  it('changes the password, works once, and ends every session', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const signedIn = await seedUser(app, 'resetter');
        // Proof the session is live before the reset, so its death afterwards
        // is attributable to the reset and not to the fixture.
        expect((await signedIn.get('/auth/me')).status).toBe(200);

        await request(app.getHttpServer())
          .post('/auth/password/forgot')
          .send({ email: 'resetter@example.com' });
        const token = tokenFromLastMail(app);

        const reset = await request(app.getHttpServer())
          .post('/auth/password/reset')
          .send({ token, password: NEW_PASSWORD });
        expect(reset.status).toBe(200);

        // The point of a reset: the plausible reason someone is resetting is
        // that somebody else is signed in as them.
        expect((await signedIn.get('/auth/me')).status).toBe(401);

        const fresh = request.agent(app.getHttpServer());
        expect(
          (
            await fresh
              .post('/auth/login')
              .send({ usernameOrEmail: 'resetter', password: NEW_PASSWORD })
          ).status,
        ).toBe(200);
        expect(
          (
            await request(app.getHttpServer())
              .post('/auth/login')
              .send({ usernameOrEmail: 'resetter', password: PASSWORD })
          ).status,
        ).toBe(401);

        // A link that works twice is a link that works after the account is
        // back in its owner's hands.
        const again = await request(app.getHttpServer())
          .post('/auth/password/reset')
          .send({ token, password: 'yet-another-long-password' });
        expect(again.status).toBe(400);
        expect(again.body.code).toBe('invalid_token');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses an expired token', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedUser(app, 'expiree');
        await request(app.getHttpServer())
          .post('/auth/password/forgot')
          .send({ email: 'expiree@example.com' });
        const token = tokenFromLastMail(app);

        // Written into the past rather than waiting an hour.
        await db
          .update(schema.oneTimeTokens)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(schema.oneTimeTokens.userId, await userIdOf(db, 'expiree')));

        const res = await request(app.getHttpServer())
          .post('/auth/password/reset')
          .send({ token, password: NEW_PASSWORD });
        expect(res.status).toBe(400);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('will not let a verification token set a password, or a reset token verify', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await seedUser(app, 'crosser');
        await agent.post('/auth/email/verify/send');
        const verifyToken = tokenFromLastMail(app);

        // Both purposes share one table, and the only thing keeping them apart
        // is a `WHERE` clause. A redemption filtering on the hash alone passes
        // every happy path and lets this succeed.
        const misused = await request(app.getHttpServer())
          .post('/auth/password/reset')
          .send({ token: verifyToken, password: NEW_PASSWORD });
        expect(misused.status).toBe(400);

        await request(app.getHttpServer())
          .post('/auth/password/forgot')
          .send({ email: 'crosser@example.com' });
        const resetToken = tokenFromLastMail(app);
        expect(
          (await request(app.getHttpServer()).post('/auth/email/verify').send({ token: resetToken }))
            .status,
        ).toBe(400);

        // The right token still works, so this is not passing because
        // everything is broken.
        expect(
          (await request(app.getHttpServer()).post('/auth/email/verify').send({ token: verifyToken }))
            .status,
        ).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('stores the hash and never the token', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedUser(app, 'hashed');
        await request(app.getHttpServer())
          .post('/auth/password/forgot')
          .send({ email: 'hashed@example.com' });
        const token = tokenFromLastMail(app);

        // Registration mints a verification token too, so scope this to the
        // reset token the test is about.
        const rows = await db
          .select({ hash: schema.oneTimeTokens.tokenHash })
          .from(schema.oneTimeTokens)
          .where(eq(schema.oneTimeTokens.purpose, 'password_reset'));
        expect(rows).toHaveLength(1);
        // A database leak must not hand over working reset links.
        expect(rows[0]!.hash).not.toBe(token);
        expect(rows[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('email verification', () => {
  it('marks the address and shows on /auth/me', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await seedUser(app, 'verifier');
        expect((await agent.get('/auth/me')).body.emailVerified).toBe(false);

        expect((await agent.post('/auth/email/verify/send')).status).toBe(202);
        const token = tokenFromLastMail(app);
        expect(
          (await request(app.getHttpServer()).post('/auth/email/verify').send({ token })).status,
        ).toBe(200);

        expect((await agent.get('/auth/me')).body.emailVerified).toBe(true);
        const [user] = await db
          .select({ at: schema.users.emailVerifiedAt })
          .from(schema.users)
          .where(eq(schema.users.username, 'verifier'));
        expect(user!.at).not.toBeNull();
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('requires a signed-in caller to request one', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        // The address comes from the session, never from a request body, so
        // nobody can aim a verification mail at someone else.
        expect((await request(app.getHttpServer()).post('/auth/email/verify/send')).status).toBe(401);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
