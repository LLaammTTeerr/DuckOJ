import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './identity.js';
import { languages } from './judging.js';
import { packages } from './packages.js';

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

export const problemVisibility = pgEnum('problem_visibility', ['private', 'org', 'public']);
export const revisionState = pgEnum('revision_state', ['draft', 'published', 'archived']);
export const submissionState = pgEnum('submission_state', [
  'queued',
  'compiling',
  'grading',
  'done',
  'errored',
]);
export const caseVerdict = pgEnum('case_verdict', [
  'AC', 'WA', 'TLE', 'MLE', 'OLE', 'RTE', 'IR', 'CE', 'IE',
]);

export const problems = pgTable(
  'problems',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    statement: text('statement').notNull(),
    visibility: problemVisibility('visibility').notNull().default('public'),
    currentRevisionId: bigint('current_revision_id', { mode: 'number' }),
    createdBy: bigint('created_by', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('problems_code_lower_idx').on(sql`lower(${t.code})`)],
);

export const problemRevisions = pgTable(
  'problem_revisions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    problemId: bigint('problem_id', { mode: 'number' })
      .notNull()
      .references(() => problems.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    packageHash: text('package_hash')
      .notNull()
      .references(() => packages.hash),
    state: revisionState('state').notNull().default('draft'),
    createdBy: bigint('created_by', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    notes: text('notes'),
    /** Denormalised from the package manifest at attach time — see spec §5.1. */
    timeMs: integer('time_ms').notNull(),
    memoryKb: integer('memory_kb').notNull(),
    testCount: integer('test_count').notNull(),
    totalPoints: doublePrecision('total_points').notNull(),
    checkerKind: text('checker_kind').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('problem_revisions_version_idx').on(t.problemId, t.version),
    // At most one published revision per problem at any time — the invariant
    // publishRevision's archive-then-publish sequencing relies on. A row
    // lock (`SELECT ... FOR UPDATE` on the parent `problems` row) serialises
    // concurrent publishes in practice; this index is the second half of
    // that pairing (mirrors Task 1's `problem_revisions_version_idx`): it
    // makes the invariant impossible to violate even if some future caller
    // forgets the lock. Partial on `state = 'published'` so any number of
    // `draft`/`archived` rows coexist freely — only two 'published' rows for
    // the same problem collide.
    uniqueIndex('problem_revisions_one_published_idx')
      .on(t.problemId)
      .where(sql`${t.state} = 'published'`),
  ],
);

export const problemRole = pgEnum('problem_role', ['author', 'curator', 'tester']);

export const problemMembers = pgTable(
  'problem_members',
  {
    problemId: bigint('problem_id', { mode: 'number' })
      .notNull()
      .references(() => problems.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: problemRole('role').notNull(),
  },
  // `role` is in the key on purpose: DMOJ's separate authors/curators
  // relations let one person hold both, and a (problem, user) key would
  // force the deferred importer to discard one of them.
  (t) => [primaryKey({ columns: [t.problemId, t.userId, t.role] })],
);

export const problemOrgs = pgTable(
  'problem_orgs',
  {
    problemId: bigint('problem_id', { mode: 'number' })
      .notNull()
      .references(() => problems.id, { onDelete: 'cascade' }),
    orgId: bigint('org_id', { mode: 'number' })
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.problemId, t.orgId] })],
);

export const submissions = pgTable('submissions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: bigint('user_id', { mode: 'number' })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  problemId: bigint('problem_id', { mode: 'number' })
    .notNull()
    .references(() => problems.id),
  /** Pinned: this is which tests actually graded it, forever. */
  revisionId: bigint('revision_id', { mode: 'number' })
    .notNull()
    .references(() => problemRevisions.id),
  languageId: bigint('language_id', { mode: 'number' })
    .notNull()
    .references(() => languages.id),
  source: text('source').notNull(),
  state: submissionState('state').notNull().default('queued'),
  verdict: caseVerdict('verdict'),
  points: doublePrecision('points'),
  maxPoints: doublePrecision('max_points'),
  timeMs: integer('time_ms'),
  memoryKb: integer('memory_kb'),
  compileOutput: text('compile_output'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  judgedAt: timestamp('judged_at', { withTimezone: true }),
});

export const submissionCases = pgTable(
  'submission_cases',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    submissionId: bigint('submission_id', { mode: 'number' })
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    groupIndex: integer('group_index').notNull(),
    caseIndex: integer('case_index').notNull(),
    /** Null when the case was short-circuited and never ran. */
    verdict: caseVerdict('verdict'),
    skipped: boolean('skipped').notNull().default(false),
    flags: text('flags').array().notNull().default(sql`'{}'::text[]`),
    timeMs: integer('time_ms').notNull(),
    memoryKb: integer('memory_kb').notNull(),
    points: doublePrecision('points').notNull(),
    maxPoints: doublePrecision('max_points').notNull(),
    feedback: text('feedback'),
  },
  (t) => [
    // Makes at-least-once delivery harmless: a redelivered case collides.
    uniqueIndex('submission_cases_identity_idx').on(t.submissionId, t.attempt, t.groupIndex, t.caseIndex),
  ],
);
