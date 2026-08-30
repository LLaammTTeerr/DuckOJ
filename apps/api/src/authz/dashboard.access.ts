/**
 * The admin operations dashboard (D47) — one snapshot of whether judging is
 * healthy right now.
 *
 * **Why it lives in `authz/**`.** Two of its panels read `submissions` and
 * `problems`, which are guarded tables: `@duckoj/db/guarded` may only be
 * imported from here (docs/runbook.md, "Reading a guarded table"). The
 * visibility rule this service applies is the simplest one in the codebase —
 * admin sees everything, nobody else gets past `isAdmin` — but it is still
 * applied HERE rather than in a controller, for the same reason every other
 * `*.access.ts` service does it.
 *
 * **Every panel is bounded, and migration 0025 is what bounds them.** D47
 * shipped this service with three queries that were linear in how much
 * grading the deployment had ever done — `grading_jobs` and `submissions`
 * both keep every row forever (D11) — and recorded the upgrade path rather
 * than paying for an index against a guess. The guess is gone; the measured
 * numbers are in D47's amendment and in `test/admin-dashboard-plan.spec.ts`,
 * which asserts the PLANS rather than the timings. At 200 000 grading jobs:
 *
 * - `queue()` parallel-seq-scanned the whole table (22.9 ms). It now reads
 *   `where state <> 'done'` — semantics-preserving, because all four states
 *   it counts are non-done — through `grading_jobs_active_idx`: 150 rows,
 *   0.9 ms.
 * - `workers()` hash-joined all 200 000 jobs to all 200 000 submissions
 *   (88.3 ms). It is now TWO bounded queries merged here in JavaScript, and
 *   since B-19 the plan spec asserts BOTH of them: the live half was
 *   rewritten in the same commit as the throughput half and then pinned by
 *   nothing, which is why "workers() is unbounded" survived three review
 *   loops after it had stopped being true.
 * - `recentFailures()` walked 151 501 clean submissions backwards to find
 *   twenty failures (18.5 ms) — and got slower the LONGER judging stayed
 *   healthy. Its SQL is unchanged; `submissions_failed_idx` now serves both
 *   the filter and the ordering (0.35 ms).
 *
 * A query here runs every 15 seconds against a pool of ten connections per
 * worker, so "linear in history" was not a cosmetic problem: it is the admin
 * page taking a growing bite out of the database during a contest.
 *
 * **Nothing here is cached.** The page refreshes every 15 seconds for one
 * admin at a time; a cache would add a staleness question to a screen whose
 * entire job is to be current.
 */
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import { availableParallelism } from 'node:os';
import type { Db } from '@duckoj/db';
import { reclaimExpiredLeases } from '@duckoj/db';
import type { AdminDashboardResponseDto, ReclaimLeasesResponseDto } from '@duckoj/contracts';
import { APP_CONFIG, DB } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { AppError } from '../common/app.error.js';
import { REFUSAL_PREFIX } from '../common/rate-limiter.js';
import { resolveWorkerCount } from '../cluster.js';
import { isAdmin, type Actor } from './actor.js';

/**
 * How long a judge may be silent before the dashboard calls it offline.
 *
 * 90 seconds because that is judged's own rule: `BridgeServer` drops a judge
 * after `PING_INTERVAL_MS` (30 s) × `MISSED_PING_LIMIT` (3), and
 * `judge_nodes.last_seen` is written on exactly the two signals that sweep
 * feeds on — the handshake and every ping-response. Duplicated rather than
 * imported for the reason `apps/judged`'s `languageToExecutor` duplicates
 * its mapping: `apps/api` must not depend on `apps/judged`. If judged's
 * numbers move, this one is wrong and a judge reads as online for a minute
 * too long — an observability drift, not a correctness one.
 */
export const JUDGE_SILENCE_SECONDS = 90;

/** How many failures the dashboard carries. A readout, not a log. */
const RECENT_FAILURE_LIMIT = 20;

export const REDIS_HEALTH = Symbol('REDIS_HEALTH');

export interface RedisHealth {
  /** True when Redis answered a PING. Never throws. */
  reachable(): Promise<boolean>;
}

/**
 * The production probe. Mirrors `RedisScoreboardCacheStore` deliberately,
 * down to its reasoning: a lazily-opened connection with no offline queue,
 * an `error` listener attached so ioredis does not re-raise on the process,
 * and `disconnect()` rather than `quit()` on shutdown.
 *
 * The lazy connection is what keeps the rest of the suite untouched —
 * `TEST_CONFIG.redisUrl` points at a deliberately unreachable port, so a
 * spec that builds the app and never opens the dashboard never dials
 * anything.
 */
