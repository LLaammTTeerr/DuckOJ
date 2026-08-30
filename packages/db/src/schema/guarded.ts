import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './identity.js';
import { languages } from './judging.js';
import { packages } from './packages.js';
import { tags } from './tags.js';

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

export const orgJoinRequests = pgTable(
  'org_join_requests',
  {
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
  },
  (t) => [
    /**
     * At most one *pending* request per user per organization.
     *
     * Partial, so a rejection does not bar a later request — a rejection is a
     * decision about a moment, not a ban. The same shape as
     * `problem_revisions`' one-published-revision index, and for the same
     * reason: two concurrent requests must collide in the database rather than
     * race to two rows an approver then sees twice.
     */
    uniqueIndex('org_join_requests_pending_idx')
      .on(t.orgId, t.userId)
      .where(sql`${t.state} = 'pending'`),
  ],
);

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
    /**
     * The setter's own 1–10 estimate; `null` — the default, and what every
     * pre-existing problem migrates into — means "nobody has said". NOT
     * derived from solve rates: a problem with three attempts has no
     * statistics, and the number a teacher wants when building a practice
     * set is the one a human put there.
     *
     * `smallint`, with a CHECK rather than an enum: the range is arithmetic
     * (a `min`/`max` filter orders it), and an enum of ten members would
     * make widening the scale a migration of the type, not of one
     * constraint.
     */
    difficulty: smallint('difficulty'),
    /**
     * The setter's write-up of how the problem is solved (D43), Markdown in
     * the same vi+en shape as `statement` (D10). On the problem row rather
     * than on a revision: an editorial explains the *problem*, and a
     * republished test set does not invalidate it.
     */
    editorial: text('editorial'),
    /**
     * When the editorial was published — `null` while it is a draft. A
     * timestamp rather than a boolean so "since when" is answerable at all
     * (a later `?since=` feed, an audit of who saw what during a contest)
     * without a second migration; nothing reads it as a clock yet.
     */
    editorialPublishedAt: timestamp('editorial_published_at', { withTimezone: true }),
    currentRevisionId: bigint('current_revision_id', { mode: 'number' }),
    createdBy: bigint('created_by', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('problems_code_lower_idx').on(sql`lower(${t.code})`),
    // The range is the contract, not a convention held up by the zod schema
    // in front of it: a seed script, an importer or a psql session reaches
    // this table without passing `UpdateProblemRequest`, and a difficulty of
    // 0 or 47 would sort into a `min`/`max` filter as if it meant something.
    check('problems_difficulty_ck', sql`${t.difficulty} IS NULL OR (${t.difficulty} BETWEEN 1 AND 10)`),
    // A published editorial with nothing in it is not a state the product
    // has a meaning for: `editorialAvailable: true` would promise a page
    // that renders empty. The service refuses it with 422
    // `problem_editorial_empty` — this CHECK is the backstop for every
    // writer that never passes the service (a psql session, an importer),
    // and it is what makes "clearing the text unpublishes it" a rule the
    // database holds rather than a convention one UPDATE remembers.
    check(
      'problems_editorial_published_ck',
      sql`${t.editorialPublishedAt} IS NULL OR ${t.editorial} IS NOT NULL`,
    ),
  ],
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

/**
 * Which topics a problem carries. Guarded, unlike `tags` itself: a tag on a
 * problem is a hint, and D35 hides both these rows and `difficulty` from a
 * viewer sitting a running contest that uses the problem. That makes "which
 * tags does this problem have" an actor-dependent question — exactly what
 * `authz/` exists to be the only answerer of.
 *
 * `ON DELETE cascade` from `problems` (a deleted problem takes its
 * associations with it) but **`restrict` from `tags`**: dropping a tag row
 * that problems still carry would silently untag them, and a vocabulary
 * this small is edited by a migration, deliberately, not by a DELETE that
 * quietly rewrites content.
 */
