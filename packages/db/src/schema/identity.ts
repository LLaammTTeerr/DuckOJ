import { sql } from 'drizzle-orm';
import {
  bigserial,
  bigint,
  integer,
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
    timezone: text('timezone').notNull().default('Asia/Ho_Chi_Minh'),
    locale: text('locale').notNull().default('vi'),
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
