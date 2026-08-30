import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
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
    /**
     * Which judge node graded (or is grading) this job's current attempt —
     * the node↔job join `judge_nodes` never had (D47 called its absence out,
     * D68 adds it). Written by `judged` on dispatch from the bridge
     * connection the request actually went to, so it names the judge that
     * really ran the code rather than the one an operator assumes did.
     *
     * `on delete set null`, never cascade: retiring a judge must not delete
     * grading history. `scripts/judge-node.ts revoke` goes further and does
     * not delete the row at all — it burns the token hash — precisely so
     * this column keeps pointing at a name.
     */
    judgeNodeId: bigint('judge_node_id', { mode: 'number' }).references(() => judgeNodes.id, {
      onDelete: 'set null',
    }),
    /**
     * Why a `queued` job is not being claimed — today only "no connected
     * judge speaks its language" (D68). NULL is the normal state and means
     * nothing is known to be wrong; `JobStore.claim` clears it in the same
     * UPDATE that claims, because being claimed disproves it.
     *
     * Text, not a new `grading_job_state` value: a blocked job IS queued —
     * claimable the instant a capable judge connects — and a state nothing
     * transitions out of by itself would need a sweeper to undo it.
     */
    blockedReason: text('blocked_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // D47, as amended by migration 0025. `grading_jobs` keeps every job
    // forever (D11), and the dashboard's queue and worker panels only ever
    // ask about jobs that are NOT done — a set bounded by how many judges
    // are running, not by how long the judge has existed. A PARTIAL index
    // carries an entry only while the predicate holds, so it is 16 kB beside
    // a 21 MB table at 200 000 rows and does not grow with history: the row
    // enters the index on insert and leaves it when the job finishes.
    // Measured: the queue aggregate went from a 200 000-row parallel seq
    // scan (22.9 ms) to a 150-row index scan (0.9 ms).
    index('grading_jobs_active_idx').on(t.state).where(sql`${t.state} <> 'done'`),
    // NOT the dashboard's index — the foreign key's. `submission_id`
    // references `submissions` ON DELETE CASCADE, and Postgres creates no
    // index for a foreign key on its own, so every cascaded submission
    // delete sequentially scanned this whole table to find the children.
    // The worker panel's throughput join rides on it too.
    index('grading_jobs_submission_idx').on(t.submissionId),
  ],
);
