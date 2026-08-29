import { authenticator } from '@otplib/preset-default';
import { describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@duckoj/db';
import { TotpService } from '../src/authn/totp.service.js';
import { TotpRecoveryService } from '../src/authn/totp-recovery.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { RateLimiter } from '../src/common/rate-limiter.js';
import type { AppConfig } from '../src/config/config.schema.js';
import { TEST_CONFIG } from './app.harness.js';
import { withTestDb } from './db.harness.js';

const config: AppConfig = { ...TEST_CONFIG, totpEncKey: Buffer.alloc(32, 7) };

async function makeUser(db: Db, username: string): Promise<number> {
  const [user] = await db
    .insert(schema.users)
    .values({ username, email: `${username}@e.com`, passwordHash: 'x', displayName: username })
    .returning();
  return user!.id;
}

describe('TotpService', () => {
  it('is disabled until enrolment is confirmed', async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db, 'mia');
      const service = new TotpService(db, config, new RateLimiter(db), new TotpRecoveryService(db, new NotificationsService(db)));

      await service.beginEnrolment(userId);
      expect(await service.isEnabled(userId)).toBe(false);
    });
  }, 120_000);

  it('confirms with a valid code and then verifies', async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db, 'nina');
      const service = new TotpService(db, config, new RateLimiter(db), new TotpRecoveryService(db, new NotificationsService(db)));

      const { secret } = await service.beginEnrolment(userId);
      await service.confirmEnrolment(userId, authenticator.generate(secret));

      expect(await service.isEnabled(userId)).toBe(true);
      expect(await service.verify(userId, authenticator.generate(secret))).toBe(true);
    });
  }, 120_000);

  it('rejects an incorrect confirmation code', async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db, 'omar');
      const service = new TotpService(db, config, new RateLimiter(db), new TotpRecoveryService(db, new NotificationsService(db)));
      await service.beginEnrolment(userId);
      // Distinct from login's 401 `invalid_totp_code`: a client must be able to
      // tell "your second factor was wrong" from "the code you typed while
      // enrolling was wrong" by `code` alone.
      await expect(service.confirmEnrolment(userId, '000000')).rejects.toMatchObject({
        status: 422,
        code: 'invalid_totp_enrolment_code',
      });
    });
  }, 120_000);

  it('issues a 160-bit secret, per RFC 4226 §4 R6', async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db, 'raj');
      const service = new TotpService(db, config, new RateLimiter(db), new TotpRecoveryService(db, new NotificationsService(db)));
      const { secret } = await service.beginEnrolment(userId);

      // Base32, 5 bits per character: 32 characters is 160 bits. otplib's own
      // default is 10 bytes / 16 characters — below RFC 4226's 128-bit floor —
      // and secret length cannot be raised after users have enrolled.
      expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    });
  }, 120_000);

  it('accepts the previous 30-second step but not the next one', async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db, 'sena');
      const service = new TotpService(db, config, new RateLimiter(db), new TotpRecoveryService(db, new NotificationsService(db)));
      const { secret } = await service.beginEnrolment(userId);
      await service.confirmEnrolment(userId, authenticator.generate(secret));

      // otplib defaults to `window: 0` — only the step current at the instant
      // the server checks. That rejects a user whose clock is seconds slow, and
      // races the step boundary against an argon2id verify at 19 MiB on every
      // login. RFC 6238 §5.2 recommends one step back; none forward, because a
      // code the user cannot have seen yet only widens the guessing surface.
      //
      // `Date.now` is pinned so this test cannot itself straddle a step
      // boundary between generating a code and the service verifying it — the
      // exact race being fixed would otherwise reappear as flake in the test
      // for it. The instant chosen sits 15s into its step. `Date.now` only is
      // stubbed, not the timer wheel, so the driver's own IO is untouched.
      const now = 1_699_999_995_000;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const previousStep = authenticator.clone({ epoch: now - 30_000 }).generate(secret);
        const nextStep = authenticator.clone({ epoch: now + 30_000 }).generate(secret);

        expect(await service.verify(userId, previousStep)).toBe(true);
        expect(await service.verify(userId, nextStep)).toBe(false);
      } finally {
        clock.mockRestore();
      }
    });
  }, 120_000);

  it('stores the secret encrypted, not in plaintext', async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db, 'pia');
      const service = new TotpService(db, config, new RateLimiter(db), new TotpRecoveryService(db, new NotificationsService(db)));
      const { secret } = await service.beginEnrolment(userId);

      const rows = await db.select().from(schema.totpCredentials);
      expect(rows[0]?.secretEnc).not.toContain(secret);
    });
  }, 120_000);
});
