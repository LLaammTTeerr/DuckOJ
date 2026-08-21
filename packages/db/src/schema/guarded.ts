import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
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

/**
 * Who, beyond the submitter, an admin, and the problem's authors/curators,
 * may read submissions to this problem — including their source.
 *
 * `private` is the default and the state every pre-existing problem migrates
 * into: nobody else. `solved` additionally admits anyone holding an `AC` on
 * this problem. There is deliberately no `public` member (design §2.3):
 * adding an enum member later is cheap — this schema has done it once
 * already for `CE` — and granting access nobody asked for is not.
 */
export const problemSourceAccess = pgEnum('problem_source_access', ['private', 'solved']);
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
    /**
     * Deny by default, unlike `visibility` above: submissions to a problem
     * are readable only by their submitter, an admin, and the problem's
     * authors/curators until someone opts this problem into `solved`.
     */
    sourceAccess: problemSourceAccess('source_access').notNull().default('private'),
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

export const submissions = pgTable(
  'submissions',
  {
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
  },
  // Serves the `me` column's per-(viewer, problem) "best verdict" lookup
  // (`ProblemAccessService.listVisible`/`getVisible`) — a `LEFT JOIN
  // LATERAL` filtered to `user_id = ? AND problem_id = ?`, ordered by
  // `points DESC, id ASC`, `LIMIT 1`. Without this index that lookup
  // sequentially scans the whole table once per problem row in the list —
  // 50 scans for one page of results, worsening with every submission the
  // system ever takes. `points DESC` and `id` (ascending, its default) are
  // in the index so "max points, ties broken by the earliest submission" is
  // served by the index's own order, with no separate sort step.
  (t) => [index('submissions_user_problem_points_idx').on(t.userId, t.problemId, t.points.desc(), t.id)],
);

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

/**
 * Contests mirror problems on visibility — the same three states, decided by
 * the same predicate (`apps/api/src/authz/visibility.ts`). A private contest
 * 404s rather than 403s, exactly as a private problem does.
 */
export const contestVisibility = pgEnum('contest_visibility', ['private', 'org', 'public']);

export const contests = pgTable(
  'contests',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    startTime: timestamp('start_time', { withTimezone: true }).notNull(),
    endTime: timestamp('end_time', { withTimezone: true }).notNull(),
    /**
     * Plain text, deliberately not an enum (design §3): formats are pluggable,
     * and an enum would make adding one a migration. `CONTEST_FORMATS` in
     * `@duckoj/contest-formats` is the authority on valid values, and an
     * unknown one is refused at write time — never stored.
     */
    format: text('format').notNull(),
    formatConfig: jsonb('format_config'),
    pointsPrecision: integer('points_precision').notNull().default(3),
    /**
     * Always 0 for now, and refused at write time when it is not: the formats
     * throw on a freeze window because `Contest.is_frozen` reads the wall
     * clock (4b ledger). A contest that accepted a freeze it does not honour
     * would be worse than one that refuses it.
     */
    frozenLastMinutes: integer('frozen_last_minutes').notNull().default(0),
    /** `null` means "no per-participant time limit", which also pins `start`. */
    timeLimitSeconds: integer('time_limit_seconds'),
    visibility: contestVisibility('visibility').notNull().default('private'),
    createdBy: bigint('created_by', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('contests_key_lower_idx').on(sql`lower(${t.key})`)],
);

/** Which organizations an `org`-visibility contest is shared with — mirrors `problem_orgs`. */
export const contestOrgs = pgTable(
  'contest_orgs',
  {
    contestId: bigint('contest_id', { mode: 'number' })
      .notNull()
      .references(() => contests.id, { onDelete: 'cascade' }),
    orgId: bigint('org_id', { mode: 'number' })
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.contestId, t.orgId] })],
);

export const contestProblems = pgTable(
  'contest_problems',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    contestId: bigint('contest_id', { mode: 'number' })
      .notNull()
      .references(() => contests.id, { onDelete: 'cascade' }),
    problemId: bigint('problem_id', { mode: 'number' })
      .notNull()
      .references(() => problems.id),
    /**
     * The setter's display label. NOT what a scoreboard shows: the format owns
     * that (`icpc` labels A, B, C; everyone else 1, 2, 3), and the goldens pin
     * the format's answer. This is here because design §3 asks for it and a
     * later listing screen will want it, not because the scoreboard reads it.
     */
    label: text('label').notNull(),
    /**
     * `ContestProblem.points` — the contest-scaled value, which is NOT the
     * problem's own total. The same problem is worth 200 here and 100 there;
     * scoring against the problem's own value passes every scenario where the
     * two happen to be equal (design §7).
     */
    points: doublePrecision('points').notNull(),
    partial: boolean('partial').notNull().default(true),
    order: integer('order').notNull(),
  },
  (t) => [uniqueIndex('contest_problems_problem_idx').on(t.contestId, t.problemId)],
);

export const contestParticipations = pgTable(
  'contest_participations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    contestId: bigint('contest_id', { mode: 'number' })
      .notNull()
      .references(() => contests.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startTime: timestamp('start_time', { withTimezone: true }).notNull(),
    /**
     * An integer, not a boolean (design §3): `0` is live, `-1` spectates, and
     * `n > 0` is the n-th virtual attempt. `default` excludes `virtual != 0`
     * from first-solve, and a boolean could not represent a second virtual
     * attempt at all.
     */
    virtual: integer('virtual').notNull().default(0),
    isDisqualified: boolean('is_disqualified').notNull().default(false),
  },
  (t) => [uniqueIndex('contest_participations_identity_idx').on(t.contestId, t.userId, t.virtual)],
);

export const contestSubmissions = pgTable(
  'contest_submissions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    participationId: bigint('participation_id', { mode: 'number' })
      .notNull()
      .references(() => contestParticipations.id, { onDelete: 'cascade' }),
    contestProblemId: bigint('contest_problem_id', { mode: 'number' })
      .notNull()
      .references(() => contestProblems.id, { onDelete: 'cascade' }),
    submissionId: bigint('submission_id', { mode: 'number' })
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    /**
     * `ContestSubmission.points` — the contest-scaled score of this submission.
     *
     * Denormalised per design §3. Note that the scoreboard does NOT read it:
     * 4b's `lower()` recomputes it from `submission_cases` on every read, and
     * `ioi16` ignores it entirely in favour of per-batch aggregation. It is
     * written with the same arithmetic (`contestSubmissionPoints`, exported
     * from `@duckoj/contest-formats`) so the two can never disagree, and is
     * kept for the record of what was scored and for the listing screens.
     */
    points: doublePrecision('points').notNull(),
  },
  (t) => [uniqueIndex('contest_submissions_submission_idx').on(t.submissionId)],
);
