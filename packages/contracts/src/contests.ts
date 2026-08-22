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
     * Accepted only as `0`. A non-zero freeze window is refused with
     * `contest_freeze_unsupported` rather than stored and ignored: the formats
     * throw on it because `Contest.is_frozen` reads the wall clock, and a
     * contest that accepts a freeze it does not honour is worse than one that
     * refuses it (design §3, §6.3). The field exists — rather than being
     * omitted — so the refusal is explicit and the column has a name to fill
     * when freeze is implemented.
     */
    frozenLastMinutes: z.number().int().min(0).default(0),
    timeLimitSeconds: z.number().int().positive().nullable().default(null),
    visibility: ContestVisibility.default('private'),
    orgSlugs: z.array(z.string()).default([]),
    problems: z.array(ContestProblemInput).default([]),
  })
  .strict();
export type CreateContestRequestDto = z.infer<typeof CreateContestRequest>;

export const ContestProblemSummary = z.object({
  code: z.string(),
  name: z.string(),
  label: z.string(),
  points: z.number(),
  partial: z.boolean(),
  order: z.number().int(),
});
export type ContestProblemSummaryDto = z.infer<typeof ContestProblemSummary>;

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
  createdAt: Timestamp,
});
export type ContestSummaryDto = z.infer<typeof ContestSummary>;

export const ContestPage = cursorPage(ContestSummary);
export type ContestPageDto = z.infer<typeof ContestPage>;

export const ContestDetail = ContestSummary.extend({
  formatConfig: z.record(z.string(), z.unknown()).nullable(),
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
    'An unknown format (`unknown_contest_format`), a non-zero freeze window ' +
    '(`contest_freeze_unsupported`), an end before the start, or an unknown problem',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const VALIDATION_FAILED = {
  description: 'The request failed validation',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};

registry.registerPath({
  method: 'get',
  path: '/contests',
  summary: 'Contests visible to the caller',
  responses: {
    200: { description: 'A page of contests', content: { 'application/json': { schema: ContestPage } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/contests/{key}',
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
  summary: "The contest's scoreboard, computed by its format",
  request: { params: ContestKeyParam },
  responses: {
    200: {
      description: 'The scoreboard — snake_case, mirroring the goldens field for field',
      content: { 'application/json': { schema: Scoreboard } },
    },
    404: CONTEST_NOT_FOUND,
    409: {
      description:
        'The contest cannot be scored as configured — an `ioi16` problem with no published ' +
        'revision has no dataset to scale against (`contest_problem_missing_dataset`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/contests',
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
  summary: 'Join a contest — live while it runs, virtually once it has ended',
  request: { params: ContestKeyParam },
  responses: {
    201: {
      description: 'The participation. Idempotent: joining twice returns the existing one.',
      content: { 'application/json': { schema: ContestParticipation } },
    },
    401: NOT_SIGNED_IN,
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

export const RatingHistory = z.array(RatingEvent);
export type RatingHistoryDto = z.infer<typeof RatingHistory>;

registry.registerPath({
  method: 'get',
  path: '/users/{username}/rating',
  summary: "A user's rating history, oldest first",
  request: { params: z.object({ username: z.string() }) },
  responses: {
    200: {
      description: 'The history; empty for a user who has never been rated',
      content: { 'application/json': { schema: RatingHistory } },
    },
    404: { description: 'No such user', content: { 'application/problem+json': { schema: ProblemDetails } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/admin/contests/{key}/rate',
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

export const ContestListQuery = PaginationQuery;
export type ContestListQueryDto = z.infer<typeof ContestListQuery>;
