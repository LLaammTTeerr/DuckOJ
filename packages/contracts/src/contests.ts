import { z } from 'zod';
import { PaginationQuery, ProblemDetails, Timestamp, cursorPage } from './common.js';
import { registry } from './registry.js';

export const CONTEST_KEY = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/**
 * The same three states problems have, decided by the same predicate
 * (`apps/api/src/authz/visibility.ts`). A private contest 404s for anyone who
 * may not see it — never 403 — and the list shows only what the caller may see.
 */
export const ContestVisibility = z.enum(['private', 'org', 'public']);
export type ContestVisibilityDto = z.infer<typeof ContestVisibility>;

/**
 * Deliberately a free string, not a `z.enum`.
 *
 * Formats are pluggable (foundation spec) and `CONTEST_FORMATS` in
 * `@duckoj/contest-formats` is the authority on which names exist. This
 * package is bundled into the browser and must not depend on any workspace
 * package other than `@duckoj/api-prefix`, so it cannot import that registry —
 * and duplicating the list here would create a second authority that drifts.
 * The API refuses an unknown format at write time with `unknown_contest_format`.
 */
export const ContestFormatName = z.string().min(1).max(64);

export const ContestProblemInput = z.object({
  /** The problem's `code`. Resolved, and visibility-checked, at write time. */
  code: z.string().min(1),
  /**
   * `ContestProblem.points` — what this problem is worth *in this contest*,
   * which is not the problem's own total. Design §7.
   */
  points: z.number().min(0),
  /** Whether partial credit applies in this contest. */
  partial: z.boolean().default(true),
  /**
   * The setter's display label. Defaults to the 1-based position. Note that a
   * scoreboard does not show this: the format owns scoreboard labels (`icpc`
   * labels A, B, C; the others 1, 2, 3) and the goldens pin the format's answer.
   */
  label: z.string().min(1).max(16).optional(),
});
export type ContestProblemInputDto = z.infer<typeof ContestProblemInput>;

export const CreateContestRequest = z
  .object({
    key: z.string().regex(CONTEST_KEY),
    name: z.string().min(1).max(200),
    startTime: Timestamp,
    endTime: Timestamp,
    format: ContestFormatName,
    formatConfig: z.record(z.string(), z.unknown()).nullable().default(null),
    pointsPrecision: z.number().int().min(0).max(9).default(3),
    /**
     * Minutes of scoreboard freeze before the end; `0` means no freeze (D22).
     * Must be **strictly less** than the contest's own duration in minutes —
     * a freeze as long as the contest hides all of it — which is checked
     * against the whole request rather than here, and refused with 422
     * `contest_freeze_too_long`.
     */
    frozenLastMinutes: z.number().int().min(0).default(0),
    timeLimitSeconds: z.number().int().positive().nullable().default(null),
    visibility: ContestVisibility.default('private'),
    /**
     * The organizations this contest belongs to — **who may join it**, and
     * (when `visibility` is `org`) who may see it at all. D56.
     *
     * Only slugs the caller OWNS or ADMINISTERS are accepted, unless they are
     * a global admin; anything else is `contest_org_unknown`, the same answer
     * an unknown slug gets, so this cannot probe for a private organization.
     */
    orgSlugs: z.array(z.string()).default([]),
    problems: z.array(ContestProblemInput).default([]),
  })
  .strict();
export type CreateContestRequestDto = z.infer<typeof CreateContestRequest>;

/**
 * `PATCH /contests/{key}` — every field optional, and **no `.default()`
 * anywhere**.
 *
 * Deliberately hand-written rather than `CreateContestRequest.partial()`.
 * That schema carries defaults (`visibility: 'private'`, `pointsPrecision: 3`,
 * `formatConfig: null`, …), and `.partial()` keeps them: an omitted
 * `visibility` would arrive at the service as the string `'private'`, so
 * every edit that did not mention visibility would quietly make the contest
 * private. Here, absent means absent, and the service reads it as "keep".
 *
 * `key` is not on this schema and the object is `.strict()`, so sending one
 * is a 422 rather than a silently ignored field: a contest's key is its URL,
 * every link to it, and the value `POST /submissions` takes — renaming it is
 * not an edit, it is a different contest.
 */
