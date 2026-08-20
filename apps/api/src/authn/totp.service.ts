import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { authenticator } from '@otplib/preset-default';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import { APP_CONFIG, DB } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { AppError } from '../common/app.error.js';

const ISSUER = 'DuckOJ';

/**
 * RFC 4226 §4 R6 requires a shared secret of at least 128 bits and recommends
 * 160; Google Authenticator uses 160. `@otplib`'s own default is 10 bytes (80
 * bits), which is below the floor. Secret length cannot be raised
 * retroactively — every enrolled authenticator would have to be re-enrolled —
 * so it is pinned here, in bytes, at the recommended 160 bits.
 */
const SECRET_BYTES = 20;

/**
 * The verification window, in 30-second steps, as `[past, future]`.
 *
 * `@otplib/core@12`'s `authenticatorDefaultOptions()` sets `window: 0`, so only
 * the step that is current *at the moment the server checks* is accepted. That
 * is not merely strict, it is wrong in two ways: a user whose clock is a few
 * seconds slow can never sign in at all, and even a perfectly synced user fails
 * whenever the step rolls over between typing the code and the server reaching
 * the check — which happens after an argon2id verify at 19 MiB, so the race is
 * real rather than theoretical.
 *
 * RFC 6238 §5.2 recommends accepting exactly one step back. No future steps are
 * accepted: a code the user cannot have seen yet buys nothing and only widens
 * the guessing surface.
 *
 * `clone()` rather than mutating `authenticator.options` — the preset exports a
 * process-wide singleton, and tests import the same object to *generate* codes.
 */
const totp = authenticator.clone({ window: [1, 0] });

@Injectable()
export class TotpService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async beginEnrolment(userId: number): Promise<{ secret: string; otpauthUrl: string }> {
    const secret = totp.generateSecret(SECRET_BYTES);
    const secretEnc = this.encrypt(secret);
    await this.db
      .insert(schema.totpCredentials)
      .values({ userId, secretEnc })
      .onConflictDoUpdate({
        target: schema.totpCredentials.userId,
        set: { secretEnc, confirmedAt: null },
      });
    return { secret, otpauthUrl: totp.keyuri(String(userId), ISSUER, secret) };
  }

  async confirmEnrolment(userId: number, code: string): Promise<void> {
    const secret = await this.secretFor(userId);
    if (!secret || !totp.verify({ token: code, secret })) {
      // Distinct from the login-time `invalid_totp_code` (401): this one means
      // "the code you typed while proving enrolment was wrong", which a client
      // must be able to tell apart from "your second factor was wrong".
      throw new AppError(422, 'invalid_totp_enrolment_code', 'That code is not valid.');
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

  /**
   * Returns `true` when the user has no confirmed TOTP credential — this is
   * NOT a standalone authorization check. Callers must confirm `isEnabled`
   * first (as `AuthController.login` does) before treating a `true` result
   * as "the code was correct"; called bare, an unenrolled user's request
   * would fail open.
   */
  async verify(userId: number, code: string): Promise<boolean> {
    if (!(await this.isEnabled(userId))) return true;
    const secret = await this.secretFor(userId);
    return secret ? totp.verify({ token: code, secret }) : false;
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