export const problemTags = pgTable(
  'problem_tags',
  {
    problemId: bigint('problem_id', { mode: 'number' })
      .notNull()
      .references(() => problems.id, { onDelete: 'cascade' }),
    tagId: bigint('tag_id', { mode: 'number' })
      .notNull()
      .references(() => tags.id, { onDelete: 'restrict' }),
  },
  (t) => [
    primaryKey({ columns: [t.problemId, t.tagId] }),
    // The primary key already serves "this problem's tags"; this one serves
    // the other direction — `?tag=do-thi` over every problem carrying it.
    index('problem_tags_tag_idx').on(t.tagId, t.problemId),
  ],
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
  (t) => [
    index('submissions_user_problem_points_idx').on(t.userId, t.problemId, t.points.desc(), t.id),
    // D49's statistics: `GET /problems/{code}/stats` and the solved/attempted
    // counts on every row of `GET /problems` both group by `problem_id` and
    // count DISTINCT users, filtered on `verdict = 'AC'`. Postgres indexes no
    // foreign key on its own, and the composite above is led by `user_id`, so
    // without this the most public page in the app sequentially scanned a
    // table that grows forever (D11) once per render. All three columns are in
    // the index, in the order the group-by wants them, so the aggregate is an
    // index-only scan.
    index('submissions_problem_user_verdict_idx').on(t.problemId, t.userId, t.verdict),
    // D47's failures panel, as amended by migration 0025. `order by id desc
    // limit 20` over `verdict = 'IE' or state = 'errored'` reads beautifully
    // and scans catastrophically: an IE is an infrastructure failure, so a
    // healthy judge produces none for days, and the backward primary-key
    // scan therefore walks every clean submission since the last incident.
    // Measured at 200 000 rows with the newest failure 150 000 rows back:
    // 151 501 rows discarded by the filter, 7 084 buffers, 18.5 ms — and
    // linear in how long the judge has been healthy, which is the wrong way
    // round for a panel that exists to be read when nothing is wrong.
    //
    // The predicate is written to match that WHERE clause TEXTUALLY, `or`
    // included: a partial index only serves a query whose restriction
    // Postgres can prove implies the predicate, so rephrasing either side
    // silently drops back to the seq scan. `id desc` is in the index so the
    // ordering comes from the index too and the LIMIT stops after 20 entries
    // (74 buffers, 0.35 ms). 32 kB, holding one entry per failure rather
    // than one per submission.
    index('submissions_failed_idx')
      .on(t.id.desc())
      .where(sql`${t.verdict} = 'IE' or ${t.state} = 'errored'`),
    // The worker panel's throughput window (`judged_at > now() - 1 hour`).
    // A window bounds the rows RETURNED; only an index bounds the rows
    // SCANNED, and without this one the panel hash-joined all of
    // `submissions` to all of `grading_jobs` every 15 seconds. Unlike the
    // two partial indexes beside it this one is full — 4.4 MB per 200 000
    // rows, growing with history — which is the cost D47 declined to pay
    // against a guess and 0025 pays against a measurement.
    index('submissions_judged_at_idx').on(t.judgedAt),
  ],
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
     * Minutes of scoreboard freeze before `end_time`; `0` is no freeze (D22).
     * Refused at write time unless it is strictly shorter than the contest —
     * a freeze as long as the contest hides all of it. The formats read the
     * clock through an injected `now`, never `Date.now()`.
     */
    frozenLastMinutes: integer('frozen_last_minutes').notNull().default(0),
    /** `null` means "no per-participant time limit", which also pins `start`. */
    timeLimitSeconds: integer('time_limit_seconds'),
    visibility: contestVisibility('visibility').notNull().default('private'),
    /**
     * Whether this contest's results feed the rating system.
     *
     * Set by an administrator, never by the contest ending: "the contest is
     * over" and "the results are final" are different claims, and the gap
     * between them is where broken test data gets found.
     */
    isRated: boolean('is_rated').notNull().default(false),
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
  (t) => [
    primaryKey({ columns: [t.contestId, t.orgId] }),
    // The primary key walks `contest_id` first, so "which contests belong to
    // this organization" — the org page's own list, and the `?org=` filter
    // behind it — had no index at all and scanned the table (0023).
    index('contest_orgs_org_idx').on(t.orgId),
  ],
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
      .references(() => contestProblems.id, { onDelete: 'restrict' }),
    submissionId: bigint('submission_id', { mode: 'number' })
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('contest_submissions_submission_idx').on(t.submissionId),
    /**
     * D95's organiser monitor, migration 0035. Every question the monitor
     * asks is "what has happened in THIS contest", and the only way in from a
     * contest is `contest_problems.id` — which had no index here at all, so
     * each of the four panels scanned every contest submission the deployment
     * has ever taken (D11 keeps them forever). `id` rides along so the live
     * feed's `order by id desc limit 50` is served per problem by a `LATERAL`
     * index scan rather than by sorting the whole contest.
     */
    index('contest_submissions_contest_problem_idx').on(t.contestProblemId, t.id),
    /**
     * A missing foreign-key index under `ON DELETE CASCADE` — the same bug
     * D47's amendment found on `grading_jobs (submission_id)`. Until 0035
     * every cascaded delete of a participation (a contest removed, a user
     * removed) sequentially scanned this table.
     */
    index('contest_submissions_participation_idx').on(t.participationId),
  ],
);

