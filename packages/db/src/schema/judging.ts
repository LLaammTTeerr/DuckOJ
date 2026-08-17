import {
  bigint,
  bigserial,
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { problemRevisions, submissions } from './guarded.js';

export const gradingJobState = pgEnum('grading_job_state', ['queued', 'leased', 'done', 'failed']);
export const gradingJobKind = pgEnum('grading_job_kind', ['submission']);

export const languages = pgTable(
  'languages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    extension: text('extension').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('languages_key_idx').on(t.key)],
);

/**
 * Maps our language key to a driver's executor key. This table is what stops
 * `CPP17` — judge-server's name — from becoming our name.
 */
export const languageDriverKeys = pgTable(
  'language_driver_keys',
  {
    languageId: bigint('language_id', { mode: 'number' })
      .notNull()
      .references(() => languages.id, { onDelete: 'cascade' }),
    driver: text('driver').notNull(),
    executorKey: text('executor_key').notNull(),
  },
  (t) => [primaryKey({ columns: [t.languageId, t.driver] })],
);

export const judgeNodes = pgTable(
  'judge_nodes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    driver: text('driver').notNull(),
    capabilities: jsonb('capabilities'),
    lastSeen: timestamp('last_seen', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('judge_nodes_name_idx').on(t.name), uniqueIndex('judge_nodes_token_idx').on(t.tokenHash)],
);

export const gradingJobs = pgTable(
  'grading_jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: gradingJobKind('kind').notNull().default('submission'),
    /** Nullable: later job kinds (invocations) will have no submission. */
    submissionId: bigint('submission_id', { mode: 'number' }).references(() => submissions.id, {
      onDelete: 'cascade',
    }),
    revisionId: bigint('revision_id', { mode: 'number' })
      .notNull()
      .references(() => problemRevisions.id),
    packageHash: text('package_hash').notNull(),
    state: gradingJobState('state').notNull().default('queued'),
    /** Fencing token. Incremented on every claim; stale events are rejected. */
    attempt: integer('attempt').notNull().default(0),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    workerId: text('worker_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
);
