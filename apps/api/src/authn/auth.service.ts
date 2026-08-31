import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import type { MeResponseDto, RegisterRequestDto } from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import { RateLimiter } from '../common/rate-limiter.js';
import { PasswordService } from './password.service.js';
import { spendPasswordCheck } from './password-check.js';
import { invalidateOutstandingPasswordResets } from './account-recovery.service.js';

/** Postgres SQLSTATE for a unique-constraint violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * Maps the case-insensitive unique index names (see
 * packages/db/migrations/0000_init_identity.sql) to the request field that
 * collided, so a racing INSERT can be translated to the same conflict code
 * `assertAvailable` would have produced had it won the race.
 */
const CONFLICT_FIELD_BY_CONSTRAINT: Record<string, 'username' | 'email'> = {
  users_username_lower_idx: 'username',
  users_email_lower_idx: 'email',
};

/**
 * What `register` did, for a caller that must answer identically either way
 * (D26). `created: false` means the address was already registered and
 * nothing was written — the `user` is a synthesised echo of the request,
 * never a real row, and must never be treated as one.
 */
export interface RegistrationOutcome {
  created: boolean;
  user: MeResponseDto;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  /**
   * D26 — a taken USERNAME is a 409, a taken EMAIL is a fake success.
   *
   * The asymmetry is the whole ruling. A username is public — it is on every
   * scoreboard and in every submission list — so `username_taken` discloses
   * nothing and refusing it is the only way a person can pick another one. An
   * address is not public, and answering "that email is already registered"
   * to an anonymous POST made this endpoint an enumeration oracle over a
   * roster of minors, which is exactly the posture `sendPasswordReset`
   * already refuses to take two files over.
   */
  async register(input: RegisterRequestDto): Promise<RegistrationOutcome> {
    await this.assertAvailable('username', input.username);
    const emailTaken = await this.isTaken('email', input.email);

    // Hashed unconditionally, BEFORE the branch. Skipping the 19 MiB argon2id
    // on the taken-email path would make the fake 201 come back in a fraction
    // of the time a real one takes — the same oracle, read with a stopwatch
    // instead of with a status code. `login` burns the same cost against an
    // unknown identifier for the same reason.
    const passwordHash = await this.passwords.hash(input.password);
    if (emailTaken) return { created: false, user: syntheticMe(input) };

    let user: typeof schema.users.$inferSelect | undefined;
    try {
      [user] = await this.db
        .insert(schema.users)
        .values({
          username: input.username,
          email: input.email,
          displayName: input.displayName,
          passwordHash,
        })
        .returning();
    } catch (error) {
      const conflict = toRegistrationConflict(error);
      // The race the pre-check above cannot close. It has to answer the same
      // way the pre-check does, or the oracle survives under concurrency —
      // which is a condition an attacker can simply create. `unknown` in,
      // `unknown` out: `toRegistrationConflict` passes anything it does not
      // recognise straight through, so this narrows rather than casts.
      if (conflict instanceof AppError && conflict.code === 'email_taken') {
        return { created: false, user: syntheticMe(input) };
      }
      throw conflict;
    }

    return { created: true, user: toMe(user!, false, 0) };
  }

  async login(usernameOrEmail: string, password: string): Promise<typeof schema.users.$inferSelect> {
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(
        sql`lower(${schema.users.username}) = lower(${usernameOrEmail})
            or lower(${schema.users.email}) = lower(${usernameOrEmail})`,
      )
      .limit(1);

    const user = rows[0];
    if (!user) {
      // Burn comparable time when the account does not exist, so response
      // latency does not disclose which usernames are registered.
      await this.passwords.hash(password);
      throw new AppError(401, 'invalid_credentials', 'Incorrect username or password.');
    }
    const ok = await this.passwords.verify(user.passwordHash, password);
    if (!ok || user.status !== 'active') {
      throw new AppError(401, 'invalid_credentials', 'Incorrect username or password.');
    }
    return user;
  }

