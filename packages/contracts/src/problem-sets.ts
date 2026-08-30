/**
 * Classroom problem sets — "bài tập về nhà", a school's homework (D66).
 *
 * A separate module from `orgs.ts`, registered under the SAME
 * `Organizations` tag: every route lives under `/orgs/{slug}`, and a set
 * belongs to a school the way a roster does. The file split is size, not
 * domain — `orgs.ts` is already the longest contract in the package.
 */
import { z } from 'zod';
import { PaginationQuery, ProblemDetails, Timestamp, cursorPage } from './common.js';
import { ORG_SLUG } from './orgs.js';
import { Verdict } from './submissions.js';
import { registry } from './registry.js';

/**
 * The same shape as an organization's own slug, deliberately: a set's URL is
 * `/orgs/{slug}/sets/{setSlug}`, and two slug grammars in one path is two
 * rules a teacher has to learn to name a thing.
 */
export const PROBLEM_SET_SLUG = ORG_SLUG;

/**
 * The largest set one assignment may carry. A bound rather than none: the
 * detail serves one row per item with the viewer's best submission on each,
 * and the progress grid serves that per member as well — a set of ten
 * thousand problems is a grid nobody renders and a query nobody wants.
 */
export const PROBLEM_SET_MAX_ITEMS = 200;

export const ProblemSetItemInput = z.object({
  /** The problem's `code`. Resolved, and visibility-checked, at write time. */
  code: z.string().min(1).max(64),
  /**
   * What the problem is worth **in this set**, which is not the problem's own
   * total — the same reasoning `ContestProblem.points` records. The cells of
   * the progress grid still carry the raw `points`/`maxPoints` the judge
   * recorded; nothing is scaled server-side.
   */
  points: z.number().int().min(0).max(1_000_000).default(100),
});
export type ProblemSetItemInputDto = z.infer<typeof ProblemSetItemInput>;

/**
 * One person's best submission to one problem, under one deadline.
 *
 * `verdict`/`points`/`maxPoints` are `ProblemMe`'s three fields, for
 * `ProblemMe`'s reasons: a CE or an IE must be representable rather than
 * read as "never attempted", so both numbers are nullable and the row is
 * chosen on `verdict IS NOT NULL` — "graded" — not on having a score.
 *
 * "Best" is maximum `points`, ties broken by the earliest submission, which
 * is `ProblemMe`'s rule and `submissions_user_problem_points_idx`'s order.
 *
 * `solvedAt` is non-null only for an `AC`: "solved at" is a claim about
 * solving it, and a 40/100 partial has not.
 */
export const ProblemSetAttempt = z.object({
  verdict: Verdict,
  points: z.number().nullable(),
  maxPoints: z.number().nullable(),
  submittedAt: Timestamp,
  solvedAt: Timestamp.nullable(),
});
export type ProblemSetAttemptDto = z.infer<typeof ProblemSetAttempt>;

/**
 * What one person has done with one problem of the set: the best attempt
 * that beat the deadline, and — **separately** — the best one that did not
 * (D66). `null` when there is neither.
 *
 * Two entries rather than one attempt carrying a `late` flag, because the
 * flag loses the case homework is actually about: a pupil with an on-time
 * `WA` who solved it two days later. A single "best" cell shows either the
 * `WA` (and the teacher never learns they got there) or the `AC` (and the
 * deadline meant nothing). Both, side by side, is the only shape that says
 * what happened.
 *
 * `late` is always `null` when the set has no deadline — there is nothing to
 * be late for, and every attempt is `onTime`.
 */
export const ProblemSetCell = z
  .object({
    onTime: ProblemSetAttempt.nullable(),
    late: ProblemSetAttempt.nullable(),
  })
  .nullable();
export type ProblemSetCellDto = z.infer<typeof ProblemSetCell>;

/**
 * The viewer's own cell, on the set detail. Never masked: D23 exempts the
 * submitter from the freeze, and this is nobody else's submission.
 */
export const ProblemSetMe = ProblemSetCell;
export type ProblemSetMeDto = z.infer<typeof ProblemSetMe>;

export const ProblemSetItem = z.object({
  /** The problem's code — a link, not a copy of the statement. */
  code: z.string(),
  name: z.string(),
  order: z.number().int(),
  points: z.number().int(),
  /**
   * Whether the viewer may open the problem at all. A set is assigned to a
   * school, and a problem shared with that school stops being visible the
   * moment the setter narrows it — the item stays (the teacher assigned it),
   * but the page must not offer a link that 404s.
   */
  visible: z.boolean(),
  me: ProblemSetMe,
});
export type ProblemSetItemDto = z.infer<typeof ProblemSetItem>;

