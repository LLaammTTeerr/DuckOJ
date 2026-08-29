/**
 * D39 — TOTP recovery codes: the way back into an account whose authenticator
 * is gone.
 *
 * Before this, enrolling in 2FA was a one-way door — a lost phone meant an
 * admin reset (`POST /admin/users/{username}/totp/reset`) or nothing, and on
 * a province deployment where the admin is a teacher who checks mail twice a
 * week that is days of lockout for the person who did the *responsible*
 * thing.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, isNull } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import { DB } from '../config/config.module.js';
import { NotificationsService } from '../notifications/notifications.service.js';

/** Eight is the industry convention (GitHub, Google) and about a year of ordinary use. */
export const RECOVERY_CODE_COUNT = 8;

/**
 * Ten characters over a 32-symbol alphabet — 50 bits, which is far past
 * guessable through a login route D16 meters at ten attempts per fifteen
 * minutes, and short enough to write on the inside of a notebook cover.
 *
 * The alphabet is Crockford-shaped: `0/O`, `1/I/L` and `U` are absent, so a
 * code read off paper in a hurry has no character pair that can be confused
 * for another. Digits and letters are mixed rather than segregated because
 * that is what makes the pair `5`/`S` the only remaining hazard, and `S` is
 * kept while `5` is kept for entropy — both stay, and the canonicalizer
 * below does not attempt to repair them; a wrong code is simply wrong.
 */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 10;
const GROUP_LENGTH = 5;

/**
 * `xxxxx-xxxxx`. The dash is presentation only — it never reaches the hash,
 * so a user who types the code back without it still gets in.
 */
export function formatRecoveryCode(canonical: string): string {
  return `${canonical.slice(0, GROUP_LENGTH)}-${canonical.slice(GROUP_LENGTH)}`;
}

/**
 * What actually gets hashed: uppercase, with every non-alphanumeric dropped.
 *
 * So `abcde-fghjk`, `ABCDE FGHJK` and `ABCDEFGHJK` are one code. The
 * normalisation is deliberately generous — a recovery code is transcribed by
 * hand from paper, under stress, by someone who is already locked out.
 */
export function canonicalRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * `sha256`, not argon2 (D39). The stored value is 50 bits of server-generated
 * randomness with no dictionary behind it, so the work factor buys nothing
 * that the entropy does not already provide; and an argon2 verify at 19 MiB
 * against up to eight rows, on a route any anonymous caller can reach, is a
 * denial-of-service surface rather than a defence. It is the same reasoning —
 * and the same shape — as `one_time_tokens`, which stores `sha256(token)` for
 * reset links.
 */
function hashRecoveryCode(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

function generateCanonicalCode(): string {
  // 32 divides 256, so masking a uniform byte with 0x1f is itself uniform —
  // no modulo bias, and no rejection loop.
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte & 0x1f];
  return out;
}

@Injectable()
export class TotpRecoveryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  /**
   * Replaces the account's whole set and answers with the plaintext codes —
   * the only moment they exist outside the user's hands.
   *
   * Delete-then-insert in one statement pair (and inside the caller's
   * transaction when one is passed, which is how `confirmEnrolment` keeps
   * "2FA is on" and "here are your codes" from ever disagreeing): a
   * regenerate that left the old set alive would mean a stolen printout stays
   * valid after the user has done the one thing they know to do about it.
   * Used rows go too — keeping them would make `remaining` lie about which
   * set it is counting.
   */
  async issue(userId: number, tx: Db = this.db): Promise<string[]> {
    const canonicals = new Set<string>();
    // A collision inside one set is ~1 in 10^12 and the unique index would
    // turn it into a 500; the set makes it a re-draw instead.
    while (canonicals.size < RECOVERY_CODE_COUNT) canonicals.add(generateCanonicalCode());
    const codes = [...canonicals];
    await tx.delete(schema.totpRecoveryCodes).where(eq(schema.totpRecoveryCodes.userId, userId));
    await tx
      .insert(schema.totpRecoveryCodes)
      .values(codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })));
    return codes.map(formatRecoveryCode);
  }

  /** Deletes the account's codes — called when the credential itself goes. */
  async clear(userId: number, tx: Db = this.db): Promise<void> {
    await tx.delete(schema.totpRecoveryCodes).where(eq(schema.totpRecoveryCodes.userId, userId));
  }

  async remaining(userId: number): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(schema.totpRecoveryCodes)
      .where(
        and(
          eq(schema.totpRecoveryCodes.userId, userId),
          isNull(schema.totpRecoveryCodes.usedAt),
        ),
      );
    return row?.n ?? 0;
  }

  /**
   * Spends one code, once. `false` for a code that is unknown, malformed or
   * already used — the caller answers all three identically, so nothing here
   * tells an attacker which of the three they hit.
   *
   * **Race-free on the row, with no lock.** The claim is the `UPDATE … WHERE
   * used_at IS NULL RETURNING` itself: two simultaneous presentations of the
   * same code contend on that row, and Postgres re-evaluates the `WHERE` for
   * the loser after the winner commits, so exactly one gets a row back. D34's
   * `consumeOnce` needed an advisory lock because `rate_events` has no row to
   * claim — a count of absent rows is not a claim. Here there is one, and
   * taking a lock as well would only be slower.
   */
  async consume(userId: number, submitted: string): Promise<boolean> {
    const canonical = canonicalRecoveryCode(submitted);
    if (canonical.length === 0) return false;
    const codeHash = hashRecoveryCode(canonical);
    return this.db.transaction(async (tx) => {
      const spent = await tx
        .update(schema.totpRecoveryCodes)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(schema.totpRecoveryCodes.userId, userId),
            eq(schema.totpRecoveryCodes.codeHash, codeHash),
            isNull(schema.totpRecoveryCodes.usedAt),
          ),
        )
        .returning({ id: schema.totpRecoveryCodes.id });
      if (spent.length === 0) return false;
      const [row] = await tx
        .select({ n: count() })
        .from(schema.totpRecoveryCodes)
        .where(
          and(
            eq(schema.totpRecoveryCodes.userId, userId),
            isNull(schema.totpRecoveryCodes.usedAt),
          ),
        );
      // The last one just went. Nothing else in the product would ever tell
      // them: the next lockout is the moment they find out, and by then the
      // notification they needed is unreachable behind the sign-in they
      // cannot complete. Written in the same transaction as the spend, so
      // "the codes ran out" and "a code was spent" can never disagree.
      if ((row?.n ?? 0) === 0) {
        await this.notifications.notify(tx, userId, 'totp_recovery_codes_exhausted', {});
      }
      return true;
    });
  }
}
