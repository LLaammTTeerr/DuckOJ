/**
 * B-34 — the credential lifecycle as one system.
 *
 * Every feature in `apps/api/src/authn` has its own suite. These are the
 * PAIRS: a password reset meeting D61's roster flag, a self-service change
 * meeting a reset link that is already in flight. Nothing here re-tests a
 * single feature; each case is a state two features can only reach together.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import { schema, type Db } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { MAILER, type LogMailer } from '../src/mail/mailer.js';

const PASSWORD = 'a-long-enough-password';
const CHOSEN = 'the-password-they-chose';

/** The token out of the most recent message — how a real user gets it. */
function tokenFromLastMail(app: INestApplication): string {
  const mail = app.get<LogMailer>(MAILER).sent.at(-1);
  if (!mail) throw new Error('no mail was sent');
  const match = /token=([A-Za-z0-9_-]+)/.exec(mail.text);
  if (!match) throw new Error(`no token in mail: ${mail.text}`);
  return match[1]!;
}

async function registerAndLogin(app: INestApplication, username: string) {
  const agent = request.agent(app.getHttpServer());
  await agent.post('/api/v1/auth/register').send({
    username,
    email: `${username}@example.com`,
    password: PASSWORD,
    displayName: username,
  });
  await agent.post('/api/v1/auth/login').send({ usernameOrEmail: username, password: PASSWORD });
  return agent;
}

/** Exactly what `runImport` writes for a pupil off a school's roster (D61). */
async function flagAsImported(db: Db, username: string): Promise<void> {
  await db
    .update(schema.users)
    .set({ mustChangePassword: true })
    .where(eq(schema.users.username, username));
}

/** Drives the whole mailed-reset flow and returns the redemption response. */
async function resetByMail(app: INestApplication, username: string, password: string) {
  await request(app.getHttpServer())
    .post('/api/v1/auth/password/forgot')
    .send({ email: `${username}@example.com` });
  const token = tokenFromLastMail(app);
  return request(app.getHttpServer()).post('/api/v1/auth/password/reset').send({ token, password });
}

/**
 * D140 — the pupil off a roster import who forgets the printed password and
 * takes the only other way in.
 *
 * `changePassword` clears `must_change_password`; `resetPassword` did not
 * touch it. So the account that took the mailed route kept the flag forever,
 * with two consequences that pull in opposite directions and are both wrong:
 * D102 refuses every access token the account will ever hold, and the
 * "no current password required" bootstrap exemption stays open for good —
 * so whoever next sits down at that school computer can rewrite the password
 * without knowing it.
 */
describe('a mailed password reset clears must_change_password (D140)', () => {
  it('lets the account sign in unflagged and mint a token afterwards', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await registerAndLogin(app, 'bh34pupil');
        await flagAsImported(db, 'bh34pupil');

        const reset = await resetByMail(app, 'bh34pupil', CHOSEN);
        expect(reset.status).toBe(200);

        // The password on the printed sheet is gone and the one they chose
        // works — so the obligation the flag records has been discharged.
        const agent = request.agent(app.getHttpServer());
        const signedIn = await agent
          .post('/api/v1/auth/login')
          .send({ usernameOrEmail: 'bh34pupil', password: CHOSEN });
        expect(signedIn.status).toBe(200);
        expect(signedIn.body.user.mustChangePassword).toBe(false);
        expect((await agent.get('/api/v1/auth/me')).body.mustChangePassword).toBe(false);

        // D102's refusal is keyed on the same flag, so this is the half a
        // pupil actually notices: `oj login` works again.
        const minted = await agent.post('/api/v1/auth/tokens').send({ name: 'cli', scopes: [] });
        expect(minted.status).toBe(201);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('still demands the current password from an account that was never flagged', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await registerAndLogin(app, 'bh34plain');
        // The bootstrap exemption must not be reachable by resetting: a
        // reset is how you get a password of your own, not how you get out of
        // proving the one you have.
        const refused = await agent
          .post('/api/v1/auth/password/change')
          .send({ newPassword: CHOSEN });
        expect(refused.status).toBe(422);
        expect(refused.body.code).toBe('current_password_required');

        expect((await resetByMail(app, 'bh34plain', CHOSEN)).status).toBe(200);

        const after = request.agent(app.getHttpServer());
        await after
          .post('/api/v1/auth/login')
          .send({ usernameOrEmail: 'bh34plain', password: CHOSEN });
        const stillRefused = await after
          .post('/api/v1/auth/password/change')
          .send({ newPassword: 'yet-another-long-password' });
        expect(stillRefused.status).toBe(422);
        expect(stillRefused.body.code).toBe('current_password_required');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
