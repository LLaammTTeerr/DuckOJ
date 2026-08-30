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
 * **One query per panel, and no query that can grow without bound in a way
 * an operator would notice.** The queue and worker panels are aggregates
 * over `grading_jobs`, which grows forever (D11 keeps grading history), so
 * they are sequential scans of a table that is thousands of rows at province
 * scale and would want a partial index — `on grading_jobs (state) where
 * state <> 'done'` — at a scale this deployment does not have. Deliberately
 * not added: an index nobody has measured a need for is a migration and a
 * write cost paid against a guess. The same applies to the failures panel's
 * filter on `submissions`. Recorded in D47 so the next person finds the
 * upgrade path rather than rediscovering it.
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
    const judges = await this.judges();
    const workers = await this.workers();
    const recentFailures = await this.recentFailures();
    const refusalsLastHour = await this.refusals();
    const redisUp = await this.redis.reachable();

    return {
      queue,
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

  private async judges(): Promise<AdminDashboardResponseDto['judges']> {
    const rows = await this.db.execute<{
      name: string;
      driver: string;
      last_seen: Date | null;
      online: boolean;
    }>(sql`
      select name, driver, last_seen,
             (last_seen is not null
              and last_seen > now() - make_interval(secs => ${JUDGE_SILENCE_SECONDS}::double precision)) as online
        from judge_nodes
       order by name
    `);
    return rows.map((row) => ({
      name: row.name,
      driver: row.driver,
      lastSeen: iso(row.last_seen),
      online: row.online === true,
    }));
  }

  private async workers(): Promise<AdminDashboardResponseDto['workers']> {
    // `max(case …)` rather than a second query per worker: a worker holds at
    // most one live lease (its claim loop grades one job at a time), so the
    // aggregate is a pick, not a reduction. `judged_at` — not `created_at` —
    // dates the throughput counts, because "graded in the last hour" is
    // about when the verdict landed, not when the student pressed submit.
    const rows = await this.db.execute<{
      worker_id: string;
      current_submission_id: string | null;
      current_job_id: string | null;
      graded_last_hour: string;
      ie_last_hour: string;
    }>(sql`
      select j.worker_id,
             max(case when j.state = 'leased' and j.lease_until >= now()
                      then j.submission_id end)                          as current_submission_id,
             max(case when j.state = 'leased' and j.lease_until >= now()
                      then j.id end)                                     as current_job_id,
             count(*) filter (where s.judged_at > now() - interval '1 hour')
                                                                         as graded_last_hour,
             count(*) filter (where s.judged_at > now() - interval '1 hour'
                                and s.verdict = 'IE')                    as ie_last_hour
        from grading_jobs j
        left join submissions s on s.id = j.submission_id
       where j.worker_id is not null
       group by j.worker_id
       order by j.worker_id
    `);
    return rows.map((row) => ({
      workerId: row.worker_id,
      currentSubmissionId: row.current_submission_id === null ? null : num(row.current_submission_id),
      currentJobId: row.current_job_id === null ? null : num(row.current_job_id),
      gradedLastHour: num(row.graded_last_hour),
      internalErrorsLastHour: num(row.ie_last_hour),
    }));
  }

  private async recentFailures(): Promise<AdminDashboardResponseDto['recentFailures']> {
    // `verdict = 'IE'` OR `state = 'errored'`: the second catches a
    // submission the pipeline gave up on before any verdict existed — a
    // compile-infrastructure failure that never reached a case. A WA is not
    // a failure and is deliberately absent.
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