export const UpdateContestRequest = z
  .object({
    name: z.string().min(1).max(200).optional(),
    startTime: Timestamp.optional(),
    endTime: Timestamp.optional(),
    format: ContestFormatName.optional(),
    formatConfig: z.record(z.string(), z.unknown()).nullable().optional(),
    pointsPrecision: z.number().int().min(0).max(9).optional(),
    /**
     * See `CreateContestRequest.frozenLastMinutes`. The "shorter than the
     * contest" check runs against the MERGED state, so shrinking a contest's
     * window under a freeze it already stores is refused too.
     */
    frozenLastMinutes: z.number().int().min(0).optional(),
    timeLimitSeconds: z.number().int().positive().nullable().optional(),
    visibility: ContestVisibility.optional(),
    /**
     * Editable since D56 — it used to be absent here, which left an
     * org-restricted contest's roster of organizations unchangeable for the
     * life of the contest (a school could not fix a slug it typed wrong).
     *
     * Present means REPLACE the whole set, exactly as `problems` does; absent
     * means keep. `[]` is therefore a real instruction — drop every
     * restriction — and is refused only when the merged `visibility` is
     * `org`, which would leave the contest visible to nobody.
     */
    orgSlugs: z.array(z.string()).optional(),
    problems: z.array(ContestProblemInput).optional(),
  })
  .strict();
export type UpdateContestRequestDto = z.infer<typeof UpdateContestRequest>;

export const ContestProblemSummary = z.object({
  code: z.string(),
  name: z.string(),
  label: z.string(),
  points: z.number(),
  partial: z.boolean(),
  order: z.number().int(),
});
export type ContestProblemSummaryDto = z.infer<typeof ContestProblemSummary>;

/**
 * One organization a contest is restricted to, as every contest response
 * carries it: enough to render a link, and nothing more.
 *
 * Shown to **everyone who can see the contest**, a private organization
 * included. Attaching an organization to a contest publishes its slug and
 * name — the refusal a non-member gets on `join` is unreadable otherwise,
 * and "you may not join, and I will not say why" is the worse answer (D56).
 */
export const ContestOrg = z.object({ slug: z.string(), name: z.string() });
export type ContestOrgDto = z.infer<typeof ContestOrg>;

export const ContestSummary = z.object({
  id: z.number().int(),
  key: z.string(),
  name: z.string(),
  startTime: Timestamp,
  endTime: Timestamp,
  format: z.string(),
  visibility: ContestVisibility,
  pointsPrecision: z.number().int(),
  frozenLastMinutes: z.number().int(),
  timeLimitSeconds: z.number().int().nullable(),
  /** Whether this contest feeds ratings — set by an admin after the fact. */
  isRated: z.boolean(),
  /**
   * The organizations that may join this contest (D56). Empty means anyone
   * who can see it may join.
   */
  orgs: z.array(ContestOrg),
  createdAt: Timestamp,
});
export type ContestSummaryDto = z.infer<typeof ContestSummary>;

export const ContestPage = cursorPage(ContestSummary);
export type ContestPageDto = z.infer<typeof ContestPage>;

export const ContestDetail = ContestSummary.extend({
  formatConfig: z.record(z.string(), z.unknown()).nullable(),
  /**
   * Whether THIS caller may edit the contest — and, by the same rule,
   * disqualify its participants: the creator, or a global admin.
   *
   * Served rather than derived client-side. The browser has no reliable way
   * to work it out: `createdBy` is not on this response (and putting it here
   * to let a client compare ids would be a worse answer), and "am I an
   * admin?" is a second request the page would have to make anyway. One
   * boolean the server already knows beats two facts the client has to
   * assemble — and it cannot drift from the server's own check, which is
   * still the thing that actually refuses the write.
   */
  canEdit: z.boolean(),
  /**
   * EMPTY until the contest starts, for everyone but a global admin — a
   * private problem attached to a future contest must not leak its code and
   * name through this route (its own route 404s the same caller).
   */
  problems: z.array(ContestProblemSummary),
});
export type ContestDetailDto = z.infer<typeof ContestDetail>;

/**
 * The scoreboard, in **snake_case**, deliberately — the one place in this
 * package that breaks the camelCase convention.
 *
 * This shape mirrors the `scoreboard.json` of every fixture under
 * `fixtures/contest-goldens/` field for field, because those 23 goldens are
 * what pins the whole contest stack: 4b's formats produce exactly this, and
 * 4c's replay compares exactly this against the goldens. Renaming the fields for the API would put a translation layer
 * between the goldens and the code they are supposed to pin — and a
 * translation layer that is wrong in one direction is invisible to a test that
 * only ever goes the other way.
 *
 * Hand-written rather than derived from `@duckoj/contest-formats`: this
 * package is bundled into the browser and depends on no workspace package.
 * `apps/api/test/contests.spec.ts` parses a real scoreboard against it, which
 * is what stops the two drifting apart.
 */
