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
  summary: 'Re-queue every submission of a problem against its current published revision',
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
      description:
        'The problem has no published revision to grade against (`problem_not_submittable`)',
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
   * Queued jobs nobody connected can run, by the reason they are stuck
   * (D68), busiest first. `blocked_reason` is a nullable text column on a
   * job that is STILL `queued` rather than a state of its own, so these
   * rows are also counted in `queue.queued` above — deliberately: a blocked
   * job becomes runnable the instant a capable judge connects, and a queue
   * panel that hid it would under-report the work waiting.
   *
   * Empty when nothing is blocked, which is the ordinary case. The reason
   * is the driver's own sentence, carried verbatim: it names the language
   * nobody can run, and paraphrasing it here would lose the only fact that
   * makes it actionable.
   */
  blockedJobs: z.array(z.object({ reason: z.string(), count: z.number().int() })),
  /**
   * The judge fleet, from `judge_nodes`. `lastSeen` is written on any packet
   * from the judge (throttled to 15 s, D68), so `online` is a clock
   * comparison against the same 90-second silence the bridge itself drops a
   * judge after.
   *
   * `gradingNow` and `gradedLastHour` are the per-MACHINE twins of the
   * worker panel's counts, and they exist because migration 0027 gave
   * `grading_jobs` a `judge_node_id`. D47 said this panel and `workers`
   * below were "not joinable", which was true of the schema it was written
   * against and stopped being true with 0027: a job now names the machine it
   * was dispatched to. The division of labour is unchanged — a worker is one
   * of judged's claim loops, a judge is a machine that grades — but each now
   * carries its own throughput, which is the question a second judge makes
   * askable ("is the new one taking any of it?").
   *
   * A job whose driver could not name a node (every in-process double)
   * counts towards neither, rather than being attributed to a guess.
   */
  judges: z.array(
    z.object({
      name: z.string(),
      driver: z.string(),
      lastSeen: z.string().nullable(),
      online: z.boolean(),
      /** Jobs this node holds a LIVE lease on — what it is grading now. */
      gradingNow: z.number().int(),
      /** Jobs dispatched here whose verdict landed in the last hour. */
      gradedLastHour: z.number().int(),
      /**
       * The driver's OWN executor names, as this judge announced them in its
       * handshake — `CPP17`, `PY3` — sorted, and `[]` for a judge that has
       * never connected since `judge_nodes.capabilities` began being written
       * (D68).
       *
       * Deliberately the raw executor names and not our language keys (which
       * are in `languages` beside them), because the question this answers is
       * the one only these names can: a language whose `executor_key` appears
       * on no connected judge is a language whose submissions will sit
       * `queued` forever, and F-39 found exactly that — an image carrying
       * CPython and four C++ standards announcing one executor, because a
       * `--only-executors` flag in Compose said so. An operator could see the
       * judge was online and could not see what it could run.
       */
      executors: z.array(z.string()),
    }),
  ),
  /**
   * The grading workers, keyed on `grading_jobs.worker_id`.
   *
   * Distinct from `judges`, though no longer unrelated to it: a judge node
   * is a DMOJ process that connects to judged's bridge, a worker is one of
   * judged's own claim loops, and a job now names both (`worker_id` since
   * the first schema, `judge_node_id` since 0027). A worker with no judge
   * (an in-process driver) and a judge with no worker (one whose claim loop
   * has since exited) both exist, so neither panel subsumes the other.
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
  refusalsLastHour: z.array(z.object({ purpose: z.string(), count: z.number().int() })),
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
    /**
     * `NAME_DISCLOSURE`, as it is in effect for the process answering (D197).
     *
     * Reported for the reason the `mail` block below is reported at all
     * (F-40): an operator set a variable, and had no way to see whether it
     * reached the process. This is the one setting whose whole job is to
     * decide what a stranger may learn about a child, so "I set it and I
     * believe it took" is not good enough — and a deployment that upgraded
     * from before D197 and left the variable unset should be able to READ the
     * protective default off the dashboard rather than infer it.
     *
     * Configuration state, never a probe: it is one field off the parsed
     * config, so a 15-second dashboard refresh costs nothing.
     */
    nameDisclosure: z.enum(['public', 'authenticated', 'affiliated']),
    /**
     * `REGISTRATION`, as it is in effect for the process answering (D200).
     *
     * Here for the reason `nameDisclosure` is, which is F-40's: an operator
     * set a variable and had no way to see whether it reached the process.
     * This one decides whether a stranger on the internet can hold an account
     * on a province's school judge, and the whole point of its default is
     * that an operator who set NOTHING is on the protective rung — so being
     * able to READ that off the dashboard rather than infer it is the
     * difference between a policy and a belief.
     */
    registration: z.enum(['open', 'closed']),
  }),
  /**
   * Whether this deployment can send mail (F-40, D156).
   *
   * **Configuration state, never a probe.** The dashboard refreshes every 15
   * seconds and `readyz` runs every 10; dialling an SMTP server on either
   * would turn a health readout into traffic against somebody else's relay,
   * and a slow or firewalled host into a page that hangs. The one place a
   * connection is actually opened is `POST /admin/mail/test`, which a human
   * presses.
   *
   * The host, port and TLS flag are here because this response is admin-only
   * and session-only, and because "configured" alone does not tell an
   * operator whether the value they are looking at is the one they meant to
   * set. **The password is not here and must never be** — `authenticated` is
   * the whole of what may be said about it.
   */
  mail: z.object({
    /** `smtp` — a real transport — or `log`, which delivers to nothing. */
    transport: z.enum(['smtp', 'log']),
    /** `false` means every mail this deployment tries to send is discarded. */
    configured: z.boolean(),
    /** `null` when unconfigured; never a guess. */
    host: z.string().nullable(),
    port: z.number().int().nullable(),
    /** Implicit TLS (port 465). `false` on 587, where STARTTLS is used. */
    secure: z.boolean(),
    /** Whether `SMTP_USER` is set. The password itself is never reported. */
    authenticated: z.boolean(),
    /** The envelope sender and `From:` header, as configured. */
    from: z.string(),
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

/**
 * D156 — the one place DuckOJ opens a real SMTP connection on purpose.
 *
 * The dashboard panel above says what is CONFIGURED, which is the honest
 * thing a 15-second poll can say. It cannot say whether the credentials are
 * right, whether the relay will accept this sender, or whether the port is
 * open through the province's firewall — and those are exactly the failures
 * that produce a stack which looks configured and delivers nothing.
 *
 * So an admin types an address they own and presses a button. That is the
 * whole design: a connection is expensive and side-effecting, so it happens
 * when a human asks for it and never on a timer.
 */
export const AdminMailTestRequest = z.object({
  /**
   * Where to send it. Required and validated, because the failure this route
   * exists to surface is indistinguishable from a typo otherwise.
   */
  to: z.string().email(),
});
export type AdminMailTestRequestDto = z.infer<typeof AdminMailTestRequest>;

export const AdminMailTestResponse = z.object({
  /** True only when the transport accepted the message for delivery. */
  delivered: z.boolean(),
  /**
   * The transport's own error text, verbatim, or `null` on success.
   *
   * **Verbatim is the requirement, not a convenience.** An operator debugging
   * this is reading `certificate has expired`, `535 5.7.8 Authentication
   * credentials invalid`, `ECONNREFUSED 10.0.0.5:587` — each of which names
   * the next thing to do. "Could not send mail" names nothing. The route is
   * admin-only and session-only, so the audience for this string is the one
   * person entitled to it.
   */
  error: z.string().nullable(),
});
export type AdminMailTestResponseDto = z.infer<typeof AdminMailTestResponse>;

registry.registerPath({
  method: 'post',
  path: '/admin/mail/test',
  tags: ['Admin'],
  summary: 'Send a test message to an address, opening a real SMTP connection — admin only, session only',
  description:
    'The only route in DuckOJ that dials the configured SMTP server on demand. A failure answers 200 with ' +
    '`delivered: false` and the transport\'s own error text — the message is the diagnosis, and an error ' +
    'status carrying a generic body would throw it away. A deployment with no SMTP host configured answers ' +
    '503 `mail_unavailable` instead: there is nothing to test.',
  request: { body: { content: { 'application/json': { schema: AdminMailTestRequest } } } },
  responses: {
    200: {
      description: 'The attempt was made. `delivered` says whether it worked.',
      content: { 'application/json': { schema: AdminMailTestResponse } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    503: {
      description: 'No SMTP host is configured on this deployment (`mail_unavailable`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});
