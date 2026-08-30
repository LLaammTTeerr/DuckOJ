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

/**
 * Which contest this submission was made INTO, or `null` for a practice
 * submission — the `contest_submissions` row, never "a submission that
 * happens to target a contest's problem" (the same distinction
 * `SubmissionListQuery.contest` draws).
 *
 * Spread into BOTH `SubmissionDetail` and `SubmissionSummary` rather than
 * declared twice: a list row and a detail page must never disagree about
 * which contest a submission belongs to.
 *
 * Visibility: exactly what the `contest` filter already applies — none of
 * its own. A caller who may see the submission at all may see which contest
 * it sits in; the key is only ever attached to a row `visibleSubmissionsWhere`
 * has already admitted, so it discloses nothing about contests whose
 * submissions the caller cannot list.
 */
const CONTEST_LINK = {
  contestKey: z.string().nullable(),
  /** The contest's display name — `null` exactly when `contestKey` is. */
  contestLabel: z.string().nullable(),
};

export const SubmissionDetail = z.object({
  id: z.number().int(),
  problemCode: z.string(),
  languageKey: z.string(),
  /**
   * The code as submitted, or `null` when `sourceHidden` is true.
   *
   * It is otherwise not a field with its own visibility rule bolted on beside
   * the submission's (design §2.1): `canViewSubmission` decides whether the
   * *submission* is visible, and the source is part of it. The one exception
   * is D27 — see `sourceHidden`.
   *
   * Deliberately absent from `SubmissionSummary`: a page of 25 submissions
   * would otherwise carry 25 source files, and a list has no use for them.
   */
  source: z.string().nullable(),
  state: SubmissionState,
  verdict: Verdict.nullable(),
  points: z.number().nullable(),
  maxPoints: z.number().nullable(),
  timeMs: z.number().int().nullable(),
  memoryKb: z.number().int().nullable(),
  compileOutput: z.string().nullable(),
  cases: z.array(SubmissionCaseDto),
  ...CONTEST_LINK,
  createdAt: Timestamp,
  judgedAt: Timestamp.nullable(),
  /**
   * The scoreboard freeze, reaching this route (D23). `true` means the fields
   * above that describe the *outcome* — `verdict`, `points`, `timeMs`,
   * `memoryKb`, `compileOutput`, `cases` — have been replaced by `null`/`[]`
   * because this submission was made inside the freeze window of a contest
   * whose board is still frozen for this viewer, and is not the viewer's own.
   *
   * Required, not optional: it is the only thing that distinguishes "hidden"
   * from "not graded yet", and an absent field would read as the latter in
   * every client that forgot to check for it.
   */
  frozen: z.boolean(),
  /**
   * D27 — the contest clause on the source. `true` means `source` is `null`
   * because this submission belongs to a contest participation whose window
   * is still open and the viewer is neither its submitter, nor the contest's
   * creator, nor a global admin.
   *
   * Independent of `frozen`: it applies to a contest with no freeze at all,
   * and it applies for the whole window rather than its last minutes. Also
   * independent of the problem's `source_access` — that setting decides who
   * may read a *practice* solution, and it was never meant to hand a
   * competitor a rival's live contest source.
   *
   * Required, and separate from `source: null`, for the same reason `frozen`
   * is required: "withheld" must be distinguishable from "empty".
   */
  sourceHidden: z.boolean(),
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
  /**
   * A contest key: only submissions made *into* that contest (rows in
   * `contest_submissions`), not practice submissions to its problems. An
   * unknown or invisible key is an empty page, same as an unknown user —
   * anything else is an existence oracle.
   */
  contest: z.string().max(64).optional(),
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
  ...CONTEST_LINK,
  createdAt: Timestamp,
  /**
   * As on `SubmissionDetail` (D23): `verdict` and `points` are `null` because
   * the freeze hides them, not because grading has not finished. The row is
   * still listed — a frozen contest hides outcomes, never the fact that
   * somebody submitted.
   *
   * `maxPoints` survives the mask: it is the contest problem's own total, the
   * same number every viewer already reads off the problem.
   */
  frozen: z.boolean(),
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
  tags: ['Submissions'],
  summary: 'Submit a solution for grading',
  description:
    'Metered per USER (D80): **one submission every ten seconds and twenty every ten minutes**. ' +
    'This endpoint enqueues the most expensive work the system does — one grading job, one ' +
    'container, one compile — and one judge grades about 35 submissions a minute ' +
    '(`load/RESULTS.md`), which a single unmetered client can outrun from one connection. ' +
    'Organisers and global admins are metered on exactly the same terms: the cost is a container, ' +
    'and a container costs the same whoever enqueued it. Only a submission that is actually ' +
    'created spends the window, so a refusal — a 429, a 404 for an unknown problem, a 409 for an ' +
    'unpublished one — costs the caller nothing.',
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
    409: {
      description:
        'The problem is visible to the caller but has no published revision to grade ' +
        'against (`problem_not_submittable`) — unlike 404, which never distinguishes ' +
        '"invisible" from "nonexistent"',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: {
      description: 'The request body failed validation',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    429: {
      description:
        'This user has submitted too recently (`submission_rate_limited`) — one every ten seconds, ' +
        'twenty every ten minutes (D80). `Retry-After` carries the whole seconds until another ' +
        'submission will be accepted, and is the LONGER of the two windows when both are spent, ' +
        'so a caller told to come back is told when it is actually worth coming back. The refusal ' +
        'itself records nothing, so leaning on the button does not extend its own cooldown.',
      headers: {
        'Retry-After': {
          description: 'Whole seconds until another submission will be accepted',
          required: true,
          schema: { type: 'integer' },
        },
      },
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/submissions',
  tags: ['Submissions'],
  summary: 'Submissions visible to the caller, newest first',
  description:
    'Keyset-paginated on `id`, descending. Produces exactly the set `GET /submissions/{id}` would answer ' +
    "200 for, one id at a time — never more. `user=` naming someone else's username returns an empty page " +
    'for a non-admin rather than a 403, which would itself confirm the username exists. ' +
    'A row inside a live freeze window (D23) is listed with `frozen: true` and a null `verdict`/`points`; ' +
    'because `verdict=` is a question about the verdict, a frozen row matches NO value of that filter.',
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
  tags: ['Submissions'],
  summary: 'A submission visible to the caller',
  description:
    'During a contest freeze window (D23) a submission that is not the caller\'s own answers 200 with ' +
    '`frozen: true` and `verdict`, `points`, `timeMs`, `memoryKb`, `compileOutput` null and `cases` empty. ' +
    "The contest's creator and global admins are never masked, and everything is revealed once the " +
    "submission's own participation has ended.",
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
