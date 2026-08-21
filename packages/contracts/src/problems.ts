import { z } from 'zod';
import { PaginationQuery, ProblemDetails, Timestamp, cursorPage } from './common.js';
import { registry } from './registry.js';
import { Verdict } from './submissions.js';

export const PROBLEM_CODE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export const ProblemVisibility = z.enum(['private', 'org', 'public']);
export type ProblemVisibilityDto = z.infer<typeof ProblemVisibility>;

/**
 * Who, beyond the submitter, an admin, and this problem's authors/curators,
 * may read submissions to it. `private` is the default every problem starts
 * on; `solved` additionally admits anyone holding an `AC`. There is no
 * `public` member — design §2.3.
 */
export const ProblemSourceAccess = z.enum(['private', 'solved']);
export type ProblemSourceAccessDto = z.infer<typeof ProblemSourceAccess>;

export const ProblemRole = z.enum(['author', 'curator', 'tester']);
export type ProblemRoleDto = z.infer<typeof ProblemRole>;

export const ProblemMember = z.object({ username: z.string().min(1), role: ProblemRole });
export type ProblemMemberDto = z.infer<typeof ProblemMember>;

export const CreateProblemRequest = z.object({
  code: z.string().regex(PROBLEM_CODE),
  name: z.string().min(1).max(200),
  // 256 KiB: far above any real statement, far below anything that hurts.
  statement: z.string().max(262_144),
  visibility: ProblemVisibility.default('private'),
  orgSlugs: z.array(z.string()).default([]),
});
export type CreateProblemRequestDto = z.infer<typeof CreateProblemRequest>;

export const UpdateProblemRequest = z
  .object({
    name: z.string().min(1).max(200).optional(),
    statement: z.string().max(262_144).optional(),
    visibility: ProblemVisibility.optional(),
    // Settable over the API, per design §5; the authoring screen does not
    // render it yet, which is why this is `.optional()` and not part of
    // `CreateProblemRequest` — a problem is created closed and opened
    // deliberately, never as a default nobody chose.
    sourceAccess: ProblemSourceAccess.optional(),
    orgSlugs: z.array(z.string()).optional(),
    members: z.array(ProblemMember).optional(),
  })
  // Rejecting an unknown key is what turns "code is immutable" from a
  // comment into a rule: a PATCH carrying `code` fails validation instead of
  // silently renaming nothing. zod reports an unrecognized key as a generic
  // `unrecognized_keys` issue (422 `validation_failed` once `ZodValidationPipe`
  // gets hold of it) with no way to tell "code" apart from any other typo at
  // this layer — `problems.controller.ts`'s `UpdateProblemBodyPipe` special-
  // cases `code` specifically, ahead of this schema, to surface the 400
  // `problem_code_immutable` the spec names.
  .strict();
export type UpdateProblemRequestDto = z.infer<typeof UpdateProblemRequest>;

export const ProblemListQuery = PaginationQuery.extend({ q: z.string().max(100).optional() });
export type ProblemListQueryDto = z.infer<typeof ProblemListQuery>;

export const AttachRevisionRequest = z.object({
  packageHash: z.string().regex(/^[a-f0-9]{64}$/),
  notes: z.string().max(4096).optional(),
});
export type AttachRevisionRequestDto = z.infer<typeof AttachRevisionRequest>;

/**
 * The viewer's own best submission on this problem — spec
 * `2026-08-21-best-verdict-design.md` §2/§3. "Best" is maximum `points`,
 * ties broken by the earliest submission; an accepted submission already
 * holds maximum points, so this yields `AC` whenever one exists with no
 * special case for it. `null` for an anonymous caller and for a problem the
 * viewer has never (successfully graded a) submission to — those read
 * identically to a viewer and are not distinguished.
 *
 * `maxPoints` is the submitting revision's total, not the problem's current
 * one (§3): a submission graded against revision 2 was scored out of
 * revision 2's total, and reporting it against revision 3's total would
 * misreport history, the same reasoning that pins `submissions.revisionId`.
 */
export const ProblemMe = z.object({ verdict: Verdict, points: z.number(), maxPoints: z.number() }).nullable();
export type ProblemMeDto = z.infer<typeof ProblemMe>;

export const ProblemSummary = z.object({
  id: z.number().int(),
  code: z.string(),
  name: z.string(),
  visibility: ProblemVisibility,
  hasPublishedRevision: z.boolean(),
  timeMs: z.number().int().nullable(),
  memoryKb: z.number().int().nullable(),
  /**
   * Nullable for the same reason `timeMs`/`memoryKb` are: all three come from
   * the published revision, and a problem whose only revision is still a draft
   * has none. Carried on the *summary* so the list can show it without a
   * request per row — deriving it from `ProblemDetail` would be exactly the
   * N+1 the list must not do.
   */
  testCount: z.number().int().nullable(),
  me: ProblemMe,
});
export type ProblemSummaryDto = z.infer<typeof ProblemSummary>;

export const ProblemPage = cursorPage(ProblemSummary);
export type ProblemPageDto = z.infer<typeof ProblemPage>;

export const ProblemDetail = ProblemSummary.extend({
  statement: z.string(),
  // On the detail, not the summary: `PATCH /problems/:code` answers with a
  // `ProblemDetail`, so without this the round-trip would be write-only —
  // a client could set the flag and never read back what it now is.
  sourceAccess: ProblemSourceAccess,
  testCount: z.number().int().nullable(),
  totalPoints: z.number().nullable(),
  checkerKind: z.string().nullable(),
  createdAt: Timestamp,
  // `members` is credit (spec §4.1): visible to anyone who may see the
  // problem at all, same as DMOJ's public authorship display. `orgSlugs` is
  // NOT symmetric with it — see `ProblemAccessService.loadMembersAndOrgs`'s
  // doc comment for why returning the full organization list to every
  // viewer would leak private organizations' names/existence.
  members: z.array(ProblemMember),
  orgSlugs: z.array(z.string()),
});
export type ProblemDetailDto = z.infer<typeof ProblemDetail>;