export const ScoreboardFormatData = z.object({
  points: z.number(),
  time: z.number(),
  /** `icpc` only — the other three formats emit just `points` and `time`. */
  frozen_points: z.number().optional(),
  tries: z.number().optional(),
  frozen_tries: z.number().optional(),
  is_frozen: z.boolean().optional(),
});
export type ScoreboardFormatDataDto = z.infer<typeof ScoreboardFormatData>;

export const ScoreboardRankingRow = z.object({
  rank: z.number().int(),
  participant: z.string(),
  /** `0` live, `-1` spectating (never ranked), `n > 0` the n-th virtual attempt. */
  virtual: z.number().int(),
  is_disqualified: z.boolean(),
  score: z.number(),
  cumtime: z.number(),
  tiebreaker: z.number(),
  frozen_score: z.number(),
  frozen_cumtime: z.number(),
  frozen_tiebreaker: z.number(),
  submission_count: z.number().int(),
  format_data: z.record(z.string(), ScoreboardFormatData),
  /**
   * Problem code → attempts the freeze is hiding from this row (D22).
   * Present on every row iff the board is `frozen`, absent otherwise — and
   * it can name a problem `format_data` has no cell for, which is exactly why
   * it is a field of its own.
   */
  pending: z.record(z.string(), z.number().int()).optional(),
});
export type ScoreboardRankingRowDto = z.infer<typeof ScoreboardRankingRow>;

export const ScoreboardProblem = z.object({
  code: z.string(),
  /** The **format's** label, not `contest_problems.label`. */
  label: z.string(),
  points: z.number(),
  /** `null` unless the problem has a published revision to scale against. */
  points_scaling_factor: z.number().nullable(),
  total_ac: z.number().int(),
  first_solve: z.string().nullable(),
});
export type ScoreboardProblemDto = z.infer<typeof ScoreboardProblem>;

export const Scoreboard = z.object({
  label_by_problem: z.record(z.string(), z.string()),
  problems: z.array(ScoreboardProblem),
  ranking: z.array(ScoreboardRankingRow),
  /**
   * Whether this response hides anything: a ranked participation is inside
   * its freeze window right now (D22). The contest's creator and global
   * admins always read `false` — they are served the live board.
   *
   * camelCase beside a snake_case object on purpose: the snake_case fields
   * are the goldens' own shape, frozen from DMOJ; these two are DuckOJ's.
   */
  frozen: z.boolean(),
  /** `endTime − frozenLastMinutes` whenever there is a freeze window; else null. */
  frozenAt: Timestamp.nullable(),
});
export type ScoreboardDto = z.infer<typeof Scoreboard>;

const ContestKeyParam = z.object({ key: z.string() });

