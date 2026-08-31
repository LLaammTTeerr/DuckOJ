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
import { authenticator } from '@otplib/preset-default';
import type { INestApplication } from '@nestjs/common';
import { schema, type Db } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { userIdOf } from './submissions.fixtures.js';
import { MAILER, type LogMailer } from '../src/mail/mailer.js';
import { refusalPurpose } from '../src/common/rate-limiter.js';

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

/**
 * D141 — a password that changes takes every outstanding reset link with it.
 *
 * `redeem` marks the ONE row it was handed used; every other live
 * `password_reset` row for that account stayed redeemable for the rest of its
 * hour, and `AuthService.changePassword` never looked at the table at all. So
 * the rescue D32 exists to perform — "somebody else may be in my account, end
 * every credential they could be holding" — was reachable around by a link
 * that was already in flight.
 */
describe('changing a password invalidates outstanding reset links (D141)', () => {
  /** Asks for a reset and returns the token out of the mail. */
  async function requestReset(app: INestApplication, username: string): Promise<string> {
    await request(app.getHttpServer())
      .post('/api/v1/auth/password/forgot')
      .send({ email: `${username}@example.com` });
    return tokenFromLastMail(app);
  }

  it('kills a second live link when the first one is redeemed', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await registerAndLogin(app, 'bh34twolinks');
        // Two links in flight at once: a user who clicked "forgot password"
        // twice because the first mail was slow, or an intruder who asked for
        // one of their own while reading the victim's inbox.
        const stale = await requestReset(app, 'bh34twolinks');
        const fresh = await requestReset(app, 'bh34twolinks');
        expect(stale).not.toBe(fresh);

        const used = await request(app.getHttpServer())
          .post('/api/v1/auth/password/reset')
          .send({ token: fresh, password: CHOSEN });
        expect(used.status).toBe(200);

        const replayed = await request(app.getHttpServer())
          .post('/api/v1/auth/password/reset')
          .send({ token: stale, password: 'the-intruders-own-password' });
        expect(replayed.status).toBe(400);
        expect(replayed.body.code).toBe('invalid_token');

        // And the account still holds the password its owner chose.
        const signedIn = await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ usernameOrEmail: 'bh34twolinks', password: CHOSEN });
        expect(signedIn.status).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('kills a link that was in flight when the owner changed their password', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await registerAndLogin(app, 'bh34inflight');
        const inFlight = await requestReset(app, 'bh34inflight');

        const changed = await agent
          .post('/api/v1/auth/password/change')
          .send({ currentPassword: PASSWORD, newPassword: CHOSEN });
        expect(changed.status).toBe(204);

        const replayed = await request(app.getHttpServer())
          .post('/api/v1/auth/password/reset')
          .send({ token: inFlight, password: 'the-intruders-own-password' });
        expect(replayed.status).toBe(400);
        expect(replayed.body.code).toBe('invalid_token');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('leaves the address-verification link alone', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        // Registration mails a verification link; the change must not sweep it
        // away with the password tokens — one table, two purposes, and only
        // one of them is a credential for the password.
        const agent = await registerAndLogin(app, 'bh34verify');
        const verification = tokenFromLastMail(app);

        const changed = await agent
          .post('/api/v1/auth/password/change')
          .send({ currentPassword: PASSWORD, newPassword: CHOSEN });
        expect(changed.status).toBe(204);

        const verified = await request(app.getHttpServer())
          .post('/api/v1/auth/email/verify')
          .send({ token: verification });
        expect(verified.status).toBe(200);
        const [row] = await db
          .select({ verifiedAt: schema.users.emailVerifiedAt })
          .from(schema.users)
          .where(eq(schema.users.username, 'bh34verify'));
        expect(row?.verifiedAt).not.toBeNull();
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

/**
 * One refused request is one refusal (D47).
 *
 * `allow` marks the refusal itself, and both of its callers then asked
 * `retryAfterSeconds` for the `Retry-After` — which marks again, same purpose,
 * same key, same request. So the number D47 exists to give an operator, and
 * D95's monitor shows an organiser mid-contest, was double for exactly the two
 * meters that guard a credential. D80's submission meter already passes
 * `mark: false` for this reason and says so in `retryAfterSeconds`' own doc
 * comment; these two predate it.
 */
describe('a refused credential check is counted once (D47)', () => {
  async function refusalRows(db: Db, purpose: string): Promise<number> {
    const rows = await db
      .select({ id: schema.rateEvents.id })
      .from(schema.rateEvents)
      .where(eq(schema.rateEvents.purpose, refusalPurpose(purpose)));
    return rows.length;
  }

  it('marks one row for the eleventh wrong password on /auth/password/change (D73)', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await registerAndLogin(app, 'bh34meter');
        // Ten wrong guesses fit in the window; the eleventh is the refusal.
        for (let attempt = 0; attempt < 10; attempt++) {
          const wrong = await agent
            .post('/api/v1/auth/password/change')
            .send({ currentPassword: 'not-the-password', newPassword: CHOSEN });
          expect(wrong.status).toBe(401);
        }
        expect(await refusalRows(db, 'password_check')).toBe(0);

        const refused = await agent
          .post('/api/v1/auth/password/change')
          .send({ currentPassword: 'not-the-password', newPassword: CHOSEN });
        expect(refused.status).toBe(429);
        expect(refused.body.code).toBe('password_check_rate_limited');
        expect(refused.headers['retry-after']).toBeDefined();

        expect(await refusalRows(db, 'password_check')).toBe(1);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('marks one row for the eleventh wrong code on /auth/totp/confirm (D72)', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await registerAndLogin(app, 'bh34confirm');
        expect((await agent.post('/api/v1/auth/totp/begin')).status).toBe(200);
        for (let attempt = 0; attempt < 10; attempt++) {
          const wrong = await agent.post('/api/v1/auth/totp/confirm').send({ code: '000000' });
          expect(wrong.status).toBe(422);
        }
        expect(await refusalRows(db, 'totp_confirm')).toBe(0);

        const refused = await agent.post('/api/v1/auth/totp/confirm').send({ code: '000000' });
        expect(refused.status).toBe(429);
        expect(refused.body.code).toBe('totp_confirm_rate_limited');
        expect(refused.headers['retry-after']).toBeDefined();

        expect(await refusalRows(db, 'totp_confirm')).toBe(1);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

/**
 * The pairs that turned out to be RIGHT, pinned so they stay right.
 *
 * Each of these is a place where one feature could plausibly have undone
 * another and does not. They are cheap to keep and expensive to rediscover:
 * every one of them is a security property that a future "while I am here"
 * edit to `resetPassword` or `disable` could take out silently.
 */
describe('what a credential change deliberately does NOT touch', () => {
  async function enrol(app: INestApplication, agent: ReturnType<typeof request.agent>) {
    const secret = (await agent.post('/api/v1/auth/totp/begin')).body.secret as string;
    const confirmed = await agent
      .post('/api/v1/auth/totp/confirm')
      .send({ code: authenticator.generate(secret) });
    expect(confirmed.status).toBe(200);
    return { secret, codes: confirmed.body.recoveryCodes as string[] };
  }

  it('a mailed reset is not a way around the second factor (D32 vs D39)', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await registerAndLogin(app, 'bh34twofactor');
        const { codes } = await enrol(app, agent);

        expect((await resetByMail(app, 'bh34twofactor', CHOSEN)).status).toBe(200);

        // The password is the one they just chose AND the code is still
        // demanded. A reset that quietly dropped 2FA would hand the account
        // to anyone who can reach the mailbox — which is the threat 2FA is
        // bought to survive.
        const withoutCode = await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ usernameOrEmail: 'bh34twofactor', password: CHOSEN });
        expect(withoutCode.status).toBe(401);
        expect(withoutCode.body.code).toBe('totp_required');

        // And the printout made before the reset still works: recovery codes
        // are the second factor in another shape, not a password credential,
        // so a password event neither spends nor reissues them.
        const withCode = await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ usernameOrEmail: 'bh34twofactor', password: CHOSEN, recoveryCode: codes[0] });
        expect(withCode.status).toBe(200);
        expect(withCode.body.user.recoveryCodesRemaining).toBe(7);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('an admin TOTP reset takes the recovery codes with it (M9 vs D39)', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await registerAndLogin(app, 'bh34lostphone');
        const { codes } = await enrol(app, agent);

        const admin = await registerAndLogin(app, 'bh34admin');
        await db
          .update(schema.users)
          .set({ globalRole: 'admin' })
          .where(eq(schema.users.username, 'bh34admin'));
        const reset = await admin.delete('/api/v1/admin/users/bh34lostphone/totp');
        expect(reset.status).toBe(204);

        // Not merely "2FA is off": the eight codes printed for the secret the
        // admin just destroyed must not survive it. A stale printout that
        // outlived the reset would be a standing sign-in credential for
        // whoever found the notebook.
        expect((await agent.get('/api/v1/auth/me')).body.totpEnabled).toBe(false);
        expect((await agent.get('/api/v1/auth/me')).body.recoveryCodesRemaining).toBe(0);
        const [row] = await db
          .select({ id: schema.totpRecoveryCodes.id })
          .from(schema.totpRecoveryCodes)
          .where(eq(schema.totpRecoveryCodes.userId, await userIdOf(db, 'bh34lostphone')));
        expect(row).toBeUndefined();
        expect(codes).toHaveLength(8);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('a recovery-code sign-in leaves must_change_password standing (D39 vs D61)', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await registerAndLogin(app, 'bh34stillowed');
        const { codes } = await enrol(app, agent);
        await flagAsImported(db, 'bh34stillowed');

        const signedIn = await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ usernameOrEmail: 'bh34stillowed', password: PASSWORD, recoveryCode: codes[0] });
        expect(signedIn.status).toBe(200);
        // Spending a recovery code proves possession of the second factor.
        // It says nothing about the password, which is still the one this
        // server generated — so the obligation is untouched, and D102 still
        // refuses the account a token.
        expect(signedIn.body.user.mustChangePassword).toBe(true);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

/**
 * The four meters are four meters (D16, D26, D73, D80).
 *
 * They share one table, and `RateLimiter.record`'s cleanup deletes by
 * `(purpose, key, age)` — so a caller that got a purpose or a window wrong
 * could sweep another meter's live window out from under it. These are the
 * pairs a single-feature suite cannot see.
 */
describe('one meter refusing does not move another meter', () => {
  it('spending D73 does not spend D16, so the account can still sign in', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = await registerAndLogin(app, 'bh34budget');
        for (let attempt = 0; attempt < 11; attempt++) {
          await agent
            .post('/api/v1/auth/password/change')
            .send({ currentPassword: 'not-the-password', newPassword: CHOSEN });
        }
        // Eleven wrong passwords on `password/change` exhaust D73's budget
        // and D16's is ten. If the two shared a window, this sign-in — with
        // the RIGHT password — would be a 429 rather than a 200.
        const signedIn = await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ usernameOrEmail: 'bh34budget', password: PASSWORD });
        expect(signedIn.status).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('login refuses a known and an unknown identifier identically (D16 vs D26)', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await registerAndLogin(app, 'bh34known');
        async function fail(identifier: string) {
          return request(app.getHttpServer())
            .post('/api/v1/auth/login')
            .send({ usernameOrEmail: identifier, password: 'not-the-password' });
        }
        for (let attempt = 0; attempt < 10; attempt++) {
          expect((await fail('bh34known')).status).toBe(401);
          expect((await fail('bh34nobody')).status).toBe(401);
        }
        const known = await fail('bh34known');
        const unknown = await fail('bh34nobody');

        // Byte-identical, and both refused: the window is keyed on the
        // identifier as SUBMITTED, so an account that does not exist has one
        // too. A 429 that arrived for only one of the two would be an
        // enumeration oracle wearing a rate limiter's clothes.
        expect(known.status).toBe(429);
        expect(unknown.status).toBe(known.status);
        expect(unknown.body.code).toBe(known.body.code);
        expect(unknown.body.detail).toBe(known.body.detail);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});
