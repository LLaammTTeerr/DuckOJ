import { authenticator } from '@otplib/preset-default';
import { describe, expect, it } from 'vitest';
import { schema, type Db } from '@qhhoj/db';
import { TotpService } from '../src/authn/totp.service.js';
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
      const service = new TotpService(db, config);

      await service.beginEnrolment(userId);
      expect(await service.isEnabled(userId)).toBe(false);
    });
  }, 120_000);

  it('confirms with a valid code and then verifies', async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db, 'nina');
      const service = new TotpService(db, config);

      const { secret } = await service.beginEnrolment(userId);
      await service.confirmEnrolment(userId, authenticator.generate(secret));

      expect(await service.isEnabled(userId)).toBe(true);
      expect(await service.verify(userId, authenticator.generate(secret))).toBe(true);
    });
  }, 120_000);

  it('rejects an incorrect confirmation code', async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db, 'omar');
      const service = new TotpService(db, config);
      await service.beginEnrolment(userId);
      await expect(service.confirmEnrolment(userId, '000000')).rejects.toThrow(/invalid_totp_code/);
    });
  }, 120_000);

  it('stores the secret encrypted, not in plaintext', async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db, 'pia');
      const service = new TotpService(db, config);
      const { secret } = await service.beginEnrolment(userId);

      const rows = await db.select().from(schema.totpCredentials);
      expect(rows[0]?.secretEnc).not.toContain(secret);
    });
  }, 120_000);
});