const CONTEST_NOT_FOUND = {
  description: 'No such contest, or one the caller may not see — the two are indistinguishable',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const NOT_SIGNED_IN = {
  description: 'Not signed in',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const FORBIDDEN = {
  description: 'Signed in, but not permitted to create a contest',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const BAD_REQUEST = {
  description:
    'An unknown format (`unknown_contest_format`), an end before the start, an unknown problem, ' +
    'an organization the caller does not own or administer (`contest_org_unknown`), or an ' +
    '`org`-visible contest with no organization at all (`contest_org_missing`)',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const VALIDATION_FAILED = {
  description:
    'The request failed validation, or the freeze window is not shorter than the contest ' +
    '(`contest_freeze_too_long`)',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};

export const ContestListQuery = PaginationQuery.extend({
  /**
   * An organization's slug: only contests restricted to it (D56).
   *
   * A slug that names nothing, or an organization the caller may not see,
   * answers an EMPTY page — never 404. The filter must not become the
   * existence oracle `GET /orgs/{slug}` is careful not to be.
   */
  org: z.string().min(1).max(64).optional(),
});
export type ContestListQueryDto = z.infer<typeof ContestListQuery>;

registry.registerPath({
  method: 'get',
  path: '/contests',
  tags: ['Contests'],
  summary: 'Contests visible to the caller',
  request: { query: ContestListQuery },
  responses: {
    200: { description: 'A page of contests', content: { 'application/json': { schema: ContestPage } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/contests/{key}',
  tags: ['Contests'],
  summary: 'A single contest visible to the caller, with its problems',
  request: { params: ContestKeyParam },
  responses: {
    200: { description: 'The contest', content: { 'application/json': { schema: ContestDetail } } },
    404: CONTEST_NOT_FOUND,
  },
});

registry.registerPath({
  method: 'get',
  path: '/contests/{key}/scoreboard',
  tags: ['Contests'],
  summary: "The contest's scoreboard, computed by its format",
  request: { params: ContestKeyParam },
  responses: {
    200: {
      description:
        'The scoreboard — snake_case, mirroring the goldens field for field, plus `frozen`, ' +
        '`frozenAt` and per-row `pending` for the freeze window',
      content: { 'application/json': { schema: Scoreboard } },
    },
    404: CONTEST_NOT_FOUND,
    409: {
      description:
        'Not started (`contest_not_started`) — the scoreboard and its problem codes/names are ' +
        'concealed pre-start from everyone but a global admin — or the contest cannot be scored ' +
        'as configured: an `ioi16` problem with no published revision (or an all-zero dataset) ' +
        'has nothing to scale against (`contest_problem_missing_dataset`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

/**
 * `?lang=` on the booklet — which half of a bilingual statement (D10) is
 * printed. Defaults to `vi`, the province's own language; a statement with
 * no `## English` / `## Tiếng Việt` split is printed whole under either
 * value, because a monolingual statement is still the statement.
 */
export const BookletQuery = z.object({ lang: z.enum(['vi', 'en']).default('vi') });
export type BookletQueryDto = z.infer<typeof BookletQuery>;

registry.registerPath({
  method: 'get',
  path: '/contests/{key}/booklet.pdf',
  tags: ['Contests'],
  summary: 'Every problem of the contest as one printable PDF booklet',
  description:
    'A cover page (name, window, per-problem time and memory limits), then each problem in ' +
    'contest order behind a page break, headed with its contest label. Visibility is exactly ' +
    "the contest's problem LIST: before the start it is concealed from everyone but the people " +
    'who run the contest, and concealed means 404 — the same answer a contest you may not see ' +
    'gives, so the route is no more of an existence oracle than `GET /contests/{key}` is.',
  request: { params: ContestKeyParam, query: BookletQuery },
  responses: {
    200: {
      description: 'The rendered booklet',
      content: { 'application/pdf': { schema: z.string() } },
    },
    404: CONTEST_NOT_FOUND,
    501: {
      description: 'This server has no typst binary configured (`statement_pdf_unavailable`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: VALIDATION_FAILED,
  },
});

registry.registerPath({
  method: 'post',
  path: '/contests',
  tags: ['Contests'],
  summary: 'Create a contest (setter or admin)',
  request: { body: { content: { 'application/json': { schema: CreateContestRequest } } } },
  responses: {
    201: { description: 'The created contest', content: { 'application/json': { schema: ContestDetail } } },
    400: BAD_REQUEST,
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    409: {
      description: 'That contest key is already taken',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: VALIDATION_FAILED,
  },
});

registry.registerPath({
  method: 'patch',
  path: '/contests/{key}',
  tags: ['Contests'],
  summary: 'Edit a contest (its creator, or an admin)',
  description:
    'Every field is optional and an absent one is left alone. `format` and `problems` are frozen ' +
    'once the contest has started — sending the value it already has is still a no-op, not a refusal.',
  request: {
    params: ContestKeyParam,
    body: { content: { 'application/json': { schema: UpdateContestRequest } } },
  },
  responses: {
    200: { description: 'The contest, after the edit', content: { 'application/json': { schema: ContestDetail } } },
    400: BAD_REQUEST,
    401: NOT_SIGNED_IN,
    404: {
      description:
        'No such contest, one the caller may not see, or one they may see but do not run — all ' +
        'answered identically (`contest_not_found`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    409: {
      description: 'The contest has started; `format` and `problems` can no longer change (`contest_started`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: VALIDATION_FAILED,
  },
});

/**
 * A participation, as returned by `POST /contests/:key/join` and
 * `GET /contests/:key/me`.
 *
 * `virtual` is an integer, not a boolean: `0` is live and `n > 0` is the n-th
 * virtual attempt, which the `default` format needs in order to exclude
 * virtuals from first-solve. `-1` is a spectator and is not reachable through
 * these routes (4d design §3).
 */
export const ContestParticipation = z.object({
  id: z.number().int(),
  contestKey: z.string(),
  virtual: z.number().int(),
  /** `real_start` — when the caller joined, not when their window opens. */
  startTime: z.string(),
  /** The instant after which submissions are refused, already derived. */
  endTime: z.string(),
  isDisqualified: z.boolean(),
});
export type ContestParticipationDto = z.infer<typeof ContestParticipation>;

registry.registerPath({
  method: 'post',
  path: '/contests/{key}/join',
  tags: ['Contests'],
  summary: 'Join a contest — live while it runs, virtually once it has ended',
  request: { params: ContestKeyParam },
  responses: {
    201: {
      description: 'The participation. Idempotent: joining twice returns the existing one.',
      content: { 'application/json': { schema: ContestParticipation } },
    },
    401: NOT_SIGNED_IN,
    403: {
      description:
        'This contest is restricted to organizations the caller does not belong to ' +
        '(`contest_org_required`). **403, not 404**, and deliberately: a contest that names ' +
        'its organizations in every response it serves is a contest whose existence the caller ' +
        'already knows — there is nothing left to conceal, and a 404 here would read as "that ' +
        'contest is gone" to a competitor looking at it (D56).',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    404: CONTEST_NOT_FOUND,
    409: {
      description: 'The contest has not started yet (`contest_not_started`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/contests/{key}/me',
  tags: ['Contests'],
  summary: "The caller's own participation in this contest",
  request: { params: ContestKeyParam },
  responses: {
    200: {
      description: 'The participation',
      content: { 'application/json': { schema: ContestParticipation } },
    },
    401: NOT_SIGNED_IN,
    404: CONTEST_NOT_FOUND,
  },
});

/** One entry in a user's rating history. */
export const RatingEvent = z.object({
  contestKey: z.string(),
  contestName: z.string(),
  endTime: Timestamp,
  rank: z.number().int(),
  ratingBefore: z.number().int(),
  ratingAfter: z.number().int(),
  /** `ratingAfter - ratingBefore`, served rather than left to every client. */
  delta: z.number().int(),
});
export type RatingEventDto = z.infer<typeof RatingEvent>;

/**
 * A page of them, oldest first.
 *
 * B7 left this the one collection in the API with no bound: a rating history
 * grows by a row per rated contest and never shrinks, so a weekly round
 * hands a four-year-old account two hundred rows on every profile view. The
 * cursor is keyset on `(contests.end_time, contests.id)` — the sort key
 * itself, tiebroken on the id because two divisions of the same round end on
 * the same bell, and a cursor keyed on the instant alone would either skip
 * the second or serve the first twice.
 */
export const RatingHistoryPage = cursorPage(RatingEvent);
export type RatingHistoryPageDto = z.infer<typeof RatingHistoryPage>;

/**
 * A hundred a page, not `PaginationQuery`'s twenty-five: the page is drawn as
 * one table AND is the series behind a rating graph, and a graph that starts
 * a quarter drawn is worse than a slower first paint. The 100 ceiling is the
 * shared one.
 */
export const RatingHistoryQuery = PaginationQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
export type RatingHistoryQueryDto = z.infer<typeof RatingHistoryQuery>;

registry.registerPath({
  method: 'get',
  path: '/users/{username}/rating',
  tags: ['Contests'],
  summary: "A page of a user's rating history, oldest first",
  description:
    'Keyset-paged on the contest end instant, a hundred a page. `nextCursor` is opaque; a cursor ' +
    'the ordering could never have produced is 422 `invalid_cursor`, like every other list here.',
  request: { params: z.object({ username: z.string() }), query: RatingHistoryQuery },
  responses: {
    200: {
      description: 'A page of the history; empty for a user who has never been rated',
      content: { 'application/json': { schema: RatingHistoryPage } },
    },
    404: { description: 'No such user', content: { 'application/problem+json': { schema: ProblemDetails } } },
    422: {
      description: 'The cursor is not one this list could have issued (`invalid_cursor`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/admin/contests/{key}/rate',
  tags: ['Admin'],
  summary: 'Mark a contest rated and replay the whole rating history (admin, session only)',
  request: { params: ContestKeyParam },
  responses: {
    200: {
      description: 'How many contests produced rating events',
      content: { 'application/json': { schema: z.object({ contestsRated: z.number().int() }) } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: CONTEST_NOT_FOUND,
  },
});

registry.registerPath({
  method: 'post',
  path: '/admin/contests/{key}/unrate',
  tags: ['Admin'],
  summary: 'Mark a contest unrated and replay forward (admin, session only)',
  request: { params: ContestKeyParam },
  responses: {
    200: {
      description: 'How many contests produced rating events',
      content: { 'application/json': { schema: z.object({ contestsRated: z.number().int() }) } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: CONTEST_NOT_FOUND,
  },
});

/**
 * Disqualification, by an organiser rather than the participant.
 *
 * A body of one boolean rather than two verbs (`.../disqualify`,
 * `.../reinstate`): the operation is idempotent and its inverse is the same
 * request with the other value, which is exactly what a PATCH of one field
 * means. Every participation that user holds in this contest — live and
 * virtual alike — moves together; see `ContestAccessService.setDisqualified`.
 */
export const SetDisqualifiedRequest = z.object({ disqualified: z.boolean() }).strict();
export type SetDisqualifiedRequestDto = z.infer<typeof SetDisqualifiedRequest>;

registry.registerPath({
  method: 'patch',
  path: '/contests/{key}/participants/{username}',
  tags: ['Contests'],
  summary: 'Disqualify (or reinstate) a participant — the contest creator or an admin',
  request: {
    params: z.object({ key: z.string(), username: z.string() }),
    body: { content: { 'application/json': { schema: SetDisqualifiedRequest } } },
  },
  responses: {
    200: {
      description: "The participant's participation, after the change",
      content: { 'application/json': { schema: ContestParticipation } },
    },
    401: NOT_SIGNED_IN,
    403: {
      description:
        'The caller can see this contest but does not run it (`contest_forbidden`) — 403, not 404, ' +
        'because the contest\'s existence is already theirs to know',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    404: {
      description:
        'No such contest, or one the caller may not see (`contest_not_found`); no such user ' +
        '(`user_not_found`); or a user who never joined (`participation_not_found`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: VALIDATION_FAILED,
  },
});

/**
 * Contest clarifications and announcements (D31) — the Q&A a provincial
 * olympiad runs on contest day.
 *
 * One shape carries both. A **question** has `question` set and, once an
 * organiser has replied, `answer` too. An **announcement** has no `question`
 * at all: its text is in `answer`, it is `public` from the moment it is
 * posted, and `askedBy` is the organiser who wrote it — `askedBy` means "who
 * wrote this row", not "who is waiting for a reply". A client tells them
 * apart by `question === null`, which is exactly how the server does.
 */
export const ClarificationVisibility = z.enum(['private', 'public']);
export type ClarificationVisibilityDto = z.infer<typeof ClarificationVisibility>;

export const Clarification = z.object({
  id: z.number().int(),
  /** The problem this is about, by `code`, or `null` for the contest itself. */
  problemCode: z.string().nullable(),
  /** Username, not an id — a snapshot a client can link to without a lookup. */
  askedBy: z.string(),
  /** `null` on an announcement. */
  question: z.string().nullable(),
  /** The organiser's reply, or an announcement's own text. */
  answer: z.string().nullable(),
  answeredBy: z.string().nullable(),
  answeredAt: Timestamp.nullable(),
  visibility: ClarificationVisibility,
  createdAt: Timestamp,
});
export type ClarificationDto = z.infer<typeof Clarification>;

/**
 * Newest first, and **capped** (D63) rather than paginated: a contest's Q&A
 * is read whole on one screen, so there is no cursor — but the table behind
 * that screen has no bound of its own, and the web repolls this route every
 * 30 seconds for every reader while a contest runs. `truncated` is `true`
 * when older rows exist beyond the cap; the newest are always the ones kept.
 */
export const ClarificationList = z.object({
  items: z.array(Clarification),
  truncated: z.boolean(),
});
export type ClarificationListDto = z.infer<typeof ClarificationList>;

export const AskClarificationRequest = z
  .object({
    /** A problem attached to THIS contest, or omitted for a general question. */
    problemCode: z.string().min(1).nullable().default(null),
    question: z.string().min(1).max(2000),
  })
  .strict();
export type AskClarificationRequestDto = z.infer<typeof AskClarificationRequest>;

/**
 * The organiser's PATCH. Both fields are optional and an absent one is left
 * alone, exactly like `UpdateContestRequest` — but at least one must be
 * present, because a PATCH that changes nothing is a request that was
 * misunderstood somewhere, and answering it 200 hides that.
 */
export const AnswerClarificationRequest = z
  .object({
    answer: z.string().min(1).max(4000).optional(),
    visibility: ClarificationVisibility.optional(),
  })
  .strict()
  .refine((body) => body.answer !== undefined || body.visibility !== undefined, {
    message: 'Send an answer, a visibility, or both.',
  });
export type AnswerClarificationRequestDto = z.infer<typeof AnswerClarificationRequest>;

export const PostAnnouncementRequest = z
  .object({
    problemCode: z.string().min(1).nullable().default(null),
    text: z.string().min(1).max(4000),
  })
  .strict();
export type PostAnnouncementRequestDto = z.infer<typeof PostAnnouncementRequest>;

const CLARIFICATION_NOT_FOUND = {
  description:
    'No such contest, one the caller may not see, or no such clarification in it ' +
    '(`contest_not_found`, `clarification_not_found`)',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};

registry.registerPath({
  method: 'post',
  path: '/contests/{key}/clarifications',
  tags: ['Contests'],
  summary: 'Ask the organisers a question about this contest',
  description:
    'The asker must have joined. The new row is `private`: only the asker and the organisers ' +
    'see it until an organiser publishes it. Rate limited to 20 questions per user per contest ' +
    'per hour.',
  request: {
    params: ContestKeyParam,
    body: { content: { 'application/json': { schema: AskClarificationRequest } } },
  },
  responses: {
    201: {
      description: 'The question, as stored',
      content: { 'application/json': { schema: Clarification } },
    },
    401: NOT_SIGNED_IN,
    403: {
      description: 'The caller has not joined this contest (`contest_not_joined`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    404: {
      description:
        'No such contest, one the caller may not see, or a `problemCode` not attached to it ' +
        '(`contest_not_found`, `problem_not_found`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: VALIDATION_FAILED,
    429: {
      description: 'Too many questions this hour (`clarification_rate_limited`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/contests/{key}/clarifications',
  tags: ['Contests'],
  summary: 'Clarifications and announcements for this contest, newest first',
  description:
    'A participant sees every `public` row plus their own; an organiser (the creator) and a ' +
    'global admin see all of them. An anonymous caller who may see the contest sees the public ' +
    'rows — an announcement is for spectators too. At most 200 rows, newest first; `truncated` ' +
    'is true when older ones were left out (D63).',
  request: { params: ContestKeyParam },
  responses: {
    200: {
      description: 'What this caller may see',
      content: { 'application/json': { schema: ClarificationList } },
    },
    404: CONTEST_NOT_FOUND,
  },
});

registry.registerPath({
  method: 'patch',
  path: '/contests/{key}/clarifications/{id}',
  tags: ['Contests'],
  summary: 'Answer a clarification, or publish it — the contest creator or an admin',
  description:
    'The asker is notified the first time an answer lands. Every participant is notified the ' +
    'first time an answered row becomes `public`; later edits notify nobody, because a typo fix ' +
    'is not news.',
  request: {
    params: z.object({ key: z.string(), id: z.string() }),
    body: { content: { 'application/json': { schema: AnswerClarificationRequest } } },
  },
  responses: {
    200: {
      description: 'The clarification, after the change',
      content: { 'application/json': { schema: Clarification } },
    },
    401: NOT_SIGNED_IN,
    403: {
      description: 'The caller can see this contest but does not run it (`contest_forbidden`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    404: CLARIFICATION_NOT_FOUND,
    422: VALIDATION_FAILED,
  },
});

registry.registerPath({
  method: 'post',
  path: '/contests/{key}/announcements',
  tags: ['Contests'],
  summary: 'Post a public announcement — the contest creator or an admin',
  description:
    'An announcement is a clarification with no question: `public` on creation, and every ' +
    'participant is notified once.',
  request: {
    params: ContestKeyParam,
    body: { content: { 'application/json': { schema: PostAnnouncementRequest } } },
  },
  responses: {
    201: {
      description: 'The announcement, as stored',
      content: { 'application/json': { schema: Clarification } },
    },
    401: NOT_SIGNED_IN,
    403: {
      description: 'The caller can see this contest but does not run it (`contest_forbidden`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    404: {
      description:
        'No such contest, one the caller may not see, or a `problemCode` not attached to it ' +
        '(`contest_not_found`, `problem_not_found`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: VALIDATION_FAILED,
  },
});
