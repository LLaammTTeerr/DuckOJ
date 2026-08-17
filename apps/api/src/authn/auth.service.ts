import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { schema, type Db } from '@qhhoj/db';
import type { MeResponseDto, RegisterRequestDto } from '@qhhoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import { PasswordService } from './password.service.js';

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

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PasswordService) private readonly passwords: PasswordService,
  ) {}

  async register(input: RegisterRequestDto): Promise<MeResponseDto> {
    await this.assertAvailable('username', input.username);
    await this.assertAvailable('email', input.email);

    const passwordHash = await this.passwords.hash(input.password);

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
      throw toRegistrationConflict(error);
    }

    return toMe(user!, false);
  }

  private async assertAvailable(field: 'username' | 'email', value: string): Promise<void> {
    const column = field === 'username' ? schema.users.username : schema.users.email;
    const existing = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`lower(${column}) = lower(${value})`)
      .limit(1);
    if (existing.length > 0) {
      throw new AppError(409, `${field}_taken`, `That ${field} is already registered.`);
    }
  }
}

export function toMe(
  user: typeof schema.users.$inferSelect,
  totpEnabled: boolean,
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