/**
 * A set as a list row.
 *
 * `itemCount` and `solvedCount` ride here rather than being derived from the
 * detail, for the reason `ProblemSummary.testCount` does: the org page draws
 * "3/5" on every row, and a request per row is the N+1 a summary exists to
 * prevent. `solvedCount` is the VIEWER's own — how many items they hold an
 * `AC` on, late ones included — never anybody else's; the grid is the
 * endpoint that answers about other people, and it is owner-only.
 */
export const ProblemSetSummary = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  deadline: Timestamp.nullable(),
  itemCount: z.number().int(),
  solvedCount: z.number().int(),
  createdAt: Timestamp,
});
export type ProblemSetSummaryDto = z.infer<typeof ProblemSetSummary>;

export const ProblemSetPage = cursorPage(ProblemSetSummary);
export type ProblemSetPageDto = z.infer<typeof ProblemSetPage>;

export const ProblemSetDetail = ProblemSetSummary.extend({
  items: z.array(ProblemSetItem),
});
export type ProblemSetDetailDto = z.infer<typeof ProblemSetDetail>;

export const CreateProblemSetRequest = z
  .object({
    slug: z.string().regex(PROBLEM_SET_SLUG),
    name: z.string().min(1).max(200),
    description: z.string().max(16_384).nullable().default(null),
    /**
     * When the homework is due, or `null` for a reading list. Inclusive: a
     * submission made AT the deadline is on time (D66).
     */
    deadline: Timestamp.nullable().default(null),
    problems: z.array(ProblemSetItemInput).max(PROBLEM_SET_MAX_ITEMS).default([]),
  })
  .strict();
export type CreateProblemSetRequestDto = z.infer<typeof CreateProblemSetRequest>;

/**
 * Every field optional; an absent one is left alone. `problems`, when
 * present, REPLACES the whole list — the same shape `UpdateProblemRequest`
 * gives `tags` and `members`, because a set is an ordered list and a partial
 * patch of an ordered list has no meaning a client could predict.
 */
export const UpdateProblemSetRequest = z
  .object({
    slug: z.string().regex(PROBLEM_SET_SLUG).optional(),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(16_384).nullable().optional(),
    deadline: Timestamp.nullable().optional(),
    problems: z.array(ProblemSetItemInput).max(PROBLEM_SET_MAX_ITEMS).optional(),
  })
  .strict();
export type UpdateProblemSetRequestDto = z.infer<typeof UpdateProblemSetRequest>;

/** One column of the progress grid: the set's items, in the set's order. */
export const ProblemSetColumn = z.object({
  code: z.string(),
  name: z.string(),
  points: z.number().int(),
});
export type ProblemSetColumnDto = z.infer<typeof ProblemSetColumn>;

/**
 * One row of the grid. The cells are `ProblemSetCell`s about somebody else,
 * with one addition D49 forces: a submission whose CONTEST participation
 * window is still open is counted for nobody, the teacher included. A set
 * that reuses a problem somebody is sitting right now must not turn the
 * homework grid into a live scoreboard of that room.
 */
export const ProblemSetProgressRow = z.object({
  username: z.string(),
  displayName: z.string(),
  role: z.enum(['owner', 'admin', 'member']),
  /** One entry per column, in the same order, `null` where there is nothing. */
  cells: z.array(ProblemSetCell),
});
export type ProblemSetProgressRowDto = z.infer<typeof ProblemSetProgressRow>;

/**
 * The grid. Deliberately NOT `cursorPage(row)`: a page of rows is
 * meaningless without the columns it is a grid against, and repeating the
 * columns inside every row would be the same list twenty-five times. `rows`
 * and `nextCursor` are exactly a cursor page's two fields under different
 * names, keyset on `username` — D58's roster cursor, because these rows ARE
 * the roster.
 */
export const ProblemSetProgress = z.object({
  slug: z.string(),
  name: z.string(),
  deadline: Timestamp.nullable(),
  columns: z.array(ProblemSetColumn),
  rows: z.array(ProblemSetProgressRow),
  nextCursor: z.string().nullable(),
});
export type ProblemSetProgressDto = z.infer<typeof ProblemSetProgress>;

/**
 * `?format=csv` answers `text/csv` instead of JSON — the same grid, one row
 * per member, one column per problem (two, `<code>` and `<code> (late)`,
 * when the set has a deadline, because that is the whole of what a deadline
 * buys a teacher).
 *
 * The CSV is the WHOLE roster, not one page (D66): the export exists because
 * a paged grid cannot be handed to a spreadsheet, and a file that stops after
 * twenty-five pupils is a file a teacher would silently mark a class from.
 * The JSON grid stays paged exactly as D58 requires.
 */
export const ProblemSetProgressQuery = PaginationQuery.extend({
  format: z.enum(['json', 'csv']).default('json'),
});
export type ProblemSetProgressQueryDto = z.infer<typeof ProblemSetProgressQuery>;

const OrgSlugParam = z.object({ slug: z.string() });
const SetParam = z.object({ slug: z.string(), setSlug: z.string() });

