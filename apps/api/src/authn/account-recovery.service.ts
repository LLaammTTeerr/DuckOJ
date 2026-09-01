/**
 * Password reset and address verification.
 *
 * Both are one-time tokens, so both live here and share one redemption path —
 * see `one_time_tokens`' doc comment for why one table with a `purpose` column
 * rather than two tables, and what that shape makes possible if a redemption
 * ever forgets to filter on `purpose`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { schema, type Db } from '@duckoj/db';
import { DB, APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { AppError } from '../common/app.error.js';
import { MAILER, type Mailer } from '../mail/mailer.js';
import {
  emailVerificationMail,
  passwordResetMail,
  resolveMailLocale,
} from '../mail/templates.js';
import { PasswordService } from './password.service.js';
import { RateLimiter } from '../common/rate-limiter.js';

type Purpose = 'password_reset' | 'email_verification';

/** A reset is a live rescue; a verification is a chore someone does later. */
const TTL_MINUTES: Record<Purpose, number> = {
  password_reset: 60,
  email_verification: 60 * 24,
};

/**
 * D13: five outbound mails per key per hour, counted per purpose. The
 * refusal is silent — the endpoint's contract is "always succeeds", and a
 * limiter that starts answering 429 becomes the membership oracle the
 * endpoint exists to not be.
 */
const MAIL_LIMIT = 5;
const MAIL_WINDOW_MS = 60 * 60_000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * D141 — ends every reset link the account has in flight.
 *
 * `redeem` below marks the ONE row it was handed used, which is right for
 * single use and says nothing about the account's other live links. There is
 * normally more than one: a person who clicks "forgot password" twice because
 * the first mail was slow has two, and so does an intruder who asked for a
 * link of their own out of a mailbox they can read. Each of those is a
 * standing licence to take the account over, and until this ran they outlived
 * the very credential change made to stop them — D32's own sentence ("no
 * instant at which the new password is live and an old credential still is")
 * with `one_time_tokens` left out of the sweep.
 *
 * Marks `used_at` rather than deleting, so a dead link is dead in exactly the
 * one way `redeem` already tests for and there is no second definition of
 * "spent" to keep in step. Only LIVE rows, so nothing relabels history an
 * expiry already settled, and only `password_reset` — an address-verification
 * link proves nothing about a password and is none of this rule's business.
 *
 * Takes the caller's transaction: the invalidation and the new password land
 * together or not at all.
 */
export async function invalidateOutstandingPasswordResets(
  tx: Db,
  userId: number,
): Promise<void> {
  await tx
    .update(schema.oneTimeTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(schema.oneTimeTokens.userId, userId),
        eq(schema.oneTimeTokens.purpose, 'password_reset'),
        isNull(schema.oneTimeTokens.usedAt),
        gt(schema.oneTimeTokens.expiresAt, new Date()),
      ),
    );
}

