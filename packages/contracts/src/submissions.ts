import { z } from 'zod';
import { PaginationQuery, ProblemDetails, Timestamp, cursorPage } from './common.js';
import { registry } from './registry.js';
import { CONTEST_KEY } from './contests.js';

export const Verdict = z.enum(['AC', 'WA', 'TLE', 'MLE', 'OLE', 'RTE', 'IR', 'CE', 'IE']);

// Shared between `SubmissionDetail` and `SubmissionSummary` so the two never
// drift into two independently-typed copies of the same lifecycle.
export const SubmissionState = z.enum(['queued', 'compiling', 'grading', 'done', 'errored']);

export const CreateSubmissionRequest = z.object({
  problemCode: z.string().min(1).max(64),
  languageKey: z.string().min(1).max(32),
  source: z.string().min(1).max(64 * 1024),
  /**
   * Route this submission into a contest. Omitted, it is an ordinary practice
   * submission; present, the caller must hold a participation whose window is
   * open on a contest containing `problemCode`.
   *
   * Explicit rather than inferred from session state (4d design §2): the same
   * call has to mean the same thing every time it is made, because this API is
   * meant to be driven by agents holding a token.
   */
  contestKey: z.string().regex(CONTEST_KEY).optional(),
});
export type CreateSubmissionRequestDto = z.infer<typeof CreateSubmissionRequest>;

export const CreateSubmissionResponse = z.object({ id: z.number().int() });
export type CreateSubmissionResponseDto = z.infer<typeof CreateSubmissionResponse>;

export const SubmissionCaseDto = z.object({
  groupIndex: z.number().int(),
  caseIndex: z.number().int(),
  verdict: Verdict.nullable(),
  skipped: z.boolean(),
  timeMs: z.number().int(),
  memoryKb: z.number().int(),
  points: z.number(),
  maxPoints: z.number(),
  feedback: z.string().nullable(),
});

export const SubmissionDetail = z.object({
  id: z.number().int(),
  problemCode: z.string(),
  languageKey: z.string(),
  /**
   * The code as submitted. Present on every submission this route answers
   * 200 for and never null — it is not a field with its own visibility rule
   * bolted on beside the submission's (design §2.1). `canViewSubmission`
   * decides whether the *submission* is visible; the source is part of it.
   *
   * Deliberately absent from `SubmissionSummary`: a page of 25 submissions
   * would otherwise carry 25 source files, and a list has no use for them.
   */
  source: z.string(),
  state: SubmissionState,
  verdict: Verdict.nullable(),
  points: z.number().nullable(),
  maxPoints: z.number().nullable(),
  timeMs: z.number().int().nullable(),
  memoryKb: z.number().int().nullable(),
  compileOutput: z.string().nullable(),
  cases: z.array(SubmissionCaseDto),
  createdAt: Timestamp,
  judgedAt: Timestamp.nullable(),
});
export type SubmissionDetailDto = z.infer<typeof SubmissionDetail>;

/**
 * `GET /submissions`'s filters. `problem` and `user` are the human-facing
 * identifiers (a problem code, a username) — the same shape
 * `CreateSubmissionRequest.problemCode` and `GET /admin/users/:username`
 * already use — not database ids, which no client of this route has any
 * other way to learn.
 */
export const SubmissionListQuery = PaginationQuery.extend({
  problem: z.string().max(64).optional(),
  user: z.string().max(64).optional(),
  verdict: Verdict.optional(),
});
export type SubmissionListQueryDto = z.infer<typeof SubmissionListQuery>;

export const SubmissionSummary = z.object({
  id: z.number().int(),
  problemCode: z.string(),
  username: z.string(),
  languageKey: z.string(),
  state: SubmissionState,
  verdict: Verdict.nullable(),
  points: z.number().nullable(),
  maxPoints: z.number().nullable(),
  createdAt: Timestamp,
});
export type SubmissionSummaryDto = z.infer<typeof SubmissionSummary>;

/**
 * Newest first (`orderBy(desc(submissions.id))`), unlike `ProblemPage` /
 * `OrgPage`'s ascending-by-id order — see `SubmissionAccessService.listVisible`
 * for what that inversion does to the keyset cursor comparison.
 */
export const SubmissionPage = cursorPage(SubmissionSummary);
export type SubmissionPageDto = z.infer<typeof SubmissionPage>;

/**
 * The `id` path parameter of `GET /submissions/{id}`, bounded to the positive
 * safe-integer range. Without the bound, `ParseIntPipe` (which this pipe
 * replaced) accepted anything matching `/^-?\d+$/`: an id like
 * `9223372036854775807` parsed to an imprecise float, was bound against the
 * `bigint` column, and surfaced as a 500 rather than a client-facing
 * validation error.
 *
 * Two schemas, deliberately:
 *  - `SubmissionIdParamSchema` (no coercion) is what the OpenAPI registration
 *    below documents. zod v4 + zod-to-openapi v9 document a *coerced* number
 *    schema as `{"type": ["integer","null"], "required": false}` — illegal for
 *    an `in: "path"` parameter under OpenAPI 3.1, which requires path
 *    parameters to be `required: true` and where a nullable id is meaningless
 *    anyway.
 *  - `SubmissionIdParam` adds `.coerce` on top, because Nest hands
 *    `@Param('id', pipe)` the raw route-segment *string*; that's the one
 *    `ZodValidationPipe` actually parses with.
 */
const SubmissionIdParamSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const SubmissionIdParam = z.coerce.number().pipe(SubmissionIdParamSchema);
export type SubmissionIdParamDto = z.infer<typeof SubmissionIdParam>;

registry.registerPath({
  method: 'post',
  path: '/submissions',
  summary: 'Submit a solution for grading',
  request: {
    body: { content: { 'application/json': { schema: CreateSubmissionRequest } } },
  },
  responses: {
    201: {
      description: 'The submission was accepted and queued',
      content: { 'application/json': { schema: CreateSubmissionResponse } },
    },
    401: {
      description: 'Not signed in',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    404: {
      description: 'No such problem, or no such language',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: {
      description: 'The request body failed validation',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/submissions',
  summary: 'Submissions visible to the caller, newest first',
  description:
    'Keyset-paginated on `id`, descending. Produces exactly the set `GET /submissions/{id}` would answer ' +
    "200 for, one id at a time — never more. `user=` naming someone else's username returns an empty page " +
    'for a non-admin rather than a 403, which would itself confirm the username exists.',
  request: { query: SubmissionListQuery },
  responses: {
    200: { description: 'A page of submissions', content: { 'application/json': { schema: SubmissionPage } } },
    401: {
      description: 'Not signed in',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: {
      description: 'The query string failed validation, or `cursor` is not a valid page cursor',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/submissions/{id}',
  summary: 'A submission visible to the caller',
  request: {
    params: z.object({ id: SubmissionIdParamSchema }),
  },
  responses: {
    200: { description: 'The submission', content: { 'application/json': { schema: SubmissionDetail } } },
    401: {
      description: 'Not signed in',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    404: {
      description: "No such submission, or one the caller may not see — the two are indistinguishable",
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: {
      description: 'The `id` path parameter is not a valid submission id',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});
