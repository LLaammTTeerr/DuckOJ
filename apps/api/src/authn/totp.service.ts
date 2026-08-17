import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { authenticator } from '@otplib/preset-default';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@qhhoj/db';
import { APP_CONFIG, DB } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { AppError } from '../common/app.error.js';

const ISSUER = 'QHH Online Judge';

@Injectable()
export class TotpService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async beginEnrolment(userId: number): Promise<{ secret: string; otpauthUrl: string }> {
    const secret = authenticator.generateSecret();
    const secretEnc = this.encrypt(secret);
    await this.db
      .insert(schema.totpCredentials)
      .values({ userId, secretEnc })
      .onConflictDoUpdate({
        target: schema.totpCredentials.userId,
        set: { secretEnc, confirmedAt: null },
      });
    return { secret, otpauthUrl: authenticator.keyuri(String(userId), ISSUER, secret) };
  }

  async confirmEnrolment(userId: number, code: string): Promise<void> {
    const secret = await this.secretFor(userId);
    if (!secret || !authenticator.verify({ token: code, secret })) {
      // AppError's message is `detail ?? code` (see common/app.error.ts). No
      // `detail` is passed here so the thrown message *is* the stable code
      // `invalid_totp_code` — the brief's own test asserts on that via
      // `.rejects.toThrow(/invalid_totp_code/)`, which checks `.message`.
      throw new AppError(422, 'invalid_totp_code');
    }
    await this.db
      .update(schema.totpCredentials)
      .set({ confirmedAt: new Date() })
      .where(eq(schema.totpCredentials.userId, userId));
  }

  async disable(userId: number): Promise<void> {
    await this.db.delete(schema.totpCredentials).where(eq(schema.totpCredentials.userId, userId));
  }

  async isEnabled(userId: number): Promise<boolean> {
    const rows = await this.db
      .select({ confirmedAt: schema.totpCredentials.confirmedAt })
      .from(schema.totpCredentials)
      .where(eq(schema.totpCredentials.userId, userId))
      .limit(1);
    return rows[0]?.confirmedAt != null;
  }

  async verify(userId: number, code: string): Promise<boolean> {
    if (!(await this.isEnabled(userId))) return true;
    const secret = await this.secretFor(userId);
    return secret ? authenticator.verify({ token: code, secret }) : false;
  }

  private async secretFor(userId: number): Promise<string | null> {
    const rows = await this.db
      .select({ secretEnc: schema.totpCredentials.secretEnc })
      .from(schema.totpCredentials)
      .where(eq(schema.totpCredentials.userId, userId))
      .limit(1);
    return rows[0] ? this.decrypt(rows[0].secretEnc) : null;
  }

  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.config.totpEncKey, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
  }

  private decrypt(payload: string): string {
    const [iv, tag, enc] = payload.split('.').map((p) => Buffer.from(p, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', this.config.totpEncKey, iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(enc!), decipher.final()]).toString('utf8');
  }
}