@Injectable()
export class AccountRecoveryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  /**
   * D155 — refuses, before anything else happens, when this deployment cannot
   * actually deliver mail.
   *
   * **Why this does not break D26.** The endpoints below are uniform so they
   * cannot be asked "does this person have an account here". This refusal is
   * decided by two facts about the SERVER — which transport was resolved at
   * boot, and whether this is production — and by nothing whatsoever about
   * the request, so every caller gets the same answer for every address. It
   * is raised HERE, first, for the half of that property a response body does
   * not carry: raised after the lookup it would be uniform in content and
   * non-uniform in timing, and a timing oracle is still an oracle.
   *
   * **Why only production.** `LogMailer` is the deliberate default everywhere
   * else (see its own header): a developer must not need a mail server to
   * register a user, and neither must a test. There, the log IS the delivery
   * and the developer is the reader. In production nobody reads it, and the
   * mail that never arrives is a locked-out teacher on contest day.
   *
   * The alternative considered and rejected was to keep answering 202 and put
   * the honesty only in the log and on the admin dashboard. Both of those are
   * built too (F-40), and neither reaches the one person who is standing
   * there watching a screen that says a mail is on its way. A 503 is the
   * truthful answer to "please send me a mail" from a server that cannot: it
   * names the server as the broken thing, tells the person to find an
   * administrator instead of refreshing an inbox for an hour, and says
   * nothing at all about whether the address is known here.
   */
  private requireDeliverableMail(): void {
    if (this.config.nodeEnv !== 'production' || this.mailer.kind !== 'log') return;
    throw new AppError(
      503,
      'mail_unavailable',
      'This server is not configured to send email, so no message can be sent. ' +
        'Please ask an administrator to configure SMTP.',
    );
  }

  /**
   * Always succeeds, whether or not the address exists — unless this server
   * cannot send mail at all, which is D155's refusal above and is about the
   * server, not the address.
   *
   * Anything else turns this endpoint into a membership oracle for an email
   * list — "does this person have an account here" is not a question a stranger
   * gets to ask.
   */
  async requestPasswordReset(email: string): Promise<void> {
    // D155, first: before the limiter, before the lookup, before anything
    // that could make the refusal depend on the address.
    this.requireDeliverableMail();
    // Before the user lookup, and keyed by the *asked-for* address: an
    // attacker probing addresses that do not exist burns a window too.
    if (!(await this.limiter.allow('password_reset', email.toLowerCase(), MAIL_LIMIT, MAIL_WINDOW_MS))) {
      return;
    }
    const [user] = await this.db
      // `locale` too, since D57: this mail is the one piece of DuckOJ that
      // reaches somebody who cannot sign in, so it is the one that most needs
      // to arrive in their own language.
      .select({ id: schema.users.id, email: schema.users.email, locale: schema.users.locale })
      .from(schema.users)
      // lower() = lower(), the same comparison login uses: registration
      // stores the address as typed, so an eq() against the lowercased input
      // silently missed anyone who registered with a capital letter — they
      // could log in but never receive a reset mail.
      .where(sql`lower(${schema.users.email}) = lower(${email})`)
      .limit(1);
    if (!user) return;

    const token = await this.issue(user.id, 'password_reset');
    await this.mailer.send({
      to: user.email,
      ...passwordResetMail(resolveMailLocale(user.locale), {
        url: `${this.config.publicOrigin}/reset-password?token=${token}`,
        ttlMinutes: TTL_MINUTES.password_reset,
      }),
    });
  }

  /**
   * Redeems a reset token and **ends every credential the account has** —
   * every session *and* every personal access token (D32).
   *
   * That last part is the point of a reset: the plausible reason someone is
   * resetting is that somebody else is signed in as them. Killing only the
   * sessions leaves that intruder a way back in, because `POST /auth/tokens`
   * is reachable with exactly the session they already hold — mint one
   * before the owner reacts and the takeover outlives the password it was
   * created under, with nothing in the UI to show for it. Both credential
   * kinds die in the same transaction as the password change, so there is no
   * instant at which the new password is live and an old credential still
   * is.
   *
   * **`must_change_password` is cleared too (D140).** The flag means "this
   * account still holds the password this server generated and printed on a
   * sheet handed round a classroom" (D61), and redeeming a reset is the pupil
   * choosing one of their own — the same fact `changePassword` records by
   * clearing it. Leaving it set was wrong in both directions at once: D102
   * refuses every access token the account will ever hold, so `oj login`
   * never works again; and the flag is also what makes `currentPassword`
   * OPTIONAL on `POST /auth/password/change`, so the one-time bootstrap
   * exemption stayed open for good and whoever next sat down at that shared
   * school computer could rewrite the password without knowing it.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const passwordHash = await this.passwords.hash(newPassword);
    await this.db.transaction(async (tx) => {
      const row = await this.redeem(tx, token, 'password_reset');
      await tx
        .update(schema.users)
        .set({ passwordHash, mustChangePassword: false, updatedAt: new Date() })
        .where(eq(schema.users.id, row.userId));
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, row.userId));
      await tx.delete(schema.accessTokens).where(eq(schema.accessTokens.userId, row.userId));
      // D141 — the OTHER links, which `redeem` never sees. A reset that left
      // a sibling live would leave the takeover it exists to end one click
      // away for the rest of the hour.
      await invalidateOutstandingPasswordResets(tx, row.userId);
    });
  }

  async sendVerification(userId: number): Promise<void> {
    // D155. Reached from registration too, where `AuthController` already
    // wraps this call in a try/catch and logs — deliberately, so a mail
    // outage never turns a successful signup into a 500. So on a mail-less
    // production stack the account is still created and the operator gets one
    // ERROR line per registration saying why no verification mail went out,
    // which is precisely the record that was missing before.
    this.requireDeliverableMail();
    const [user] = await this.db
      .select({
        email: schema.users.email,
        verifiedAt: schema.users.emailVerifiedAt,
        locale: schema.users.locale,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (!user || user.verifiedAt !== null) return;
    if (!(await this.limiter.allow('email_verification', String(userId), MAIL_LIMIT, MAIL_WINDOW_MS))) {
      return;
    }

    const token = await this.issue(userId, 'email_verification');
    await this.mailer.send({
      to: user.email,
      ...emailVerificationMail(resolveMailLocale(user.locale), {
        url: `${this.config.publicOrigin}/verify-email?token=${token}`,
        ttlHours: TTL_MINUTES.email_verification / 60,
      }),
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
