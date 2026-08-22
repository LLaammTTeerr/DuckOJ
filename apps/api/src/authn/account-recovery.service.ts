/**
 * Password reset and address verification.
 *
 * Both are one-time tokens, so both live here and share one redemption path —
 * see `one_time_tokens`' doc comment for why one table with a `purpose` column
 * rather than two tables, and what that shape makes possible if a redemption
 * ever forgets to filter on `purpose`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { schema, type Db } from '@duckoj/db';
import { DB, APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { AppError } from '../common/app.error.js';
import { MAILER, type Mailer } from '../mail/mailer.js';
import { PasswordService } from './password.service.js';

type Purpose = 'password_reset' | 'email_verification';

/** A reset is a live rescue; a verification is a chore someone does later. */
const TTL_MINUTES: Record<Purpose, number> = {
  password_reset: 60,
  email_verification: 60 * 24,
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class AccountRecoveryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(PasswordService) private readonly passwords: PasswordService,
  ) {}

  /**
   * Always succeeds, whether or not the address exists.
   *
   * Anything else turns this endpoint into a membership oracle for an email
   * list — "does this person have an account here" is not a question a stranger
   * gets to ask.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const [user] = await this.db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.email, email.toLowerCase()))
      .limit(1);
    if (!user) return;

    const token = await this.issue(user.id, 'password_reset');
    await this.mailer.send({
      to: user.email,
      subject: 'Reset your DuckOJ password',
      text:
        `Someone asked to reset the password for this account.\n\n` +
        `${this.config.publicOrigin}/reset-password?token=${token}\n\n` +
        `This link works once and expires in ${String(TTL_MINUTES.password_reset)} minutes. ` +
        `If it was not you, nothing has changed and you can ignore this message.\n`,
    });
  }

  /**
   * Redeems a reset token and **ends every session for that user**.
   *
   * That last part is the point of a reset: the plausible reason someone is
   * resetting is that somebody else is signed in as them.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const passwordHash = await this.passwords.hash(newPassword);
    await this.db.transaction(async (tx) => {
      const row = await this.redeem(tx, token, 'password_reset');
      await tx
        .update(schema.users)
        .set({ passwordHash, updatedAt: new Date() })
        .where(eq(schema.users.id, row.userId));
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, row.userId));
    });
  }

  async sendVerification(userId: number): Promise<void> {
    const [user] = await this.db
      .select({ email: schema.users.email, verifiedAt: schema.users.emailVerifiedAt })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (!user || user.verifiedAt !== null) return;

    const token = await this.issue(userId, 'email_verification');
    await this.mailer.send({
      to: user.email,
      subject: 'Confirm your DuckOJ email address',
      text:
        `Confirm this address to finish setting up your DuckOJ account.\n\n` +
        `${this.config.publicOrigin}/verify-email?token=${token}\n\n` +
        `This link works once and expires in ${String(TTL_MINUTES.email_verification / 60)} hours.\n`,
    });
  }

  async verifyEmail(token: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await this.redeem(tx, token, 'email_verification');
      await tx
        .update(schema.users)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(schema.users.id, row.userId));
    });
  }

  /** Mints a token, stores only its hash, and returns the plaintext once. */
  private async issue(userId: number, purpose: Purpose): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.db.insert(schema.oneTimeTokens).values({
      userId,
      purpose,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + TTL_MINUTES[purpose] * 60_000),
    });
    return token;
  }

  /**
   * Finds a live token and marks it used, inside the caller's transaction.
   *
   * **`purpose` is part of the lookup, not an afterthought.** Filtering on the
   * hash alone works for every happy path and lets a verification link set a
   * password, which is the one bug the single-table shape makes possible.
   *
   * Every failure answers the same error: a caller holding a bad token learns
   * nothing from being told whether it was wrong, expired, or already spent.
   */
  private async redeem(
    tx: Db,
    token: string,
    purpose: Purpose,
  ): Promise<{ id: number; userId: number }> {
    const invalid = new AppError(400, 'invalid_token', 'That link is invalid or has expired.');
    const [row] = await tx
      .select({ id: schema.oneTimeTokens.id, userId: schema.oneTimeTokens.userId })
      .from(schema.oneTimeTokens)
      .where(
        and(
          eq(schema.oneTimeTokens.tokenHash, hashToken(token)),
          eq(schema.oneTimeTokens.purpose, purpose),
          isNull(schema.oneTimeTokens.usedAt),
          gt(schema.oneTimeTokens.expiresAt, new Date()),
        ),
      )
      .limit(1)
      .for('update');
    if (!row) throw invalid;

    await tx
      .update(schema.oneTimeTokens)
      .set({ usedAt: new Date() })
      .where(eq(schema.oneTimeTokens.id, row.id));
    return row;
  }
}
