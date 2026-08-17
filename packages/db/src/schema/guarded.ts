import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './identity.js';

export const orgVisibility = pgEnum('org_visibility', ['public', 'private']);
export const orgJoinPolicy = pgEnum('org_join_policy', ['open', 'request', 'invite']);
export const orgRole = pgEnum('org_role', ['owner', 'admin', 'member']);
export const joinRequestState = pgEnum('join_request_state', ['pending', 'approved', 'rejected']);

export const organizations = pgTable(
  'organizations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    about: text('about'),
    visibility: orgVisibility('visibility').notNull().default('private'),
    joinPolicy: orgJoinPolicy('join_policy').notNull().default('request'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('organizations_slug_lower_idx').on(sql`lower(${t.slug})`)],
);

export const orgMembers = pgTable(
  'org_members',
  {
    orgId: bigint('org_id', { mode: 'number' })
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: orgRole('role').notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

export const orgJoinRequests = pgTable('org_join_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  orgId: bigint('org_id', { mode: 'number' })
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  userId: bigint('user_id', { mode: 'number' })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  state: joinRequestState('state').notNull().default('pending'),
  decidedBy: bigint('decided_by', { mode: 'number' }).references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
});
