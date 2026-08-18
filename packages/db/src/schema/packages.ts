import { bigint, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * A content-addressed package.
 *
 * The hash IS the identity — there is no surrogate key, because two packages
 * with the same contents are the same package and nothing should be able to
 * express otherwise.
 */
export const packages = pgTable('packages', {
  hash: text('hash').primaryKey(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  fileCount: integer('file_count').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per file, recorded so the store can verify what it holds against
 * what the hash claims. Also the groundwork for partial fetch; if that never
 * arrives, this table should be reconsidered rather than kept out of habit
 * (see §17 of the spec).
 */
export const packageFiles = pgTable(
  'package_files',
  {
    packageHash: text('package_hash')
      .notNull()
      .references(() => packages.hash, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
  },
  (t) => [primaryKey({ columns: [t.packageHash, t.path] })],
);
