import { z } from 'zod';
import { ProblemDetails, Timestamp } from './common.js';
import { registry } from './registry.js';

export const Verdict = z.enum(['AC', 'WA', 'TLE', 'MLE', 'OLE', 'RTE', 'IR', 'IE']);

export const CreateSubmissionRequest = z.object({
  problemCode: z.string().min(1).max(64),
  languageKey: z.string().min(1).max(32),
  source: z.string().min(1).max(64 * 1024),
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
  state: z.enum(['queued', 'compiling', 'grading', 'done', 'errored']),
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