/**
 * The materialized result of the rating fold — an audit trail, **not an input**.
 *
 * Dropping every row here and replaying must reproduce them exactly; 4f's
 * design §2 makes that the phase's acceptance criterion. Rankings are
 * recomputed during a replay rather than snapshotted, because foundation §9
 * requires a corrected scoreboard to propagate forward into every rating that
 * followed it.
 */
export const ratingEvents = pgTable(
  'rating_event',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    contestId: bigint('contest_id', { mode: 'number' })
      .notNull()
      .references(() => contests.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ratingBefore: integer('rating_before').notNull(),
    rdBefore: doublePrecision('rd_before').notNull(),
    volatilityBefore: doublePrecision('volatility_before').notNull(),
    ratingAfter: integer('rating_after').notNull(),
    rdAfter: doublePrecision('rd_after').notNull(),
    volatilityAfter: doublePrecision('volatility_after').notNull(),
    /** The rank this rating was computed from, as the scoreboard reported it. */
    rank: integer('rank').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('rating_event_identity_idx').on(t.contestId, t.userId)],
);

/**
 * `private` — the asker and the organisers; `public` — everyone who may see
 * the contest, signed in or not. Two values, an enum rather than a boolean,
 * because a third state ("withdrawn") is the kind of thing a contest day
 * asks for and a boolean cannot grow one.
 */
export const clarificationVisibility = pgEnum('clarification_visibility', ['private', 'public']);

/**
 * Contest-day Q&A: a participant's question and the organiser's answer, in
 * one row (D31). An **announcement** is the same row with no `question` —
 * `answer` carries the text, `visibility` is `public`, and `asked_by` is the
 * organiser who posted it, because `asked_by` means "who wrote this row",
 * not "who is waiting for a reply".
 *
 * Guarded: which rows a viewer may read depends on the contest's own
 * visibility AND on who they are inside it, so every read goes through
 * `apps/api/src/authz/contest.clarifications.ts` and never through a direct
 * query.
 */
