/**
 * The janitor for similarity runs nobody is running any more (F15's first
 * concern, D83).
 *
 * `ContestSimilarityService.start` inserts a `running` row, commits it, and
 * only then does the work in the background. Every ordinary ending is
 * covered: the work finishes and writes `finished`, or it throws and the
 * `.catch` writes `failed`. What is not covered is the process going away
 * between those two — a deploy, an OOM kill, a `SIGKILL` mid-run. The row
 * then says `running` forever, and because `start`'s check-and-insert
 * refuses a contest that already has one, that contest's button answers 409
 * for the rest of the installation's life with no way back but a hand-written
 * `UPDATE`.
 *
 * This sweep is that way back. `ExpiredRowsSweeper`'s shape exactly — an
 * `unref`'d interval, no sweep at boot, every failure a log line — because
 * the two are the same kind of thing and a second set of habits for the
 * second janitor is how one of them ends up keeping a process alive in a
 * test.
 *
 * ## What makes a run abandoned
 *
 * Two predicates, and **both are gated on the contest's advisory lock being
 * free**, which is the part that makes this safe:
 *
 * - **Older than `maxRunAgeMs`.** The obvious one, and on its own it is a
 *   guess: a genuinely enormous contest could still be comparing at minute
 *   sixteen.
 * - **Started before this process did.** A run is executed in the process
 *   that started it, so a row whose `started_at` predates this process's own
 *   boot cannot be being executed *here*. On a single-worker deployment that
 *   is proof; on a forked cluster (`API_WORKERS`) it is not, because a
 *   sibling worker may be running it — which is exactly why the lock check
 *   below is not optional.
 *
 * `execute` holds `pg_advisory_xact_lock(SIMILARITY_LOCK, contest_id)` for
 * the whole of its transaction, in whichever worker and whichever process is
 * doing the work. So `pg_try_advisory_xact_lock` on the same pair is the one
 * question that actually distinguishes "nobody is running this" from "this is
 * slow": a live run holds it, a dead one released it when its backend went
 * away. A run this sweep cannot lock is left alone and reconsidered next
 * sweep — the cost of being wrong in that direction is a stuck button for
 * five more minutes; in the other direction it is a report marked abandoned
 * while it is being written.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { and, asc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { similarityRuns } from '@duckoj/db/guarded';
import type { Db } from '@duckoj/db';
import { DB } from '../config/config.module.js';
import { SIMILARITY_LOCK } from './contest.similarity.js';

/**
 * The `error` code an abandoned run carries.
 *
 * Distinct from `similarity_run_failed`, which means "the work ran and threw"
 * — an organiser reading `abandoned` learns that nothing is wrong with their
 * contest and pressing the button again is the whole fix.
 */
export const ABANDONED = 'abandoned';

export interface SimilarityReaperBounds {
  /** How often the sweep runs. */
  readonly intervalMs: number;
  /** Past this age a `running` row with no lock holder is abandoned. */
  readonly maxRunAgeMs: number;
  /**
   * When this API process started. A `running` row older than this was
   * started by a process that is gone — subject, always, to the lock check.
   */
  readonly processStartedAt: Date;
  /**
   * The most rows one sweep considers, D78's rule applied to a table that
   * cannot grow anything like as fast: an unbounded candidate list is an
   * unbounded transaction, however unlikely the row count.
   */
  readonly batchSize: number;
}

export const SIMILARITY_REAPER_BOUNDS = Symbol('SIMILARITY_REAPER_BOUNDS');

export const DEFAULT_SIMILARITY_REAPER_BOUNDS: SimilarityReaperBounds = {
  // Five minutes: a stuck button is an annoyance, not an outage, and the
  // sweep costs one indexed lookup on a table with a row per run.
  intervalMs: 5 * 60_000,
  maxRunAgeMs: 15 * 60_000,
  processStartedAt: new Date(),
  batchSize: 100,
};

@Injectable()
export class SimilarityRunReaper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SimilarityRunReaper.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(SIMILARITY_REAPER_BOUNDS) private readonly bounds: SimilarityReaperBounds,
  ) {}

  onApplicationBootstrap(): void {
    // No sweep at boot, for `ExpiredRowsSweeper`'s reason: a test builds and
    // tears down an application per spec inside a rolled-back fixture
    // transaction, and an UPDATE firing there is a surprise nothing asked
    // for.
    this.timer = setInterval(() => void this.reapQuietly(), this.bounds.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Marks every abandoned run `failed` / `abandoned`, and returns how many.
   *
   * One transaction per contest, not one for the sweep: the lock is
   * transaction-scoped, so a single transaction would hold every contest's
   * lock until the last one committed — and one contest whose run is
   * genuinely live would then be a reason not to free any of the others.
   */
  async reap(now: Date = new Date()): Promise<number> {
    const stale = new Date(now.getTime() - this.bounds.maxRunAgeMs);
    const candidates = await this.db
      .select({ id: similarityRuns.id, contestId: similarityRuns.contestId })
      .from(similarityRuns)
      .where(
        and(
          eq(similarityRuns.status, 'running'),
          or(
            lt(similarityRuns.startedAt, stale),
            lt(similarityRuns.startedAt, this.bounds.processStartedAt),
          ),
        ),
      )
      .orderBy(asc(similarityRuns.id))
      .limit(this.bounds.batchSize);

    const byContest = new Map<number, number[]>();
    for (const row of candidates) {
      const ids = byContest.get(row.contestId);
      if (ids) ids.push(row.id);
      else byContest.set(row.contestId, [row.id]);
    }

    let reaped = 0;
    for (const [contestId, ids] of byContest) {
      reaped += await this.reapContestRuns(contestId, ids, now);
    }
    return reaped;
  }

  /**
   * One contest's abandoned runs, under its lock. Public only so a test can
   * hand it a row that finished after the candidate query read it — the race
   * the `status = 'running'` clause below exists for, and one no test could
   * otherwise stage deterministically.
   */
  async reapContestRuns(contestId: number, ids: number[], now: Date): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = (await tx.execute(
        sql`select pg_try_advisory_xact_lock(${SIMILARITY_LOCK}, ${contestId}) as got`,
      )) as unknown as Array<{ got: boolean }>;
      // Somebody is running it. Not a failure and not worth a log line —
      // the next sweep asks again.
      if (rows[0]?.got !== true) return 0;

      // `status = 'running'` is restated here and not only in the candidate
      // query: the run can finish between the two statements, and without
      // this clause the sweep would stamp `abandoned` over a `finished` row
      // — turning a completed report into a failed one for the organiser
      // watching it land.
      const result = await tx
        .update(similarityRuns)
        .set({ status: 'failed', finishedAt: now, error: ABANDONED })
        .where(and(inArray(similarityRuns.id, ids), eq(similarityRuns.status, 'running')));
      return affected(result);
    });
  }

  /** The timer's entry point: a failed sweep is a log line, never a crash. */
  private async reapQuietly(): Promise<void> {
    try {
      const reaped = await this.reap();
      if (reaped > 0) {
        this.logger.warn(`marked ${String(reaped)} abandoned similarity run(s) as failed`);
      }
    } catch (error) {
      this.logger.warn(
        `similarity reap failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * How many rows an UPDATE touched, off the driver's own count —
 * `ExpiredRowsSweeper`'s `affected`, for its reason: `.returning()` here
 * would drag ids back over the wire to read `.length`.
 */
function affected(result: unknown): number {
  const count = (result as { count?: unknown } | null)?.count;
  return typeof count === 'number' ? count : 0;
}
