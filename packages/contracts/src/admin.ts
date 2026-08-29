import { z } from 'zod';
import { ProblemDetails } from './common.js';
import { registry } from './registry.js';

/**
 * Deliberately a bare `z.string().min(1)`, not `z.enum([...])`: an invalid
 * value here is a *domain* rule enforced by `AdminUsersService` (which checks
 * membership against the real `global_role` enum and answers 400
 * `admin_role_invalid`), not a malformed request shape. A `z.enum` here would
 * make `ZodValidationPipe` intercept it first and answer the pipe's generic
 * 422 `validation_failed` instead of the specific code this route documents.
 */
export const AdminGrantRoleRequest = z.object({ globalRole: z.string().min(1) });
export type AdminGrantRoleRequestDto = z.infer<typeof AdminGrantRoleRequest>;

export const AdminUserSummary = z.object({
  id: z.number().int(),
  username: z.string(),
  globalRole: z.enum(['user', 'setter', 'admin']),
});
export type AdminUserSummaryDto = z.infer<typeof AdminUserSummary>;

const UsernameParam = z.object({ username: z.string() });

const NOT_SIGNED_IN = {
  description: 'Not signed in',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const FORBIDDEN = {
  description:
    'Signed in, but not an admin (`admin_forbidden`), or authenticated by an access token rather than an ' +
    'interactive session (`session_required`) — this route is session-only, exactly like `/auth/tokens`',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};

registry.registerPath({
  method: 'patch',
  path: '/admin/users/{username}',
  tags: ['Admin'],
  summary: "Grant a user's global role — admin only",
  request: {
    params: UsernameParam,
    body: { content: { 'application/json': { schema: AdminGrantRoleRequest } } },
  },
  responses: {
    200: {
      description: 'The role was granted',
      content: { 'application/json': { schema: AdminUserSummary } },
    },
    400: {
      description:
        '`globalRole` is not one of `user`, `setter`, `admin` (`admin_role_invalid`), or the caller tried to ' +
        'remove their own admin role (`admin_self_demotion`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: {
      description: 'No such user',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

/**
 * M9 — an admin's TOTP reset.
 *
 * TOTP was a one-way door: `DELETE /auth/totp` sits behind the very factor
 * that was lost, password reset does not clear it, and there are no recovery
 * codes. A contestant who enrolled the night before a contest and wiped their
 * phone had no self-service path, no admin path and no documented DBA path.
 * This is the admin path.
 *
 * `204` and idempotent — "disabled, or was already off", exactly as
 * `DELETE /auth/totp` answers. An admin clicking twice, or resetting an
 * account that never enrolled, is not an error; and a distinguishable answer
 * would tell an admin who has TOTP enabled, which is not information this
 * route exists to serve.
 *
 * Session-only via the controller class, like every other credential surface.
 * A machine credential must not be able to remove the second factor
 * protecting the credentials that govern it.
 */
registry.registerPath({
  method: 'delete',
  path: '/admin/users/{username}/totp',
  tags: ['Admin'],
  summary: "Disable a user's two-factor authentication — admin only, session only",
  description:
    'For the lost-authenticator case. The user is notified in-app that their second factor was removed. ' +
    'Idempotent: an account with no TOTP answers 204 as well.',
  request: { params: UsernameParam },
  responses: {
    204: { description: 'Two-factor authentication is off for that user (or already was)' },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: {
      description: 'No such user',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

/**
 * Rejudging.
 *
 * `202`, not `200`: the routes below queue grading and return, exactly as
 * `POST /submissions` does — the verdict arrives later, over the realtime
 * channel or the submission's own endpoint.
 */
export const RejudgeSubmissionResponse = z.object({
  submissionId: z.number().int(),
  /** The `grading_jobs` row now queued for it — re-queued, not a new row. */
  jobId: z.number().int(),
  /**
   * Keys of RATED contests this submission counts towards. Ratings are NOT
   * replayed by a rejudge (the scores are zero until grading finishes — D21);
   * re-rate each listed contest via `POST /admin/contests/{key}/rate` once
   * the queue drains.
   */
  ratedContestKeys: z.array(z.string()),
});
export type RejudgeSubmissionResponseDto = z.infer<typeof RejudgeSubmissionResponse>;

export const RejudgeProblemResponse = z.object({
  submissionsQueued: z.number().int(),
  /** As on `RejudgeSubmissionResponse`: rated contests to re-rate afterwards (D21). */
  ratedContestKeys: z.array(z.string()),
});
export type RejudgeProblemResponseDto = z.infer<typeof RejudgeProblemResponse>;

registry.registerPath({
  method: 'post',
  path: '/admin/submissions/{id}/rejudge',
  tags: ['Admin'],
  summary: 'Re-queue one submission for grading — admin only, session only',
  // Uncoerced, exactly as `submissions.ts` documents its own `{id}`: a
  // `z.coerce` schema emits a nullable, optional path parameter, which
  // `openapi-path-params.spec.ts` rejects. The controller coerces.
  request: { params: z.object({ id: z.number().int().positive() }) },
  responses: {
    202: {
      description: 'Queued; the verdict arrives later',
      content: { 'application/json': { schema: RejudgeSubmissionResponse } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: {
      description: 'No such submission',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/admin/problems/{code}/rejudge',
  tags: ['Admin'],
  summary: "Re-queue every submission of a problem against its current published revision",
  request: { params: z.object({ code: z.string() }) },
  responses: {
    202: {
      description: 'How many submissions were queued',
      content: { 'application/json': { schema: RejudgeProblemResponse } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: {
      description: 'No such problem',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    409: {
      description: 'The problem has no published revision to grade against (`problem_not_submittable`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});
