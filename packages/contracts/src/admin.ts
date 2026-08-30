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

/**
 * The operations dashboard (D47).
 *
 * One GET, one screen, six panels — deliberately one response rather than
 * six endpoints, because the question it answers ("is judging healthy right
 * now?") is only answerable by reading the panels TOGETHER: a queue backing
 * up means one thing beside a live judge and another beside a silent one.
 * Six polls on a 15-second refresh would also be six times the load for a
 * page one admin has open.
 *
 * Everything here is a snapshot with no pagination and no filters. It is a
 * health readout, not a log: the drill-down is the submission link on a
 * failure row, and the queue's own history lives in `grading_jobs`.
 */
export const AdminDashboardResponse = z.object({
  /**
   * Depth by state. `grading_jobs` has no `running` state — a claimed job is
   * `leased` — so the two are split here by the only thing that
   * distinguishes them: whether the lease is still live. `running` +
   * `expiredLeases` is therefore exactly the leased count, and
   * `expiredLeases` is the number `POST /admin/grading/reclaim` would move.
   */
  queue: z.object({
    queued: z.number().int(),
    /** Leased with a live lease — a judge is working on it right now. */
    running: z.number().int(),
    /** Leased with a lapsed lease: claimed by a worker that stopped talking. */
    expiredLeases: z.number().int(),
    failed: z.number().int(),
    /** Age of the oldest `queued` job, in seconds; `null` when none is queued. */
    oldestQueuedSeconds: z.number().nullable(),
  }),
  /**
   * The judge fleet, from `judge_nodes`. `lastSeen` is written on handshake
   * and on every ping-response, so `online` is a clock comparison against
   * the same 90-second silence the bridge itself drops a judge after.
   */
  judges: z.array(
    z.object({
      name: z.string(),
      driver: z.string(),
      lastSeen: z.string().nullable(),
      online: z.boolean(),
    }),
  ),
  /**
   * The grading workers, keyed on `grading_jobs.worker_id`.
   *
   * Separate from `judges` and NOT joinable to it: a judge node is a DMOJ
   * process that connects to judged's bridge, a worker is one of judged's
   * own claim loops, and no column relates them (D47). Throughput therefore
   * belongs here and liveness belongs there.
   */
  workers: z.array(
    z.object({
      workerId: z.string(),
      /** The submission this worker holds a live lease on, if any. */
      currentSubmissionId: z.number().int().nullable(),
      currentJobId: z.number().int().nullable(),
      gradedLastHour: z.number().int(),
      internalErrorsLastHour: z.number().int(),
    }),
  ),
  /**
   * The last 20 submissions that failed for an infrastructure reason — `IE`,
   * or a state of `errored`. Not "the last 20 wrong answers": a WA is the
   * system working.
   */
  recentFailures: z.array(
    z.object({
      submissionId: z.number().int(),
      problemCode: z.string(),
      username: z.string(),
      verdict: z.string().nullable(),
      state: z.string(),
      judgedAt: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  /**
   * Rate-limiter refusals in the last hour, by purpose, busiest first.
   * Counted from the `refused:`-prefixed marker rows the limiter writes
   * (D47); the purpose here is the bare one, with the prefix stripped.
   */
  refusalsLastHour: z.array(
    z.object({ purpose: z.string(), count: z.number().int() }),
  ),
  /**
   * Reachability, probed on this request. `database` is necessarily `up` if
   * you are reading this at all — the panels above are database reads — but
   * it is reported anyway so the panel has a shape that stays honest if the
   * dashboard ever grows a cached path.
   */
  dependencies: z.object({
    database: z.enum(['up', 'down']),
    redis: z.enum(['up', 'down']),
  }),
  /**
   * The two capacity knobs, as they are in effect for the process answering.
   *
   * `judgedConcurrency` is `null` when `JUDGED_CONCURRENCY` is not set in
   * the API's own environment: judged is a different container, and the API
   * can only report the value if compose passes the same variable to both
   * (D47). Null means "not told", never "one".
   */
  runtime: z.object({
    apiWorkers: z.number().int(),
    judgedConcurrency: z.number().int().nullable(),
  }),
  generatedAt: z.string(),
});
export type AdminDashboardResponseDto = z.infer<typeof AdminDashboardResponse>;

registry.registerPath({
  method: 'get',
  path: '/admin/dashboard',
  tags: ['Admin'],
  summary: 'Operations dashboard: queue depth, judge health, failures — admin only, session only',
  description:
    'A snapshot, not a log. Cheap enough to poll: one aggregate query per panel, no scan of anything ' +
    'unbounded. Session-only like every other admin route.',
  responses: {
    200: {
      description: 'The current snapshot',
      content: { 'application/json': { schema: AdminDashboardResponse } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
  },
});

/**
 * Requeueing lapsed leases.
 *
 * `200`, not the `202` the rejudge routes answer: the requeue itself is one
 * UPDATE that has already completed when this returns. What happens *after*
 * — a worker claiming the row, a judge grading it — is the queue doing its
 * job, exactly as it would have without the button; nothing here is
 * "accepted for later processing".
 */
export const ReclaimLeasesResponse = z.object({
  reclaimed: z.number().int(),
  /** The job ids moved back to `queued`, so the action is auditable. */
  jobIds: z.array(z.number().int()),
});
export type ReclaimLeasesResponseDto = z.infer<typeof ReclaimLeasesResponse>;

registry.registerPath({
  method: 'post',
  path: '/admin/grading/reclaim',
  tags: ['Admin'],
  summary: 'Requeue every grading job whose lease lapsed — admin only, session only',
  description:
    'Idempotent by construction: a job with a live lease is never touched, and a second call a moment ' +
    'later reclaims nothing. The requeue bumps the job attempt, which fences off a judge still working ' +
    'past its lease.',
  responses: {
    200: {
      description: 'How many jobs were requeued (possibly none)',
      content: { 'application/json': { schema: ReclaimLeasesResponse } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
  },
});