export const contestClarifications = pgTable(
  'contest_clarifications',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    contestId: bigint('contest_id', { mode: 'number' })
      .notNull()
      .references(() => contests.id, { onDelete: 'cascade' }),
    /**
     * The contest problem this is about, or `null` for the contest as a
     * whole. References `problems`, not `contest_problems`: the question
     * survives the contest problem list being reshuffled, and the write path
     * checks the problem is actually attached to this contest.
     */
    problemId: bigint('problem_id', { mode: 'number' }).references(() => problems.id),
    /** Who wrote the row — a participant asking, or an organiser announcing. */
    askedBy: bigint('asked_by', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `null` on an announcement, which is the whole of what makes it one. */
    question: text('question'),
    answer: text('answer'),
    answeredBy: bigint('answered_by', { mode: 'number' }).references(() => users.id),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    visibility: clarificationVisibility('visibility').notNull().default('private'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('contest_clarifications_contest_idx').on(t.contestId, t.id),
    /**
     * A row with neither a question nor an answer is a blank line in a feed
     * two thousand students are reading. Refused in the database, not only
     * in the service: the service is one caller, the table is forever.
     */
    check('contest_clarifications_text_ck', sql`${t.question} IS NOT NULL OR ${t.answer} IS NOT NULL`),
  ],
);

/**
 * A named set of problems a school assigns to its own members — "bài tập về
 * nhà", homework (D66). One row per assignment; `problem_set_items` carries
 * what is in it.
 *
 * Guarded, and not because a set is a secret: which sets a viewer may read
 * depends on the ORGANIZATION's visibility and on whether the viewer belongs
 * to it, and the items can name problems whose own visibility is `org` —
 * shared with this school and with nobody else. Both questions are answered
 * in `apps/api/src/authz/problem-set.access.ts` and never by a direct query.
 *
 * `slug` is unique per organization, case-insensitively (`problem_sets_org_slug_lower_idx`),
 * for the reason `organizations_slug_lower_idx` is: two sets whose names
 * differ only in case are two URLs a teacher cannot tell apart.
 *
 * `deadline` is nullable — an assignment with no due date is a reading list,
 * which is a thing a school hands out — and it is what "best" is measured
 * against when it is set (D66).
 */
export const problemSets = pgTable(
  'problem_sets',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: bigint('org_id', { mode: 'number' })
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    /** Markdown, the same shape as a problem statement (D10). */
    description: text('description'),
    deadline: timestamp('deadline', { withTimezone: true }),
    /**
     * The teacher who assigned it. No `onDelete` — the same choice
     * `contests.created_by` makes: a set outlives the account that created
     * it, and cascading would delete a class's homework along with a
     * departing teacher.
     */
    createdBy: bigint('created_by', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('problem_sets_org_slug_lower_idx').on(t.orgId, sql`lower(${t.slug})`)],
);

/**
 * One problem in one set, in the order the teacher put it, worth `points`.
 *
 * `points` is the set's own value for the problem — the same reasoning
 * `contest_problems.points` records: the same problem is worth 100 in this
 * week's homework and 50 in next week's, and scoring against the problem's
 * own total passes every scenario where the two happen to be equal.
 *
 * `problem_id` has no `onDelete` clause on purpose: deleting a problem that a
 * school has assigned should fail loudly rather than silently shorten
 * somebody's homework.
 */
export const problemSetItems = pgTable(
  'problem_set_items',
  {
    setId: bigint('set_id', { mode: 'number' })
      .notNull()
      .references(() => problemSets.id, { onDelete: 'cascade' }),
    problemId: bigint('problem_id', { mode: 'number' })
      .notNull()
      .references(() => problems.id),
    order: integer('order').notNull(),
    points: integer('points').notNull().default(100),
  },
  (t) => [
    // A problem appears at most once in a set — the primary key, not a
    // separate id: there is nothing else to reference a row of this table by.
    primaryKey({ columns: [t.setId, t.problemId] }),
    // The read order of every screen this table has (`order, problem_id`),
    // so rendering a set is an index scan rather than a sort.
    index('problem_set_items_order_idx').on(t.setId, t.order),
  ],
);

/**
 * One source-similarity check over one contest (D77) — the job row AND its
 * result, in the same table.
 *
 * **Guarded**, and not marginally so: a row here names two competitors, a
 * problem and two submission ids, and says they look alike. That is the most
 * defamatory thing this database stores. Every read goes through
 * `apps/api/src/contests/similarity.service.ts`'s `canRunContest` gate.
 *
 * `pairs` is a jsonb SUMMARY rather than a child table, because the whole
 * document is written once, read whole, and replaced by the next run: there
 * is no query that wants one pair, no foreign key anybody would follow, and
 * a `similarity_pairs` table would be five hundred rows per run to serve a
 * screen that renders all of them at once. Its shape is
 * `SimilarityRunSummary` in the API, which is the authority on it.
 *
 * `status` is plain text on `contests.format`'s precedent rather than an
 * enum: `running` / `finished` / `failed` is a state machine that lives in
 * one service, and an enum would make adding a state a migration.
 */
export const similarityRuns = pgTable(
  'similarity_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    contestId: bigint('contest_id', { mode: 'number' })
      .notNull()
      .references(() => contests.id, { onDelete: 'cascade' }),
    /** `running`, `finished` or `failed`. */
    status: text('status').notNull(),
    /**
     * The containment above which a pair is reported, as it was AT THE TIME
     * (D77). Stored per run rather than read from a setting: a report is a
     * record of what was asked, and re-reading today's threshold would
     * relabel a run made last month with a number nobody chose for it.
     */
    threshold: doublePrecision('threshold').notNull(),
    /** The organiser who asked. `set null` — the run outlives the account. */
    requestedBy: bigint('requested_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    /** `null` while the run is still going. */
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** `SimilarityRunSummary`; `null` until the run finishes. */
    pairs: jsonb('pairs'),
    /** An error CODE for a failed run, never a stack trace. */
    error: text('error'),
  },
  (t) => [
    // "The latest run of this contest", which is what every read here asks
    // for, as an index scan rather than a sort over a contest's history.
    index('similarity_runs_contest_idx').on(t.contestId, t.startedAt),
  ],
);