const NOT_SIGNED_IN = {
  description: 'Not signed in',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const FORBIDDEN = {
  description: 'Signed in, but not an owner or admin of this organization',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const ORG_NOT_FOUND = {
  description: 'No such organization, or one the caller may not see — the two are indistinguishable',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const SET_NOT_FOUND = {
  description:
    'No such set, one in an organization the caller may not see, or one in an organization the ' +
    'caller does not belong to — the three are indistinguishable (`problem_set_not_found`)',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const SET_VALIDATION_FAILED = {
  description:
    'The request failed validation. `problem_set_problem_unknown` — a `code` no problem has; ' +
    '`problem_set_problem_private` — a problem the organization’s own members could not open, ' +
    'which is refused rather than assigned (the set would be homework half the class cannot read).',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const SET_SLUG_TAKEN = {
  description: 'This organization already has a set with that slug (`problem_set_slug_taken`)',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};

registry.registerPath({
  method: 'get',
  path: '/orgs/{slug}/sets',
  tags: ['Organizations'],
  summary: "An organization's problem sets, with the caller's own progress on each",
  description:
    'Members only. A caller who can see the organization but does not belong to it gets an EMPTY ' +
    'page rather than a refusal (D66): homework is for the class, and "no sets" is exactly what a ' +
    'school that has assigned none returns — the same blanked-never-signalled shape D35 uses. An ' +
    'organization the caller may not see is 404, unchanged.',
  request: { params: OrgSlugParam, query: PaginationQuery },
  responses: {
    200: { description: 'A page of sets', content: { 'application/json': { schema: ProblemSetPage } } },
    401: NOT_SIGNED_IN,
    404: ORG_NOT_FOUND,
  },
});

registry.registerPath({
  method: 'get',
  path: '/orgs/{slug}/sets/{setSlug}',
  tags: ['Organizations'],
  summary: "One problem set, with the caller's own best submission on each problem",
  description:
    'Members only; a non-member gets the same 404 a set that does not exist gets. `me` is the ' +
    "caller's own best submission and is never masked — D23 exempts the submitter — but an " +
    'on-time submission always beats a late one, and a late one is flagged `late` rather than ' +
    'hidden (D66).',
  request: { params: SetParam },
  responses: {
    200: { description: 'The set', content: { 'application/json': { schema: ProblemSetDetail } } },
    401: NOT_SIGNED_IN,
    404: SET_NOT_FOUND,
  },
});

registry.registerPath({
  method: 'get',
  path: '/orgs/{slug}/sets/{setSlug}/progress',
  tags: ['Organizations'],
  summary: 'The whole class against the whole set — one row per member, one column per problem',
  description:
    'Owner or admin of the organization, or a global admin. Rows are the roster, keyset-paged on ' +
    'username exactly as `GET /orgs/{slug}/members` is (D58). `?format=csv` answers `text/csv` ' +
    'with the WHOLE roster rather than one page, because a file that stops after twenty-five ' +
    'pupils is a file somebody would mark a class from. A submission whose contest participation ' +
    'window is still open is counted for nobody, the teacher included (D49).',
  request: { params: SetParam, query: ProblemSetProgressQuery },
  responses: {
    200: {
      description: 'The grid',
      content: {
        'application/json': { schema: ProblemSetProgress },
        'text/csv': { schema: z.string() },
      },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: SET_NOT_FOUND,
  },
});

registry.registerPath({
  method: 'post',
  path: '/orgs/{slug}/sets',
  tags: ['Organizations'],
  summary: 'Assign a problem set (owner or admin)',
  request: {
    params: OrgSlugParam,
    body: { content: { 'application/json': { schema: CreateProblemSetRequest } } },
  },
  responses: {
    201: { description: 'The created set', content: { 'application/json': { schema: ProblemSetDetail } } },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: ORG_NOT_FOUND,
    409: SET_SLUG_TAKEN,
    422: SET_VALIDATION_FAILED,
  },
});

registry.registerPath({
  method: 'patch',
  path: '/orgs/{slug}/sets/{setSlug}',
  tags: ['Organizations'],
  summary: 'Edit a problem set (owner or admin)',
  description: '`problems`, when present, replaces the whole list — order included.',
  request: {
    params: SetParam,
    body: { content: { 'application/json': { schema: UpdateProblemSetRequest } } },
  },
  responses: {
    200: { description: 'The updated set', content: { 'application/json': { schema: ProblemSetDetail } } },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: SET_NOT_FOUND,
    409: SET_SLUG_TAKEN,
    422: SET_VALIDATION_FAILED,
  },
});

registry.registerPath({
  method: 'delete',
  path: '/orgs/{slug}/sets/{setSlug}',
  tags: ['Organizations'],
  summary: 'Withdraw a problem set (owner or admin)',
  request: { params: SetParam },
  responses: {
    204: { description: 'Deleted' },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: SET_NOT_FOUND,
  },
});
