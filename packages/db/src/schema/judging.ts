import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
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
import {
  MEMORY_EXTRA_KB_MAX,
  MEMORY_EXTRA_KB_MIN,
  TIME_MULTIPLIER_PCT_MAX,
  TIME_MULTIPLIER_PCT_MIN,
} from '@duckoj/language-limits';
import { problems, problemRevisions, submissions } from './guarded.js';

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
    /**
     * How much of the problem's authored time limit this language gets, as a
     * WHOLE PERCENT of it — 100 is "exactly what the setter wrote", 300 is
     * triple (D154).
     *
     * An integer percent rather than a float multiplier because the same
     * arithmetic runs in two processes: the API computes it to DISPLAY a
     * limit and `judged` computes it to ENFORCE one, and a scoreboard that
     * says 2.0 s while the judge allowed 6.0 s is the lie this column exists
     * to prevent. `ceil(ms * pct / 100)` over integers is bit-identical
     * everywhere; `ms * 3.0` in IEEE-754 is not guaranteed to be.
     */
    timeMultiplierPct: integer('time_multiplier_pct').notNull().default(100),
    /**
     * Kilobytes ADDED to the problem's authored memory limit for this
     * language — not a multiplier, on purpose (D154).
     *
     * An interpreter's cost is a fixed floor, not a proportion: CPython 3.11
     * in this judge's own image occupies 15044 KB before the solution
     * allocates a single byte, and that 15 MB is the same 15 MB whether the
     * problem allows 16 MB or 512 MB. A multiplier would under-pay the tight
     * problem (where the floor is nearly the whole budget) and hand the
     * generous one hundreds of megabytes it has no use for.
     */
    memoryExtraKb: integer('memory_extra_kb').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('languages_key_idx').on(t.key),
    // D159. The bounds are the constants' — `sql.raw` so the numbers are
    // baked into the DDL rather than sent as parameters, and
    // `language-limit-bounds.spec.ts` reads them back out of `pg_constraint`
    // and fails if this file and `@duckoj/language-limits` ever disagree.
    check(
      'languages_time_multiplier_pct_ck',
      sql`${t.timeMultiplierPct} BETWEEN ${sql.raw(String(TIME_MULTIPLIER_PCT_MIN))} AND ${sql.raw(String(TIME_MULTIPLIER_PCT_MAX))}`,
    ),
    check(
      'languages_memory_extra_kb_ck',
      sql`${t.memoryExtraKb} BETWEEN ${sql.raw(String(MEMORY_EXTRA_KB_MIN))} AND ${sql.raw(String(MEMORY_EXTRA_KB_MAX))}`,
    ),
  ],
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

/**
 * A problem's own answer to `languages`' defaults, per (problem, language).
 *
 * Keyed on the PROBLEM, not on the revision, although the limits it adjusts
 * (`problem_revisions.time_ms` / `memory_kb`) live on the revision. A setter
 * saying "Python gets no bonus here, the whole point is the constant factor"
 * is stating something about the PROBLEM, and a statement about the problem
 * must survive republishing its tests — a per-revision override would be
 * silently dropped by the next `package:build`, which is exactly when nobody
 * is looking at it.
 *
 * Absent is the normal case, and means "inherit the language's defaults".
 * Both numeric columns are nullable for the same reason: a row that pins the
 * time and says nothing about memory should keep inheriting the memory
 * floor, so NULL is "inherit" and is distinguishable from an explicit 0.
 */
export const problemLanguageLimits = pgTable(
  'problem_language_limits',
  {
    problemId: bigint('problem_id', { mode: 'number' })
      .notNull()
      .references(() => problems.id, { onDelete: 'cascade' }),
    languageId: bigint('language_id', { mode: 'number' })
      .notNull()
      .references(() => languages.id, { onDelete: 'cascade' }),
    /** NULL inherits `languages.time_multiplier_pct`. */
    timeMultiplierPct: integer('time_multiplier_pct'),
    /** NULL inherits `languages.memory_extra_kb`. */
    memoryExtraKb: integer('memory_extra_kb'),
    /**
     * `false` refuses submissions in this language for this problem.
     *
     * A separate flag rather than a multiplier of 0, because they say
     * different things and only one of them is honest. "This problem is about
     * the constant factor and Python cannot express the intended solution" is
     * a REFUSAL — a 404 at submit time with a reason — not a time limit of
     * zero milliseconds, which would present as a TLE and teach the pupil
     * that their correct program was too slow.
     */
    allowed: boolean('allowed').notNull().default(true),
  },
  (t) => [
    primaryKey({ columns: [t.problemId, t.languageId] }),
    // The same bounds as `languages`, and they must be the same: this row
    // REPLACES that one column by column, so a range one table admits and
    // the other refuses would mean an override could say what a default
    // could not.
    //
    // `IS NULL OR` on both, and that is the whole reason these are written
    // out rather than reused: NULL is "inherit", not zero, and a CHECK that
    // did not say so would forbid the ordinary row — the one that pins the
    // time and keeps the interpreter's memory floor (D154).
    check(
      'problem_language_limits_time_multiplier_pct_ck',
      sql`${t.timeMultiplierPct} IS NULL OR (${t.timeMultiplierPct} BETWEEN ${sql.raw(String(TIME_MULTIPLIER_PCT_MIN))} AND ${sql.raw(String(TIME_MULTIPLIER_PCT_MAX))})`,
    ),
    check(
      'problem_language_limits_memory_extra_kb_ck',
      sql`${t.memoryExtraKb} IS NULL OR (${t.memoryExtraKb} BETWEEN ${sql.raw(String(MEMORY_EXTRA_KB_MIN))} AND ${sql.raw(String(MEMORY_EXTRA_KB_MAX))})`,
    ),
  ],
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
  (t) => [
    uniqueIndex('judge_nodes_name_idx').on(t.name),
    uniqueIndex('judge_nodes_token_idx').on(t.tokenHash),
  ],
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
    index('grading_jobs_active_idx')
      .on(t.state)
      .where(sql`${t.state} <> 'done'`),
    // NOT the dashboard's index — the foreign key's. `submission_id`
    // references `submissions` ON DELETE CASCADE, and Postgres creates no
    // index for a foreign key on its own, so every cascaded submission
    // delete sequentially scanned this whole table to find the children.
    // The worker panel's throughput join rides on it too.
    index('grading_jobs_submission_idx').on(t.submissionId),
  ],
);
