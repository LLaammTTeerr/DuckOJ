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

  /**
   * D33 — refuses outright when a CONFIRMED credential already exists.
   *
   * The upsert below replaces the stored secret and resets `confirmedAt` to
   * null, which is exactly right while an enrolment is still pending (a
   * second scan of a fresh QR) and catastrophic once one has been confirmed:
   * `isEnabled` goes false the instant this returns, so `login` stops asking
   * for a code at all. One POST carrying no proof of anything — not the
   * current code, not even the password — turned the second factor off, and
   * nothing told the account holder. An abandoned re-enrolment did the same
   * thing by accident: open the enrol screen out of curiosity in a stale
   * tab, close it, and 2FA is off.
   *
   * The check is not a race-free guarantee — two concurrent `begin` calls
   * can both read "not confirmed" — but the only state two racing `begin`s
   * can produce is a pair of pending secrets with no confirmed credential
   * between them, which is the pre-existing "last QR wins" behaviour and
   * costs nothing. What it does close completely is the single-request case,
   * which is the whole of the exposure.
   *
   * Re-enrolling stays possible: `DELETE /auth/totp` then `begin`. That is
   * one more deliberate step, and it makes the account's window of no second
   * factor something its owner asked for rather than something they were
   * given.
   */
  async beginEnrolment(userId: number): Promise<{ secret: string; otpauthUrl: string }> {
    if (await this.isEnabled(userId)) {
      throw new AppError(
        409,
        'totp_already_enabled',
        'Two-factor authentication is already on for this account. Turn it off before enrolling a new authenticator.',
      );
    }
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
