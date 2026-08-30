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

/**
 * `POST /contests/{key}/clone` — next year's round from last year's (D88).
 *
 * Only the four things a copy cannot inherit. A key is a URL and must be
 * new; a name must be too, or two rounds are indistinguishable in a list;
 * and a contest without a window is not a contest, so the new one is stated
 * outright rather than defaulted from a source whose window is in the past.
 * Everything else — the format and its config, the points precision, the
 * freeze, the time limit, the problems with their labels and points, and the
 * organizations that may enter — is copied by the server and is not
 * negotiable here: a request that could pick and choose would be a second,
 * half-specified `POST /contests`.
 */
export const CloneContestRequest = z
  .object({
    newKey: z.string().regex(CONTEST_KEY),
    newName: z.string().min(1).max(200),
    startTime: Timestamp,
    endTime: Timestamp,
  })
  .strict();
export type CloneContestRequestDto = z.infer<typeof CloneContestRequest>;

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
  method: 'post',
  path: '/contests/{key}/clone',
  tags: ['Contests'],
  summary: 'Create a new contest from an existing one (its creator, or an admin)',
  description:
    'Copies the format and its config, the points precision, the freeze window, the time limit, the ' +
    'problems with their labels, points, partial flag and order, and the organizations that may ' +
    'enter (D56) — into a new, PRIVATE contest at the window given here. Nothing that happened in ' +
    'the source is copied: no participations, no submissions, no clarifications, no similarity ' +
    'runs, and the copy is not rated. The new window is validated as an edit would be, so a freeze ' +
    'the source stores that no longer fits is refused (`contest_freeze_too_long`).',
  request: {
    params: ContestKeyParam,
    body: { content: { 'application/json': { schema: CloneContestRequest } } },
  },
  responses: {
    201: { description: 'The new contest', content: { 'application/json': { schema: ContestDetail } } },
    400: BAD_REQUEST,
    401: NOT_SIGNED_IN,
    403: {
      description: 'Signed in, runs this contest, and may not create contests',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    404: CONTEST_NOT_FOUND,
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

/* ------------------------------------- results export and certificates (D71) */

/**
 * Who may export a contest's results, and when.
 *
 * **The contest's creator or a global admin, at any time** — the same
 * `canRunContest` predicate `canEdit` reports, and nobody else ever. The
 * export is always the LIVE board (no freeze, D22), so widening it to "anyone,
 * once the contest has ended" would hand a `.csv` to a caller mid-freeze that
 * publishes exactly what the scoreboard is hiding. The web offers the links
 * once the contest is over; the API's gate is the person, not the clock.
 */
const RESULTS_FORBIDDEN = {
  description: 'The caller can see this contest but does not run it (`contest_forbidden`)',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};

registry.registerPath({
  method: 'get',
  path: '/contests/{key}/results.csv',
  tags: ['Contests'],
  summary: "The contest's final standings as a spreadsheet — the organisers only",
  description:
    'One row per ranked participation: rank, username, display name, the competitor’s own ' +
    'organizations, then points/attempts/time per problem, the total, the ICPC penalty, a ' +
    'disqualification flag and the virtual number (`0` live, `n` the n-th replay). ' +
    '**Disqualified rows are included and flagged, never dropped** — the record of what ' +
    'happened is the row (D37). UTF-8 **with a BOM** and CRLF line endings, because the ' +
    'consumer is Excel: without the BOM every Vietnamese name in the file is read in the ' +
    'machine’s ANSI code page. Text fields that a spreadsheet would run as a formula are ' +
    'prefixed with an apostrophe. Always the live, unfrozen board.',
  request: { params: ContestKeyParam },
  responses: {
    200: {
      description: 'The results sheet',
      content: { 'text/csv': { schema: z.string() } },
    },
    401: NOT_SIGNED_IN,
    403: RESULTS_FORBIDDEN,
    404: CONTEST_NOT_FOUND,
  },
});

registry.registerPath({
  method: 'get',
  path: '/contests/{key}/results.pdf',
  tags: ['Contests'],
  summary: 'The final standings as a printable landscape PDF — the organisers only',
  description:
    'A landscape A4 table, page-numbered with a repeating header row: rank, account, name, ' +
    'organizations, one column per problem, total and penalty. A disqualified row is marked ' +
    '`[DQ]` and a virtual replay `(ảo)`; both stay on the sheet. Vietnamese headings with an ' +
    'English subtitle, and no `?lang=` — the sheet is names and numbers, and it carries no ' +
    'statement text at all (D62 holds by construction). Cached for 60 s on a hash of the ' +
    'document, exactly as the booklet is.',
  request: { params: ContestKeyParam },
  responses: {
    200: {
      description: 'The rendered standings',
      content: { 'application/pdf': { schema: z.string() } },
    },
    401: NOT_SIGNED_IN,
    403: RESULTS_FORBIDDEN,
    404: CONTEST_NOT_FOUND,
    501: {
      description: 'This server has no typst binary configured (`statement_pdf_unavailable`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

/**
 * Which certificates to print: **exactly one** of `top` and `username`.
 *
 * Neither a default `top` nor "both means everybody" — a request that names
 * no scope is a request whose author has not decided how many certificates
 * they are printing, and guessing on their behalf prints a hundred pages.
 */
export const CertificatesQuery = z
  .object({
    top: z.coerce.number().int().min(1).max(1000).optional(),
    username: z.string().min(1).max(64).optional(),
  })
  .refine((query) => (query.top === undefined) !== (query.username === undefined), {
    message: 'Pass exactly one of `top` or `username`.',
  });
export type CertificatesQueryDto = z.infer<typeof CertificatesQuery>;

registry.registerPath({
  method: 'get',
  path: '/contests/{key}/certificates.pdf',
  tags: ['Contests'],
  summary: 'One A4 landscape certificate per participant — the organisers only',
  description:
    'Vietnamese with an English subtitle ("GIẤY CHỨNG NHẬN" / "CERTIFICATE OF ACHIEVEMENT"): ' +
    'the contest, the participant’s display name, their rank, their total, the contest’s end ' +
    'date and a signature line. The issuer is the contest’s own organizations (D56), or the ' +
    'site itself when it is restricted to none. **A disqualified row and a virtual replay ' +
    'never get one** — the results sheet is a record, a certificate is an award — so `top=N` ' +
    'counts down the ranking after that exclusion, and a `username` naming an ineligible or ' +
    'unranked competitor answers 404. **`top` is a bound on the RANK, not a count of sheets** ' +
    '(D74): the board ranks in competition style, so `top=3` over ranks 1, 2, 3, 3 prints four ' +
    'certificates rather than cutting through the tie. The date is the contest’s end, never the moment of ' +
    'download, so two prints are the same document. Cached for 60 s on a hash of the document.',
  request: { params: ContestKeyParam, query: CertificatesQuery },
  responses: {
    200: {
      description: 'The rendered certificates',
      content: { 'application/pdf': { schema: z.string() } },
    },
    401: NOT_SIGNED_IN,
    403: RESULTS_FORBIDDEN,
    404: {
      description:
        'No such contest, one the caller may not see, or no certifiable result for that ' +
        '`username` (`contest_not_found`, `contest_participant_not_found`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: VALIDATION_FAILED,
    501: {
      description: 'This server has no typst binary configured (`statement_pdf_unavailable`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

/**
 * Source-similarity reports — chống gian lận (D77).
 *
 * Three routes, all `Contests`, all behind the one gate the results exports
 * use (`canRunContest`): the contest's creator or a global admin. The pair
 * view returns two competitors' SOURCES side by side, which is exactly what
 * D27 withholds from everybody else — and D77 is the clause that says the
 * people running the contest are not "everybody else", because they can
 * already read every submission of the contest they run.
 */
export const SimilarityStatus = z.enum(['running', 'finished', 'failed']);
export type SimilarityStatusDto = z.infer<typeof SimilarityStatus>;

/**
 * One reported pair. Both usernames, the problem, both submission ids and
 * BOTH measures — a pair at containment 0.9 with Jaccard 0.3 is one solution
 * buried in a longer file, and a pair at 0.9/0.85 is the same file twice.
 */
export const SimilarityPair = z.object({
  problemCode: z.string(),
  problemLabel: z.string(),
  /** The two usernames, ordered `a < b` so a pair is named the same way twice. */
  a: z.string(),
  b: z.string(),
  aSubmissionId: z.number().int(),
  bSubmissionId: z.number().int(),
  /** Shared fingerprints over the union. */
  jaccard: z.number(),
  /** Shared fingerprints over the smaller set — what the threshold tests. */
  containment: z.number(),
  /**
   * The language FAMILY both were written in (`c`, `cpp`, `python`, `java`).
   * Two submissions are only ever compared inside one family — a Python file
   * and a C++ file share no tokens, so a score between them would be noise —
   * but `cpp17` and `cpp20` are the same family and are compared.
   */
  language: z.string(),
});
export type SimilarityPairDto = z.infer<typeof SimilarityPair>;

/** What the run did on one problem, reported whether or not it found anything. */
export const SimilarityProblemSummary = z.object({
  code: z.string(),
  label: z.string(),
  /** Participants with a comparable submission on this problem. */
  participants: z.number().int(),
  /** Pairs actually compared — `n(n-1)/2` minus the language mismatches. */
  compared: z.number().int(),
  /** Pairs at or above the threshold, BEFORE the 500-pair cap. */
  reported: z.number().int(),
  /** Whether the cap dropped some of them (the lowest-scoring ones). */
  truncated: z.boolean(),
});
export type SimilarityProblemSummaryDto = z.infer<typeof SimilarityProblemSummary>;

export const SimilarityRun = z.object({
  id: z.number().int(),
  status: SimilarityStatus,
  threshold: z.number(),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  /** The organiser who asked; `null` if that account has since been deleted. */
  requestedBy: z.string().nullable(),
  /** An error CODE for a failed run, never a stack trace. */
  error: z.string().nullable(),
  /** Distinct participants the run looked at, across all problems. */
  participants: z.number().int(),
  /** Every problem of the contest, in the contest's own order. */
  problems: z.array(SimilarityProblemSummary),
  /** Every reported pair, highest containment first. Empty while running. */
  pairs: z.array(SimilarityPair),
});
export type SimilarityRunDto = z.infer<typeof SimilarityRun>;

/** The latest run, or `null` where a contest has never been checked. */
export const SimilarityReport = z.object({ run: SimilarityRun.nullable() });
export type SimilarityReportDto = z.infer<typeof SimilarityReport>;

export const RunSimilarityRequest = z.object({
  /**
   * The containment above which a pair is reported. `0.6` by default — high
   * enough that two independent solutions to the same easy problem do not
   * fill the table, low enough that a renamed copy cannot slip under it.
   *
   * Floored at `0.3`: below that the report is noise, and a report nobody
   * trusts is worse than no report (D77).
   */
  threshold: z.number().min(0.3).max(1).default(0.6),
});
export type RunSimilarityRequestDto = z.infer<typeof RunSimilarityRequest>;

const SIMILARITY_FORBIDDEN = {
  description: 'The caller can see this contest but does not run it (`contest_forbidden`)',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};

registry.registerPath({
  method: 'post',
  path: '/contests/{key}/similarity',
  tags: ['Contests'],
  summary: 'Start a source-similarity check over this contest — the organisers only',
  description:
    'Compares one submission per participant per problem — their accepted one, else their ' +
    'highest-scoring one — and reports every pair whose fingerprint containment reaches ' +
    '`threshold`. Runs in the API process behind a per-contest advisory lock, so a second ' +
    'request while one is running answers 409 `similarity_running`. A contest with more than ' +
    '3000 participants, or a problem that would need more than 500 reported pairs, is refused ' +
    'or truncated rather than allowed to run for an hour — see 422 `similarity_too_large`. ' +
    '**A report is a prompt to look, never a verdict** (D77).',
  request: {
    params: ContestKeyParam,
    body: { content: { 'application/json': { schema: RunSimilarityRequest } } },
  },
  responses: {
    201: {
      description: 'The run, freshly started (`status: "running"`)',
      content: { 'application/json': { schema: SimilarityRun } },
    },
    401: NOT_SIGNED_IN,
    403: SIMILARITY_FORBIDDEN,
    404: CONTEST_NOT_FOUND,
    409: {
      description: 'A run of this contest is already going (`similarity_running`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: {
      description:
        'The request failed validation, or the contest is too large to check ' +
        '(`similarity_too_large`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/contests/{key}/similarity',
  tags: ['Contests'],
  summary: 'The latest source-similarity run and its pairs — the organisers only',
  description:
    'The most recent run of this contest, whatever its state, with every pair it reported ' +
    'sorted by containment. `{ "run": null }` for a contest nobody has ever checked — never ' +
    '404, which would be indistinguishable from a contest that does not exist.',
  request: { params: ContestKeyParam },
  responses: {
    200: {
      description: 'The latest run, or `null`',
      content: { 'application/json': { schema: SimilarityReport } },
    },
    401: NOT_SIGNED_IN,
    403: SIMILARITY_FORBIDDEN,
    404: CONTEST_NOT_FOUND,
  },
});

/** One side of the side-by-side view. */
export const SimilaritySide = z.object({
  username: z.string(),
  submissionId: z.number().int(),
  languageKey: z.string(),
  source: z.string(),
  /**
   * Character ranges of this source that match the other one, merged and
   * disjoint. Ranges, not paired matches: the algorithm knows WHERE the two
   * agree, not which block corresponds to which, and inventing an alignment
   * would be it asserting more than it knows.
   */
  spans: z.array(z.object({ start: z.number().int(), end: z.number().int() })),
});
export type SimilaritySideDto = z.infer<typeof SimilaritySide>;

export const SimilarityPairView = z.object({
  problemCode: z.string(),
  problemLabel: z.string(),
  jaccard: z.number(),
  containment: z.number(),
  a: SimilaritySide,
  b: SimilaritySide,
});
export type SimilarityPairViewDto = z.infer<typeof SimilarityPairView>;

export const SimilarityPairQuery = z.object({
  /**
   * Which problem's pair to open. Optional: two competitors who match on
   * several problems have several pairs, and the default is the
   * highest-scoring of them — the one an organiser opening the row from the
   * table meant.
   */
  problem: z.string().min(1).max(64).optional(),
});
export type SimilarityPairQueryDto = z.infer<typeof SimilarityPairQuery>;

registry.registerPath({
  method: 'get',
  path: '/contests/{key}/similarity/{a}/{b}',
  tags: ['Contests'],
  summary: 'Two matched submissions side by side, with the matched spans — the organisers only',
  description:
    'Both sources in full, plus the character ranges where they agree. This is the one route ' +
    'in the product that serves another person’s contest source to somebody who is not its ' +
    'author: D27 withholds it from everyone, and D77 records why the people RUNNING the ' +
    'contest are not covered by that — they can already read every submission made into it. ' +
    'The pair must be one the latest run actually reported; anything else is 404.',
  request: {
    params: z.object({ key: z.string(), a: z.string(), b: z.string() }),
    query: SimilarityPairQuery,
  },
  responses: {
    200: {
      description: 'The two sources and their matched spans',
      content: { 'application/json': { schema: SimilarityPairView } },
    },
    401: NOT_SIGNED_IN,
    403: SIMILARITY_FORBIDDEN,
    404: {
      description:
        'No such contest, one the caller may not see, no run yet, or a pair this run did not ' +
        'report (`contest_not_found`, `similarity_pair_not_found`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: VALIDATION_FAILED,
  },
});

/* ────────────────────────────────────────────────────────────────────────────
 * The organiser live monitor — D95.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * One row of the per-problem panel.
 *
 * `submitted` counts contest submissions, not people: a competitor who tried
 * six times is six. `solvers` is the number of distinct participants with at
 * least one accepted attempt, which is the number an organiser compares
 * against the room. `pending` is what the judge still owes — a grading job
 * for this problem that is not `done`.
 */
export const ContestMonitorProblem = z.object({
  code: z.string(),
  label: z.string(),
  submitted: z.number().int(),
  accepted: z.number().int(),
  solvers: z.number().int(),
  pending: z.number().int(),
});
export type ContestMonitorProblemDto = z.infer<typeof ContestMonitorProblem>;

/**
 * One line of the live feed.
 *
 * `verdict` and `state` are spelled as plain strings rather than as
 * `Verdict` / `SubmissionState`: `submissions.ts` already imports
 * `CONTEST_KEY` from this module, so importing the enums back would close a
 * module cycle that fails at zod-evaluation time rather than at type-check.
 * The values are those enums, whose authority `verdict-enum-drift.spec.ts`
 * guards.
 *
 * **Never frozen.** D22 gives the people who run a contest the live board,
 * and this route is gated on exactly that set (`canRunContest`), so the feed
 * shows real verdicts inside a freeze window.
 */
export const ContestMonitorEntry = z.object({
  submissionId: z.number().int(),
  username: z.string(),
  problemCode: z.string(),
  problemLabel: z.string(),
  state: z.string(),
  verdict: z.string().nullable(),
  createdAt: Timestamp,
});
export type ContestMonitorEntryDto = z.infer<typeof ContestMonitorEntry>;

/**
 * One question still waiting for an answer — enough of it to decide whether
 * to go and answer it. Every row here is unanswered by construction, so there
 * is no `answered` flag: the panel is a work queue, not a transcript.
 */
export const ContestMonitorClarification = z.object({
  id: z.number().int(),
  problemCode: z.string().nullable(),
  askedBy: z.string(),
  question: z.string().nullable(),
  createdAt: Timestamp,
});
export type ContestMonitorClarificationDto = z.infer<typeof ContestMonitorClarification>;

/**
 * Contest day in one response (D95): what the room is doing, what the judge
 * owes it, and what the organisers still have to answer.
 *
 * One response rather than six, for D47's reason — the panels only mean
 * anything together. Unlike D47's dashboard this one IS cached, for five
 * seconds: it is opened during the busiest hours the deployment ever has,
 * and five seconds is the interval its own page polls at.
 */
export const ContestMonitor = z.object({
  problems: z.array(ContestMonitorProblem),
  queue: z.object({
    /** Grading jobs for THIS contest that are not `done`. */
    depth: z.number().int(),
    /** Age of the oldest of them. `null` for an empty queue, never `0`. */
    oldestPendingSeconds: z.number().int().nullable(),
  }),
  judges: z.object({
    /** Judge nodes heard from recently. Fleet-wide: a judge serves every contest. */
    online: z.number().int(),
    total: z.number().int(),
  }),
  /** The last fifty submissions into this contest, newest first. */
  feed: z.array(ContestMonitorEntry),
  clarifications: z.object({
    unanswered: z.number().int(),
    /** The newest five of the unanswered ones. */
    latest: z.array(ContestMonitorClarification),
  }),
  /**
   * Distinct people holding a participation in this contest who also have a
   * live WebSocket open right now. A floor on "who is in the room", never a
   * roster: a competitor reading a statement with no socket open is not
   * counted, and nobody is counted twice for two tabs.
   */
  participantsOnline: z.number().int(),
  /**
   * `POST /submissions` refusals in the last ten minutes (D80).
   * **Deployment-wide**, because that meter is keyed on the user rather than
   * on a contest — there is no contest-scoped number to report.
   */
  submitRefusalsLast10Min: z.number().int(),
  generatedAt: Timestamp,
});
export type ContestMonitorDto = z.infer<typeof ContestMonitor>;

registry.registerPath({
  method: 'get',
  path: '/contests/{key}/monitor',
  tags: ['Contests'],
  summary: 'The live contest-day monitor — the organisers only',
  description:
    'Everything an organiser watches while a contest runs, in one snapshot: per-problem ' +
    'submitted / accepted / distinct solvers / still queued, the grading queue scoped to this ' +
    'contest, judge liveness, the last fifty submissions with their real verdicts (D22 gives ' +
    'the people who run a contest the unfrozen view), unanswered clarifications, how many ' +
    'competitors have a live socket open, and how many submissions the rate limiter turned ' +
    'away in the last ten minutes (D80, deployment-wide). Cached five seconds; the page polls ' +
    'at that interval and is woken sooner by the `contest-activity` WebSocket frame.',
  request: { params: ContestKeyParam },
  responses: {
    200: {
      description: 'The snapshot',
      content: { 'application/json': { schema: ContestMonitor } },
    },
    401: NOT_SIGNED_IN,
    403: SIMILARITY_FORBIDDEN,
    404: CONTEST_NOT_FOUND,
  },
});
