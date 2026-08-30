/**
 * The two doors D33 left ajar (B1's rulings section), closed under D72.
 *
 * `POST /auth/totp/confirm` had no attempt limiter — twelve wrong codes all
 * answered 422 — and `DELETE /auth/totp` asked for nothing at all, so a
 * stolen session could strip the account's second factor in one request.
 * Both are proved here over HTTP, on the shipped module graph, because both
 * are claims about what a *request* may do rather than about what a service
 * computes.
 */
import { authenticator } from '@otplib/preset-default';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';

const PASSWORD = 'a-long-enough-password';

/** Registers, signs in, and returns the agent holding the session cookie. */
async function signedIn(app: Awaited<ReturnType<typeof buildApp>>, username: string) {
  const agent = request.agent(app.getHttpServer());
  await agent
    .post('/auth/register')
    .send({ username, email: `${username}@example.com`, password: PASSWORD, displayName: username });
  await agent.post('/auth/login').send({ usernameOrEmail: username, password: PASSWORD });
  return agent;
}

describe('POST /auth/totp/confirm is metered (D72)', () => {
  it('refuses the eleventh attempt in the window, correct code or not', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await signedIn(app, 'tess');
        const secret = (await agent.post('/auth/totp/begin')).body.secret as string;

        for (let attempt = 0; attempt < 10; attempt += 1) {
          const wrong = await agent.post('/auth/totp/confirm').send({ code: '000000' });
          expect(wrong.status).toBe(422);
          expect(wrong.body.code).toBe('invalid_totp_enrolment_code');
        }

        const refused = await agent.post('/auth/totp/confirm').send({ code: '000000' });
        expect(refused.status).toBe(429);
        expect(refused.body.code).toBe('totp_confirm_rate_limited');
        expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);

        // The meter is read BEFORE the code is checked: a limiter a correct
        // code walks past is a limiter an attacker walks past on the guess
        // that happens to be right, which is the only guess that matters.
        const correct = await agent
          .post('/auth/totp/confirm')
          .send({ code: authenticator.generate(secret) });
        expect(correct.status).toBe(429);
        expect((await agent.get('/auth/me')).body.totpEnabled).toBe(false);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('meters per account, so one user cannot lock another out', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const noisy = await signedIn(app, 'uma');
        await noisy.post('/auth/totp/begin');
        for (let attempt = 0; attempt < 11; attempt += 1) {
          await noisy.post('/auth/totp/confirm').send({ code: '000000' });
        }

        const quiet = await signedIn(app, 'vlad');
        const secret = (await quiet.post('/auth/totp/begin')).body.secret as string;
        const confirm = await quiet
          .post('/auth/totp/confirm')
          .send({ code: authenticator.generate(secret) });
        expect(confirm.status).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('DELETE /auth/totp re-authenticates (D72)', () => {
  it('demands the current password, and leaves 2FA on without it', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await signedIn(app, 'wren');
        const secret = (await agent.post('/auth/totp/begin')).body.secret as string;
        expect(
          (await agent.post('/auth/totp/confirm').send({ code: authenticator.generate(secret) }))
            .status,
        ).toBe(200);

        const bare = await agent.delete('/auth/totp').send({});
        expect(bare.status).toBe(422);
        expect((await agent.get('/auth/me')).body.totpEnabled).toBe(true);

        const wrong = await agent.delete('/auth/totp').send({ password: 'not-the-password' });
        expect(wrong.status).toBe(401);
        expect(wrong.body.code).toBe('invalid_credentials');
        expect((await agent.get('/auth/me')).body.totpEnabled).toBe(true);

        const right = await agent.delete('/auth/totp').send({ password: PASSWORD });
        expect(right.status).toBe(204);
        expect((await agent.get('/auth/me')).body.totpEnabled).toBe(false);
        // The recovery codes go with the credential, as they always did.
        expect((await agent.get('/auth/me')).body.recoveryCodesRemaining).toBe(0);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

/**
 * D73 — the password check D72 introduced is itself metered.
 *
 * D72's own argument is that a session is the thing an intruder steals and
 * both of these routes are reachable with exactly the stolen thing. It
 * closed the door by demanding the password — and then left the check that
 * reads it unmetered, so the stolen session became an unlimited oracle for
 * the password itself, answering 401 or 204 on every guess. Login has been
 * metered since B1; these two were the way round it.
 */
describe('the password check is metered (D73)', () => {
  it('refuses the eleventh guess in the window, on `DELETE /auth/totp`', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await signedIn(app, 'yara');
        const secret = (await agent.post('/auth/totp/begin')).body.secret as string;
        await agent.post('/auth/totp/confirm').send({ code: authenticator.generate(secret) });

        for (let attempt = 0; attempt < 10; attempt += 1) {
          const wrong = await agent.delete('/auth/totp').send({ password: `guess-${String(attempt)}` });
          expect(wrong.status).toBe(401);
        }

        const refused = await agent.delete('/auth/totp').send({ password: 'guess-10' });
        expect(refused.status).toBe(429);
        expect(refused.body.code).toBe('password_check_rate_limited');
        expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);

        // The meter is read BEFORE the password is verified, for D72's own
        // reason: the guess that matters is the one that is right.
        const correct = await agent.delete('/auth/totp').send({ password: PASSWORD });
        expect(correct.status).toBe(429);
        expect((await agent.get('/auth/me')).body.totpEnabled).toBe(true);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('is ONE budget across both routes, so the other is not a fresh ten', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await signedIn(app, 'zeno');
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const wrong = await agent
            .post('/auth/password/change')
            .send({ currentPassword: `guess-${String(attempt)}`, newPassword: 'another-long-password' });
          expect(wrong.status).toBe(401);
        }

        // Same account, other route: an attacker who can spend ten guesses
        // per endpoint has a limiter that scales with the endpoint count.
        const refused = await agent.delete('/auth/totp').send({ password: 'guess-10' });
        expect(refused.status).toBe(429);
        expect(refused.body.code).toBe('password_check_rate_limited');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('meters per account, and never stands between an imported pupil and their first password', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const noisy = await signedIn(app, 'aiko');
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await noisy.delete('/auth/totp').send({ password: `guess-${String(attempt)}` });
        }

        const quiet = await signedIn(app, 'bruno');
        const changed = await quiet
          .post('/auth/password/change')
          .send({ currentPassword: PASSWORD, newPassword: 'yet-another-long-password' });
        expect(changed.status).toBe(204);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