export const RevisionSummary = z.object({
  id: z.number().int(),
  version: z.number().int(),
  state: z.enum(['draft', 'published', 'archived']),
  packageHash: z.string(),
  notes: z.string().nullable(),
  timeMs: z.number().int(),
  memoryKb: z.number().int(),
  testCount: z.number().int(),
  totalPoints: z.number(),
  checkerKind: z.string(),
  createdBy: z.number().int(),
  createdAt: Timestamp,
});
export type RevisionSummaryDto = z.infer<typeof RevisionSummary>;

export const RevisionList = z.array(RevisionSummary);
export type RevisionListDto = z.infer<typeof RevisionList>;

export const RevisionVersionResponse = z.object({ version: z.number().int() });
export type RevisionVersionResponseDto = z.infer<typeof RevisionVersionResponse>;

/**
 * Two schemas, deliberately — mirrors `submissions.ts`'s `SubmissionIdParam`:
 * `z.coerce.number()` alone documents an `in: "path"` OpenAPI parameter as
 * `{"required": false, "schema": {"type": ["integer", "null"]}}` under zod v4
 * + zod-to-openapi v9, which is illegal for a path parameter under OpenAPI
 * 3.1 (`openapi-path-params.spec.ts` enforces this repo-wide). The plain,
 * uncoerced schema is what gets registered in the OpenAPI document; the
 * coerced one is what `ZodValidationPipe` actually parses the route
 * segment's raw string with.
 */
const RevisionVersionParamSchema = z.number().int().positive();
export const RevisionVersionParam = z.coerce.number().pipe(RevisionVersionParamSchema);
export type RevisionVersionParamDto = z.infer<typeof RevisionVersionParam>;

const ProblemCodeParam = z.object({ code: z.string() });
const ProblemCodeAndVersionParam = z.object({ code: z.string(), version: RevisionVersionParamSchema });

const NOT_SIGNED_IN = {
  description: 'Not signed in',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const FORBIDDEN = {
  description: 'Signed in, but not permitted to perform this action on this problem',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const PROBLEM_NOT_FOUND = {
  description: 'No such problem, or one the caller may not see — the two are indistinguishable',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const VALIDATION_FAILED = {
  description: 'The request failed validation',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};

registry.registerPath({
  method: 'get',
  path: '/problems',
  summary: 'Problems visible to the caller',
  request: { query: ProblemListQuery },
  responses: {
    200: { description: 'A page of problems', content: { 'application/json': { schema: ProblemPage } } },
    422: VALIDATION_FAILED,
  },
});

registry.registerPath({
  method: 'get',
  path: '/problems/{code}',
  summary: 'A single problem visible to the caller',
  request: { params: ProblemCodeParam },
  responses: {
    200: { description: 'The problem', content: { 'application/json': { schema: ProblemDetail } } },
    404: PROBLEM_NOT_FOUND,
  },
});

registry.registerPath({
  method: 'post',
  path: '/problems',
  summary: 'Create a problem',
  request: { body: { content: { 'application/json': { schema: CreateProblemRequest } } } },
  responses: {
    201: { description: 'The created problem', content: { 'application/json': { schema: ProblemDetail } } },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    409: {
      description: 'That problem code is already taken',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: VALIDATION_FAILED,
  },
});

registry.registerPath({
  method: 'patch',
  path: '/problems/{code}',
  summary: "Update a problem's name, statement, visibility, sharing or membership",
  request: {
    params: ProblemCodeParam,
    body: { content: { 'application/json': { schema: UpdateProblemRequest } } },
  },
  responses: {
    200: { description: 'The updated problem', content: { 'application/json': { schema: ProblemDetail } } },
    400: {
      description: "The patch carried `code` (immutable) or would leave the problem with no author",
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: PROBLEM_NOT_FOUND,
    422: VALIDATION_FAILED,
  },
});

registry.registerPath({
  method: 'get',
  path: '/problems/{code}/revisions',
  summary: "A problem's revision history — draft, published and archived alike",
  request: { params: ProblemCodeParam },
  responses: {
    200: { description: 'Every revision, oldest first', content: { 'application/json': { schema: RevisionList } } },
    404: {
      description:
        'No such problem, or the caller is not a member (any role) or admin — unlike GET /problems/{code}, ' +
        'public or org visibility alone is not enough to see revision history',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/problems/{code}/revisions',
  summary: 'Attach an already-uploaded package as a new draft revision',
  request: {
    params: ProblemCodeParam,
    body: { content: { 'application/json': { schema: AttachRevisionRequest } } },
  },
  responses: {
    201: {
      description: 'The new draft revision was created',
      content: { 'application/json': { schema: RevisionVersionResponse } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: {
      description: 'No such problem, or no such package',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: {
      description: 'The package manifest is invalid, or its paths collide',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/problems/{code}/revisions/{version}/publish',
  summary: 'Publish a draft or archived revision, archiving whatever was previously published',
  request: { params: ProblemCodeAndVersionParam },
  responses: {
    200: {
      description: 'The revision is now published',
      content: { 'application/json': { schema: RevisionVersionResponse } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: {
      description: 'No such problem, or no such revision version',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: VALIDATION_FAILED,
  },
});