@Injectable()
export class RedisHealthProbe implements RedisHealth, OnModuleDestroy {
  private readonly logger = new Logger(RedisHealthProbe.name);
  private redis: Redis | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'redisUrl'>) {}

  async reachable(): Promise<boolean> {
    try {
      const pong = await this.connection().ping();
      return pong === 'PONG';
    } catch (error) {
      // Debug, not warn: this method's whole purpose is to answer "is it
      // down", and a dashboard poll every 15 seconds against a Redis that is
      // legitimately down must not become a log flood.
      this.logger.debug(`redis unreachable: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private connection(): Redis {
    if (this.redis) return this.redis;
    const redis = new Redis(this.config.redisUrl, {
      // A health probe that queues offline would report `up` for a Redis
      // that is not there: the PING would sit in the queue and resolve on a
      // reconnect that may never come.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 2000,
      connectTimeout: 2000,
    });
    redis.on('error', () => undefined);
    this.redis = redis;
    return redis;
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
    this.redis = null;
  }
}

/** Rows come back from `db.execute` as strings for bigint/numeric columns. */
function num(value: unknown): number {
  return Number(value ?? 0);
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

@Injectable()
export class DashboardService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS_HEALTH) private readonly redis: RedisHealth,
  ) {}

  async snapshot(actor: Actor): Promise<AdminDashboardResponseDto> {
    this.requireAdmin(actor);

    // Sequential, not `Promise.all`: one postgres.js connection serialises
    // its queries anyway, so parallelism here would buy nothing and would
    // make a failure in one panel harder to attribute.
    const queue = await this.queue();
    const blockedJobs = await this.blockedJobs();
    const judges = await this.judges();
    const workers = await this.workers();
    const recentFailures = await this.recentFailures();
    const refusalsLastHour = await this.refusals();
    const redisUp = await this.redis.reachable();

    return {
      queue,
      blockedJobs,
      judges,
      workers,
      recentFailures,
      refusalsLastHour,
      dependencies: {
        // Reaching this line at all means every query above answered.
        database: 'up',
        redis: redisUp ? 'up' : 'down',
      },
      runtime: {
        apiWorkers: resolveWorkerCount(process.env, availableParallelism()),
        judgedConcurrency: this.judgedConcurrency(),
      },
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Requeues every lapsed lease and reports what moved.
   *
   * The statement itself lives in `@duckoj/db` because judged's own worker
   * pool runs the same sweep (D47) — see `reclaimExpiredLeases` for why it
   * bumps the job attempt.
   */
  async reclaimLeases(actor: Actor): Promise<ReclaimLeasesResponseDto> {
    this.requireAdmin(actor);
    const jobIds = await reclaimExpiredLeases(this.db);
    return { reclaimed: jobIds.length, jobIds };
  }

  /**
   * 403, not 404: every other read in this codebase answers 404 for a thing
   * the actor may not see, because the answer would leak that it exists.
   * There is no resource here to leak — `/admin/dashboard` is a fixed path
   * whose existence is in the published OpenAPI document — so the honest
   * answer is the one `AdminUsersService.grantRole` gives.
   */
  private requireAdmin(actor: Actor): void {
    if (!isAdmin(actor)) {
      throw new AppError(403, 'admin_forbidden', 'Only an admin may read the operations dashboard.');
    }
  }

  /**
   * `JUDGED_CONCURRENCY` as the API can see it — which is only if compose
   * hands the same variable to both containers. Unset is `null` ("nobody
   * told me"), never a guessed 1: a dashboard that invents a capacity number
   * is worse than one that admits it does not know. An unparseable value is
   * also `null` rather than a throw — unlike `API_WORKERS`, this knob does
   * not govern the process reading it, so it must not be able to 500 the
   * dashboard.
   */
  private judgedConcurrency(): number | null {
    const raw = process.env.JUDGED_CONCURRENCY?.trim();
    if (raw === undefined || raw === '' || !/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return value >= 1 ? value : null;
  }

  private async queue(): Promise<AdminDashboardResponseDto['queue']> {
    // `expiredLeases` is written to match `reclaimExpiredLeases`'s WHERE
    // exactly, because the UI labels it as what the reclaim button would
    // move. If the two ever disagree the button lies about its own effect.
    //
    // `where state <> 'done'` is a rewrite, not a narrowing: every state this
    // aggregate counts — queued, leased, failed — is already non-done, and so
    // is the `min(created_at)` filtered to queued. It exists to hand the
    // planner a restriction that provably implies
    // `grading_jobs_active_idx`'s predicate, which turns a scan of every job
    // the deployment has ever run into a scan of the ones still in flight.
    const rows = await this.db.execute<{
      queued: string;
      running: string;
      expired: string;
      failed: string;
      oldest_queued_seconds: string | null;
    }>(sql`
      select count(*) filter (where state = 'queued')                          as queued,
             count(*) filter (where state = 'leased' and lease_until >= now()) as running,
             count(*) filter (where state = 'leased' and lease_until <  now()) as expired,
             count(*) filter (where state = 'failed')                          as failed,
             extract(epoch from (now() - min(created_at) filter (where state = 'queued')))
                                                                               as oldest_queued_seconds
        from grading_jobs
       where state <> 'done'
    `);
    const row = rows[0];
    return {
      queued: num(row?.queued),
      running: num(row?.running),
      expiredLeases: num(row?.expired),
      failed: num(row?.failed),
      oldestQueuedSeconds:
        row?.oldest_queued_seconds === null || row?.oldest_queued_seconds === undefined
          ? null
          : Math.max(0, Math.round(Number(row.oldest_queued_seconds))),
    };
  }

  /**
   * The judge fleet, and what each machine is carrying (D68, migration 0027).
   *
   * Three queries rather than one, for `workers()`'s reason and with its
   * shape: the roster is `judge_nodes` (tiny, one row per machine ever
   * registered), what a node is grading NOW is bounded by the work in
   * flight, and what it finished is bounded by an hour. A single left join
   * from `judge_nodes` to `grading_jobs` would put every job the deployment
   * has ever run on the other side of it — the exact query 0025 removed from
   * this file, reintroduced through a different column.
   *
   * The bounds:
   *
   * - **In flight** carries `state <> 'done'` alongside `state = 'leased'`.
   *   The second implies the first, but the planner has to PROVE the
   *   restriction implies `grading_jobs_active_idx`'s predicate to use the
   *   index, and spelling the predicate out word for word is what makes that
   *   proof trivial. Same rewrite, same reason, as `queue()`.
   * - **The hour** is driven from `submissions.judged_at` through
   *   `submissions_judged_at_idx` and reaches `judge_node_id` by an index
   *   lookup per row, exactly as the worker panel's throughput half does.
   *   `judged_at`, not `created_at`: "graded in the last hour" is about when
   *   the verdict landed.
   *
   * A judge with no rows in either is reported with zeros rather than
   * dropped — unlike `workers()`, the roster here is the `judge_nodes` table
   * itself, and an idle judge is a fact an operator wants on screen. And a
   * job with a null `judge_node_id` (every in-process driver, D68) is
   * counted nowhere: a guess would be worse than a zero.
   */
  private async judges(): Promise<AdminDashboardResponseDto['judges']> {
    const rows = await this.db.execute<{
      id: string;
      name: string;
      driver: string;
      last_seen: Date | null;
      online: boolean;
    }>(sql`
      select id, name, driver, last_seen,
             (last_seen is not null
              and last_seen > now() - make_interval(secs => ${JUDGE_SILENCE_SECONDS}::double precision)) as online
        from judge_nodes
       order by name
    `);

    const live = await this.db.execute<{ judge_node_id: string; grading_now: string }>(sql`
      select judge_node_id, count(*) as grading_now
        from grading_jobs
       where state <> 'done'
         and state = 'leased'
         and lease_until >= now()
         and judge_node_id is not null
       group by judge_node_id
    `);

    const throughput = await this.db.execute<{ judge_node_id: string; graded_last_hour: string }>(sql`
      select j.judge_node_id, count(*) as graded_last_hour
        from submissions s
        join grading_jobs j on j.submission_id = s.id
       where s.judged_at > now() - interval '1 hour'
         and j.judge_node_id is not null
       group by j.judge_node_id
    `);

    const gradingNow = new Map(live.map((row) => [String(row.judge_node_id), num(row.grading_now)]));
    const gradedLastHour = new Map(
      throughput.map((row) => [String(row.judge_node_id), num(row.graded_last_hour)]),
    );

    return rows.map((row) => ({
      name: row.name,
      driver: row.driver,
      lastSeen: iso(row.last_seen),
      online: row.online === true,
      gradingNow: gradingNow.get(String(row.id)) ?? 0,
      gradedLastHour: gradedLastHour.get(String(row.id)) ?? 0,
    }));
  }

  /**
   * Why the queue is not moving, in the queue's own words (D68).
   *
   * `blocked_reason` is text on a job that is still `queued`, so this is a
   * `group by` over the reasons rather than a new state to count. The
   * `state = 'queued'` term is what keeps it honest: `JobStore.claim` clears
   * the reason in the same UPDATE that claims, but a reason left on a row
   * that has since moved on must never be reported as a blockage.
   *
   * `state <> 'done'` leads for `queue()`'s reason — it is
   * `grading_jobs_active_idx`'s predicate, spelled so the planner can prove
   * it applies.
   */
  private async blockedJobs(): Promise<AdminDashboardResponseDto['blockedJobs']> {
    const rows = await this.db.execute<{ reason: string; n: string }>(sql`
      select blocked_reason as reason, count(*) as n
        from grading_jobs
       where state <> 'done'
         and state = 'queued'
         and blocked_reason is not null
       group by 1
       order by n desc, 1 asc
    `);
    return rows.map((row) => ({ reason: row.reason, count: num(row.n) }));
  }

  /**
   * The worker panel: what each of judged's claim loops is doing now, and how
   * much it has finished in the last hour.
   *
   * **Two queries, not one, and that is the whole fix.** D47 asked both
   * questions with a single `left join` from `grading_jobs` to `submissions`
   * and no restriction on either side, which is a hash join of two tables
   * that keep every row forever (D11) — 88.3 ms at 200 000 jobs, every 15
   * seconds, growing. The two questions have nothing in common but the
   * grouping key:
   *
   * - **What is it grading?** Every job not yet done, so `state <> 'done'` —
   *   a set bounded by how much work is in flight, not by how much has ever
   *   been done, and exactly `grading_jobs_active_idx`'s predicate. The
   *   `max(case …)` picks out only the LIVE lease, so a worker sitting on an
   *   EXPIRED one is still listed, with nothing being graded: that row is the
   *   panel's "this claim loop is stuck" signal, and restricting the query to
   *   live leases would have deleted it. Still `max(…)`, and still for D47's
   *   reason: a claim loop grades one job at a time, so the aggregate is a
   *   pick, not a reduction.
   * - **What has it finished?** A time window, so drive it from the windowed
   *   side — `submissions.judged_at`, through `submissions_judged_at_idx` —
   *   and reach `worker_id` by an index lookup per row through
   *   `grading_jobs_submission_idx`. `judged_at` rather than `created_at` is
   *   D47's ruling, unchanged and deliberately kept: "graded in the last
   *   hour" is about when the verdict landed, not when the student pressed
   *   submit, and windowing on `created_at` would report a worker chewing
   *   through a backlog as having graded nothing.
   *
   * An `inner` join here where D47 wrote `left`: this half counts jobs, and a
   * job with no submission row cannot have a `judged_at` inside the window,
   * so it contributed zero to both counts before and is absent now. A
   * submission graded more than once (a rejudge, D9) still contributes one
   * row per job to its worker's count, exactly as the single query did —
   * unchanged, not overlooked.
   *
   * The merge is a full outer one: a worker with a job in flight may have
   * finished nothing this hour, and a worker that finished work may have
   * nothing in flight now. Either half alone would drop a row.
   *
   * **What the roster no longer contains**, ruled rather than overlooked: a
   * worker whose every job is done and whose last verdict landed over an hour
   * ago is now absent, where D47's single query listed it forever with zeros.
   * That is the panel's own division of labour — D47 puts LIVENESS on the
   * judge panel and throughput here — and the alternative is a
   * `select distinct worker_id from grading_jobs`, which is the unbounded
   * scan this rewrite exists to remove. A worker that is merely stuck, rather
   * than gone, still holds a non-done job and is still listed.
   */
  private async workers(): Promise<AdminDashboardResponseDto['workers']> {
    const live = await this.db.execute<{
      worker_id: string;
      current_submission_id: string | null;
      current_job_id: string | null;
    }>(sql`
      select worker_id,
             max(case when state = 'leased' and lease_until >= now()
                      then submission_id end) as current_submission_id,
             max(case when state = 'leased' and lease_until >= now()
                      then id end)            as current_job_id
        from grading_jobs
       where state <> 'done'
         and worker_id is not null
       group by worker_id
    `);

    const throughput = await this.db.execute<{
      worker_id: string;
      graded_last_hour: string;
      ie_last_hour: string;
    }>(sql`
      select j.worker_id,
             count(*)                                 as graded_last_hour,
             count(*) filter (where s.verdict = 'IE') as ie_last_hour
        from submissions s
        join grading_jobs j on j.submission_id = s.id
       where s.judged_at > now() - interval '1 hour'
         and j.worker_id is not null
       group by j.worker_id
    `);

    const byWorker = new Map<string, AdminDashboardResponseDto['workers'][number]>();
    const row = (workerId: string): AdminDashboardResponseDto['workers'][number] => {
      const existing = byWorker.get(workerId);
      if (existing) return existing;
      const created = {
        workerId,
        currentSubmissionId: null as number | null,
        currentJobId: null as number | null,
        gradedLastHour: 0,
        internalErrorsLastHour: 0,
      };
      byWorker.set(workerId, created);
      return created;
    };

    for (const r of live) {
      const target = row(r.worker_id);
      target.currentSubmissionId = r.current_submission_id === null ? null : num(r.current_submission_id);
      target.currentJobId = r.current_job_id === null ? null : num(r.current_job_id);
    }
    for (const r of throughput) {
      const target = row(r.worker_id);
      target.gradedLastHour = num(r.graded_last_hour);
      target.internalErrorsLastHour = num(r.ie_last_hour);
    }

    // `order by worker_id` moved out of SQL with the single query it belonged
    // to. Sorted here so the panel's row order is still stable across polls,
    // which is what an operator watching one row actually depends on.
    return [...byWorker.values()].sort((a, b) => (a.workerId < b.workerId ? -1 : a.workerId > b.workerId ? 1 : 0));
  }

  private async recentFailures(): Promise<AdminDashboardResponseDto['recentFailures']> {
    // `verdict = 'IE'` OR `state = 'errored'`: the second catches a
    // submission the pipeline gave up on before any verdict existed — a
    // compile-infrastructure failure that never reached a case. A WA is not
    // a failure and is deliberately absent.
    //
    // This clause is now also `submissions_failed_idx`'s predicate, word for
    // word. Do not "tidy" it into `state = 'errored' or verdict = 'IE'`, an
    // `in (…)`, or a `coalesce`: a partial index serves only a query whose
    // restriction Postgres can prove implies the predicate, and the failure
    // mode of getting that wrong is silent — the same twenty rows, back to
    // walking every clean submission since the last incident to find them.
    const rows = await this.db.execute<{
      id: string;
      code: string;
      username: string;
      verdict: string | null;
      state: string;
      judged_at: Date | null;
      created_at: Date;
    }>(sql`
      select s.id, p.code, u.username, s.verdict, s.state, s.judged_at, s.created_at
        from submissions s
        join problems p on p.id = s.problem_id
        join users u    on u.id = s.user_id
       where s.verdict = 'IE' or s.state = 'errored'
       order by s.id desc
       limit ${RECENT_FAILURE_LIMIT}
    `);
    return rows.map((row) => ({
      submissionId: num(row.id),
      problemCode: row.code,
      username: row.username,
      verdict: row.verdict,
      state: row.state,
      judgedAt: iso(row.judged_at),
      createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    }));
  }

  private async refusals(): Promise<AdminDashboardResponseDto['refusalsLastHour']> {
    // The prefix length is derived from the constant, never typed as a
    // literal: `substring(purpose from 9)` and `REFUSAL_PREFIX` are the same
    // fact, and one of them silently truncating every purpose by a character
    // is exactly the bug a literal invites. The `::int` cast is load-bearing:
    // an untyped parameter resolves to `substring(text FROM text)`, which is
    // the POSIX-REGEX overload, and every purpose comes back null.
    const rows = await this.db.execute<{ purpose: string; n: string }>(sql`
      select substring(purpose from ${REFUSAL_PREFIX.length + 1}::int) as purpose, count(*) as n
        from rate_events
       where purpose like ${`${REFUSAL_PREFIX}%`}
         and created_at > now() - interval '1 hour'
       group by 1
       order by n desc, 1 asc
    `);
    return rows.map((row) => ({ purpose: row.purpose, count: num(row.n) }));
  }
}
