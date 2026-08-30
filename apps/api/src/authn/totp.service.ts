import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { authenticator } from '@otplib/preset-default';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import { APP_CONFIG, DB } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { AppError } from '../common/app.error.js';
import { RateLimiter } from '../common/rate-limiter.js';
import { PasswordService } from './password.service.js';
import { TotpRecoveryService } from './totp-recovery.service.js';

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

/**
 * D34 — single use. Keyed on the CODE rather than on the step it came from:
 * the code identifies its own step, and deriving the step here would be a
 * second copy of `window`'s arithmetic that could disagree with `totp`'s.
 *
 * The window is two steps plus slack, which is longer than any code stays
 * acceptable (`window: [1, 0]` — the current step and the one before it), so
 * a row can never be swept while the code it guards is still usable. Its
 * only cost is the ~1-in-10^6 case where two steps inside two minutes
 * produce the same six digits and one legitimate sign-in is refused; the
 * user's next code works, and refusing is the safe direction to be wrong in.
 */
const REPLAY_PURPOSE = 'totp_used';
const REPLAY_WINDOW_MS = 120_000;

/**
 * D72 — ten confirmation attempts per account per fifteen minutes.
 *
 * B1 left this open on the argument that the caller already holds the
 * session. That is the wrong end of it: a confirm attempt is a guess at six
 * digits against a secret the server just handed out, and an unmetered guess
 * loop is a one-in-a-million code brute-forced in under a minute of scripted
 * requests — from the very session an intruder is holding while the real
 * owner is mid-enrolment.
 *
 * `allow`, not `consumeOnce`: this is a nuisance bound, and `allow` records
 * the refused attempt too, so a caller hammering the endpoint keeps burning
 * their own window rather than probing its edge for free. Keyed on the user
 * id, never the session — a new session must not buy a fresh ten.
 */
const CONFIRM_PURPOSE = 'totp_confirm';
const CONFIRM_LIMIT = 10;
const CONFIRM_WINDOW_MS = 15 * 60_000;

@Injectable()
export class TotpService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(TotpRecoveryService) private readonly recovery: TotpRecoveryService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
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

  /**
   * Answers with the account's eight recovery codes (D39), in plaintext, for
   * the only time they will ever exist outside the user's hands.
   *
   * Confirming and issuing are one transaction. A confirm that turned 2FA on
   * and then failed to write the codes would leave the account in the exact
   * state this feature exists to prevent — a second factor with no way past
   * it — and the user would have no reason to suspect it.
   */
  async confirmEnrolment(userId: number, code: string): Promise<string[]> {
    // Metered BEFORE the code is looked at (D72): a limiter a correct code
    // walks past is a limiter the attacker's winning guess walks past, which
    // is the only guess that matters.
    const key = String(userId);
    if (!(await this.limiter.allow(CONFIRM_PURPOSE, key, CONFIRM_LIMIT, CONFIRM_WINDOW_MS))) {
      const retryAfter = await this.limiter.retryAfterSeconds(
        CONFIRM_PURPOSE,
        key,
        CONFIRM_LIMIT,
        CONFIRM_WINDOW_MS,
      );
      throw new AppError(
        429,
        'totp_confirm_rate_limited',
        'Too many confirmation attempts. Try again later.',
        undefined,
        { 'Retry-After': String(retryAfter ?? 1) },
      );
    }
    const secret = await this.secretFor(userId);
    if (!secret || !totp.verify({ token: code, secret })) {
      // Distinct from the login-time `invalid_totp_code` (401): this one means
      // "the code you typed while proving enrolment was wrong", which a client
      // must be able to tell apart from "your second factor was wrong".
      throw new AppError(422, 'invalid_totp_enrolment_code', 'That code is not valid.');
    }
    return this.db.transaction(async (tx) => {
      await tx
        .update(schema.totpCredentials)
        .set({ confirmedAt: new Date() })
        .where(eq(schema.totpCredentials.userId, userId));
      return this.recovery.issue(userId, tx);
    });
  }

  /**
   * D39 — replaces the set, and demands a live TOTP code to do it.
   *
   * **`isEnabled` first, and not as a formality:** `verify` returns `true`
   * for an account with no confirmed credential (it documents that it fails
   * open and that callers must gate it), so without this check any session
   * could mint eight standing sign-in credentials by posting six arbitrary
   * digits — for an account that has no second factor at all, which is the
   * whole population.
   *
   * The code is spent by `verify` (D34), exactly as a sign-in would spend it.
   * That is the right cost: this route is a credential issue, and a code
   * relayed out of it is worth as much as one relayed out of a login.
   */
  async regenerateRecoveryCodes(userId: number, code: string): Promise<string[]> {
    if (!(await this.isEnabled(userId))) {
      throw new AppError(
        409,
        'totp_not_enabled',
        'Two-factor authentication is not on for this account.',
      );
    }
    if (!(await this.verify(userId, code))) {
      throw new AppError(422, 'invalid_totp_enrolment_code', 'That code is not valid.');
    }
    return this.recovery.issue(userId);
  }

  /**
   * The recovery codes go with the credential, in one transaction. They ARE
   * the second factor in another shape: leaving eight of them behind after a
   * disable would mean re-enrolling later silently inherited a set of codes
   * printed for a secret that no longer exists, and a stolen printout would
   * outlive the reset made to defeat it. This is also the path
   * `AdminUsersService.resetTotp` takes, so an admin reset clears them too.
   */
  /**
   * D72 — the account holder's own disable, which re-authenticates.
   *
   * The check lives HERE and not in `disable`: `AdminUsersService.resetTotp`
   * calls `disable` to unlock somebody who lost their phone, and an admin
   * does not have that person's password. Two callers, two rules, one
   * clearing routine.
   */
  async disableWithPassword(userId: number, password: string): Promise<void> {
    const [user] = await this.db
      .select({ passwordHash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (!user) throw new AppError(401, 'authentication_required', 'You must be signed in.');
    if (!(await this.passwords.verify(user.passwordHash, password))) {
      // The same code and status `POST /auth/password/change` answers for
      // the same mistake — a client should not have to learn two.
      throw new AppError(401, 'invalid_credentials', 'That is not your current password.');
    }
    await this.disable(userId);
  }

  async disable(userId: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(schema.totpCredentials).where(eq(schema.totpCredentials.userId, userId));
      await this.recovery.clear(userId, tx);
    });
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
   *
   * **A correct code is also spent here (D34).** RFC 6238 §5.2 requires a
   * verifier to refuse a second use of the same OTP, and nothing did: a code
   * read off a shoulder, a phishing relay or a proxied form bought a full
   * extra sign-in for the rest of its step. The record is in the database,
   * not in this process, because the API runs `API_WORKERS` of them and an
   * in-memory set would let the replay land on any other worker.
   */
  async verify(userId: number, code: string): Promise<boolean> {
    if (!(await this.isEnabled(userId))) return true;
    const secret = await this.secretFor(userId);
    if (!secret) return false;
    if (!totp.verify({ token: code, secret })) return false;
    return this.limiter.consumeOnce(REPLAY_PURPOSE, `${String(userId)}:${code}`, REPLAY_WINDOW_MS);
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
