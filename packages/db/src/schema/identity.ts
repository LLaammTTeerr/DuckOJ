import { sql } from 'drizzle-orm';
import {
  bigserial,
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const userStatus = pgEnum('user_status', ['active', 'suspended', 'pending']);
export const globalRole = pgEnum('global_role', ['user', 'setter', 'admin']);

/**
 * What a one-time token is for.
 *
 * One table with a purpose column rather than two tables: expiry, hashing and
 * single-use redemption are identical for both, and duplicating them three
 * lines at a time is how they drift. The cost is that every redemption **must**
 * filter on `purpose` as well as on the hash — a verification link that can set
 * a password is exactly the bug this shape makes possible, and it has its own
 * test for that reason.
 */
export const oneTimeTokenPurpose = pgEnum('one_time_token_purpose', [
  'password_reset',
  'email_verification',
]);

export const users = pgTable(
  'users',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    username: text('username').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    status: userStatus('status').notNull().default('active'),
    globalRole: globalRole('global_role').notNull().default('user'),
    displayName: text('display_name').notNull(),
    about: text('about'),
    avatarKey: text('avatar_key'),
    country: text('country'),
    /**
     * The reader's own IANA zone and BCP-47 tag — **nullable, and `NULL` is
     * the point** (D57).
     *
     * Both were `NOT NULL DEFAULT` ('Asia/Ho_Chi_Minh', 'vi') until 0023, and
     * with a default there is no such thing as "the reader has not chosen":
     * a server value that beats the browser's own would have forced ICT
     * clocks and Vietnamese onto every account that never opened the settings
     * screen, which is exactly what D18's `navigator.language` resolution
     * exists to avoid. `NULL` means "not chosen — use the client's own", so
     * the stored value only ever overrides a default when somebody set it.
     */
    timezone: text('timezone'),
    locale: text('locale'),
    /** When this address was confirmed. Nothing is gated on it yet (3f §5). */
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    rating: integer('rating'),
    maxRating: integer('max_rating'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_username_lower_idx').on(sql`lower(${t.username})`),
    uniqueIndex('users_email_lower_idx').on(sql`lower(${t.email})`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('sessions_token_hash_idx').on(t.tokenHash)],
);

export const accessTokens = pgTable(
  'access_tokens',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('access_tokens_token_hash_idx').on(t.tokenHash)],
);

export const totpCredentials = pgTable('totp_credentials', {
  userId: bigint('user_id', { mode: 'number' })
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  secretEnc: text('secret_enc').notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * TOTP recovery codes (D39) — the way back in when the authenticator is gone.
 *
 * **Only the hash is stored**, exactly as `one_time_tokens` does and for the
 * same reason: a database leak must not hand over eight working second
 * factors. `sha256` rather than argon2 because the stored value is 50 bits of
 * SERVER-generated randomness, not a user-chosen password — there is no
 * dictionary to slow down, and a per-login argon2 verify against up to eight
 * rows at 19 MiB each would be a denial-of-service surface on a route anyone
 * can reach.
 *
 * `used_at` rather than a delete, so the count of what remains and the fact
 * that one was spent survive; the consume is a single
 * `UPDATE … WHERE used_at IS NULL RETURNING`, which is race-free on the row
 * itself and needs no advisory lock (unlike D34's `consumeOnce`, which has no
 * row to claim).
 */
export const totpRecoveryCodes = pgTable(
  'totp_recovery_codes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `sha256(canonical code)`, hex. Never the code itself. */
    codeHash: text('code_hash').notNull(),
    /** Set the moment the code is spent, in the statement that spends it. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('totp_recovery_codes_user_hash_idx').on(t.userId, t.codeHash)],
);

/**
 * Password-reset and address-verification tokens.
 *
 * **Only the hash is stored.** A database leak must not hand over working reset
 * links, and nothing legitimately needs the plaintext once it has been sent.
 */
export const oneTimeTokens = pgTable(
  'one_time_tokens',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: oneTimeTokenPurpose('purpose').notNull(),
    /** `sha256(token)`, hex. Never the token itself. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set on redemption, in the same transaction as the effect. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('one_time_tokens_hash_idx').on(t.tokenHash)],
);

/**
 * One row per rate-limited attempt (D13). A fixed window is counted with
 * `SELECT count(*) WHERE created_at > now - window`, so the limiter needs no
 * counter to reset and no state beyond the rows themselves; `RateLimiter`
 * deletes a key's expired rows opportunistically on each check, which keeps
 * the table bounded without a cron.
 *
 * `purpose` is plain text, not the token enum: the limiter is generic and a
 * new limited action must not require a migration (the `contests.format`
 * reasoning).
 */
export const rateEvents = pgTable(
  'rate_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    purpose: text('purpose').notNull(),
    /** What the limit is counted against — a lowercased email, an IP, an id. */
    key: text('key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('rate_events_lookup_idx').on(t.purpose, t.key, t.createdAt)],
);

/**
 * In-app notifications (D14). Strictly per-user rows: the only visibility
 * rule is `user_id = actor`, enforced in `NotificationsService`, so the
 * table stays in the plain schema rather than the guarded one.
 *
 * `kind` is plain text with `payload` jsonb beside it — a new kind is a
 * producer and a renderer, never a migration. The payload is a snapshot
 * (usernames, slugs as they were), not foreign keys: a notification about
 * an org that was later renamed should still read the way it did when it
 * happened.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull().default({}),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.id)],
);