  /**
   * D61 — change your own password.
   *
   * `current` is REQUIRED unless the account carries `mustChangePassword`,
   * which only a school's roster import ever sets. The exception is not a
   * convenience: an imported account's "current" password was generated by
   * this server and printed on a sheet handed round a classroom, so demanding
   * it back would make that sheet — the very thing being replaced — the
   * credential that authorises replacing it. What stands in for it is the
   * route's `@SessionOnly` marker plus the session cookie itself.
   *
   * Every session and access token the account holds is destroyed, exactly as
   * `AccountRecoveryService.resetPassword` does: the reason a person changes
   * a password is usually that somebody else might know the old one, and
   * leaving that somebody's session alive answers the wrong question. That
   * includes the caller's own, so `AuthController` issues a fresh session and
   * re-sets the cookie on the way out — signing somebody out of the screen
   * they are looking at, on the click that was supposed to secure it, is how
   * a pupil concludes the change did not work and stops trying.
   */
  async changePassword(userId: number, current: string | undefined, next: string): Promise<void> {
    const user = await this.loadUser(userId);
    if (!user.mustChangePassword) {
      if (current === undefined) {
        throw new AppError(
          422,
          'current_password_required',
          'Your current password is required to set a new one.',
        );
      }
      // D73 — metered before the hash is read, and on the same budget
      // `DELETE /auth/totp` spends: both are reachable with a stolen
      // session, and an unmetered check there is an oracle for the password
      // itself. Not spent on the `mustChangePassword` path above, which
      // checks no password to meter.
      await spendPasswordCheck(this.limiter, userId);
      if (!(await this.passwords.verify(user.passwordHash, current))) {
        throw new AppError(401, 'invalid_credentials', 'That is not your current password.');
      }
    }
    const passwordHash = await this.passwords.hash(next);
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.users)
        .set({ passwordHash, mustChangePassword: false, updatedAt: new Date() })
        .where(eq(schema.users.id, userId));
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
      await tx.delete(schema.accessTokens).where(eq(schema.accessTokens.userId, userId));
      // D141 — and every reset link the account has in flight. This method
      // already destroys the two credential kinds an intruder could be
      // holding; a mailed link is a third, it is the one an intruder can
      // obtain without ever touching this server, and nothing else in the
      // product ends it before its hour is up.
      await invalidateOutstandingPasswordResets(tx, userId);
    });
  }

  async loadUser(userId: number): Promise<typeof schema.users.$inferSelect> {
    const rows = await this.db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    const user = rows[0];
    if (!user) throw new AppError(401, 'authentication_required', 'You must be signed in.');
    return user;
  }

  private async assertAvailable(field: 'username' | 'email', value: string): Promise<void> {
    if (await this.isTaken(field, value)) {
      throw new AppError(409, `${field}_taken`, `That ${field} is already registered.`);
    }
  }

  /**
   * The read half of `assertAvailable`, split out for the email path, which
   * must decide what to do rather than be refused (D26).
   */
  private async isTaken(field: 'username' | 'email', value: string): Promise<boolean> {
    const column = field === 'username' ? schema.users.username : schema.users.email;
    const existing = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`lower(${column}) = lower(${value})`)
      .limit(1);
    return existing.length > 0;
  }
}

/**
 * The body a taken-email registration answers with (D26): the submitted
 * values echoed back, in the shape a real success has, with the columns the
 * schema would have defaulted.
 *
 * The id is RANDOM, not `0` and not a constant: a fixed sentinel is itself a
 * perfect oracle, sitting in the one field this function exists to make
 * uninformative. It is never persisted and never resolves to anything —
 * whatever the client does with it next answers 404, exactly as it would for
 * an id that has since been deleted.
 */
function syntheticMe(input: RegisterRequestDto): MeResponseDto {
  return {
    id: randomInt(1, 2 ** 31 - 1),
    username: input.username,
    email: input.email,
    displayName: input.displayName,
    globalRole: 'user',
    // `null`, matching a genuine registration byte for byte (D26): neither
    // column has a default since 0023, so a real new row carries NULL here
    // and a synthetic body that said 'vi' would be a perfect oracle for
    // which of the two this is.
    locale: null,
    timezone: null,
    totpEnabled: false,
    // A fresh account has none, and this body must look exactly like the one
    // a genuine registration returns (D26) — so it is the same 0, not an
    // omission.
    recoveryCodesRemaining: 0,
    emailVerified: false,
    // `false`, byte for byte with a genuine registration (D26): a
    // self-registered account chose its own password, so 0024's column
    // defaults to false and a synthetic body saying anything else would be a
    // perfect oracle for which of the two this is.
    mustChangePassword: false,
    createdAt: new Date().toISOString(),
  };
}

export function toMe(
  user: typeof schema.users.$inferSelect,
  totpEnabled: boolean,
  /**
   * D39. Required rather than defaulted: a caller that forgets it would
   * quietly report "no recovery codes left" to someone who has eight, and the
   * security page would tell them to regenerate for no reason.
   */
  recoveryCodesRemaining: number,
): MeResponseDto {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    globalRole: user.globalRole,
    locale: user.locale,
    timezone: user.timezone,
    totpEnabled,
    recoveryCodesRemaining,
    emailVerified: user.emailVerifiedAt !== null,
    mustChangePassword: user.mustChangePassword,
    createdAt: user.createdAt.toISOString(),
  };
}

/**
 * Translates a Postgres unique-violation raised by a racing INSERT into the
 * same 409 that `assertAvailable`'s pre-check would have thrown had it won
 * the race, so a concurrent registration for the same username/email still
 * surfaces the contracted `username_taken` / `email_taken` code instead of
 * an opaque 500. Anything that isn't a unique violation on a constraint this
 * function recognizes is returned unchanged, so it keeps propagating and
 * stays visible as a genuine 500.
 */
function toRegistrationConflict(error: unknown): unknown {
  const pgError = asUniqueViolation(error);
  if (!pgError) return error;
  const field = pgError.constraint_name
    ? CONFLICT_FIELD_BY_CONSTRAINT[pgError.constraint_name]
    : undefined;
  return field ? new AppError(409, `${field}_taken`, `That ${field} is already registered.`) : error;
}

/**
 * drizzle-orm's postgres-js driver wraps every failed query in a
 * `DrizzleQueryError`, with the driver's own `PostgresError` (which carries
 * `code` and `constraint_name`) preserved on the standard `.cause` chain
 * rather than surfaced directly — confirmed against this exact dependency
 * version by triggering a real unique violation and inspecting the thrown
 * error. Check both the error itself and its `.cause` so this keeps working
 * if a future call site ever sees the raw driver error instead.
 */
function asUniqueViolation(error: unknown): { code: string; constraint_name?: string } | undefined {
  if (isUniqueViolationShape(error)) return error;
  const cause = error instanceof Error ? error.cause : undefined;
  return isUniqueViolationShape(cause) ? cause : undefined;
}

function isUniqueViolationShape(
  value: unknown,
): value is { code: string; constraint_name?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    (value as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}
