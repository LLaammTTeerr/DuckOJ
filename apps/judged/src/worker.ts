import type { JudgeDriver } from '@duckoj/judge-protocol';
import { describeError } from '@duckoj/observability';
import type { EventWriter } from './event-writer.js';
import type { ClaimedJob, JobStore } from './job-store.js';

export const HEARTBEAT_MS = 20_000;
/**
 * Ceiling on a single job's dispatch-to-terminal-event span. Without this, a
 * collaborator that hangs (e.g. a Redis publish that never settles because
 * the offline queue is buffering forever) wedges the entire worker loop
 * silently — the lease keeps renewing, so the job never even re-leases.
 * Rejecting here turns that into a logged, self-healing delay: A4's `catch`
 * logs it and the loop moves on; the abandoned job's lease lapses normally.
 */
export const MAX_GRADING_MS = 300_000;
/**
 * Hard cap on the dataset-aware ceiling below: a hostile 10k-test package
 * must not be able to pin the judge for an afternoon per attempt.
 */
export const ABSOLUTE_MAX_GRADING_MS = 1_800_000;

/**
 * A 350-test problem with 1s limits legitimately needs >350s for a
 * TLE-prone submission; a fixed 300s ceiling turned that into an infinite
 * terminate → re-lease → terminate loop (claim() takes the oldest job
 * first, so the same one starves everything behind it forever). 3x per
 * case covers compile + checker + sandbox overhead; the minute of slack
 * covers dispatch and package materialisation.
 */
export function gradingCeilingMs(job: { testCount: number | null; timeMs: number }): number {
  if (job.testCount === null) return MAX_GRADING_MS;
  const budget = job.testCount * job.timeMs * 3 + 60_000;
  return Math.min(Math.max(MAX_GRADING_MS, budget), ABSOLUTE_MAX_GRADING_MS);
}
const POLL_MS = 500;

/**
 * Claims one job at a time, dispatches it, and heartbeats until the driver
 * reports a terminal event.
 *
 * Phase 1 has no scheduling policy at all — jobs are taken in creation order,
 * one judge, first-come-first-served. Priority classes and fairness arrive in
 * Phase 4, when contests create contention worth arbitrating.
 */
export class Worker {
  private running = false;
  /** The job currently in flight, so `heartbeatOnce` has something to act on. */
  private current: ClaimedJob | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly jobs: JobStore,
    private readonly writer: EventWriter,
    private readonly driver: JudgeDriver,
    private readonly workerId: string,
    private readonly maxGradingMs: number = MAX_GRADING_MS,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      // Reserve judge capacity BEFORE claiming, never after. A job claimed
      // with no judge free to run it sits leased-but-unrunnable for its whole
      // lease, and the grading watchdog that eventually fires on it is the
      // cancel B2 turned into a different student's permanent IE. Reserving
      // first means a claimed job is always immediately runnable.
      //
      // A driver that does not implement `tryAcquireSlot` (every in-process
      // test double) is treated as unlimited, exactly as before.
      let releaseSlot: (() => void) | null = null;
      if (this.driver.tryAcquireSlot) {
        releaseSlot = this.driver.tryAcquireSlot();
        if (!releaseSlot) {
          // Saturated: back off on the same poll delay used for "no job
          // available" and leave the queue to whichever loop holds a slot.
          // `stop()` is still honoured, because the loop keeps turning.
          await new Promise((r) => setTimeout(r, POLL_MS));
          continue;
        }
      }

      try {
        let claimed: ClaimedJob | null;
        try {
          claimed = await this.jobs.claim(this.workerId);
        } catch (error: unknown) {
          // A transient database error here (a dropped connection, Postgres
          // restarting) must not end the loop: `claim()` used to sit outside
          // any try, so a rejection propagated out of `start()` and killed the
          // whole worker — every submission from then on sits at `queued`
          // forever with nothing to claim it, and no alarm anywhere. Logging
          // and retrying after the same poll delay used for "no job available"
          // makes this self-healing instead.
          console.error(
            JSON.stringify({
              msg: 'claim failed',
              error: describeError(error),
            }),
          );
          await new Promise((r) => setTimeout(r, POLL_MS));
          continue;
        }
        if (!claimed) {
          await new Promise((r) => setTimeout(r, POLL_MS));
          continue;
        }

        this.current = claimed;
        this.heartbeatTimer = setInterval(() => {
          // `heartbeatOnce` awaits a DB round-trip; an unguarded rejection here
          // is an unhandled rejection that terminates the Node 22 process, same
          // failure mode as the unguarded `claim()` above.
          void this.heartbeatOnce().catch((error: unknown) => {
            console.error(
              JSON.stringify({
                msg: 'heartbeat failed',
                jobId: claimed.id,
                attempt: claimed.attempt,
                error: describeError(error),
              }),
            );
          });
        }, HEARTBEAT_MS);
        let watchdog: NodeJS.Timeout | null = null;

        try {
          await new Promise<void>((resolve, reject) => {
            const ceilingMs = Math.min(gradingCeilingMs(claimed), this.maxGradingMs === MAX_GRADING_MS ? Infinity : this.maxGradingMs);
            watchdog = setTimeout(() => {
              reject(
                new Error(
                  `grading exceeded ${ceilingMs}ms for job ${claimed.id} attempt ${claimed.attempt}`,
                ),
              );
            }, ceilingMs);

            this.driver
              .dispatch(
                {
                  id: String(claimed.id),
                  attempt: claimed.attempt,
                  kind: 'submission',
                  packageHash: claimed.packageHash,
                  revisionId: String(claimed.revisionId),
                  language: claimed.languageKey,
                  source: claimed.source,
                  limits: { timeMs: claimed.timeMs, memoryKb: claimed.memoryKb },
                },
                async (event) => {
                  // A failed write must fail the ATTEMPT, not vanish into the
                  // driver's per-packet catch: before this, a rejected
                  // submission_cases insert was logged and skipped while
                  // grading sailed on to a clean 'done' with rows silently
                  // missing — an at-most-once delivery under a comment economy
                  // that promises at-least-once. Rejecting here leaves the job
                  // uncompleted, so the lease lapse regrades the whole attempt.
                  let current: boolean;
                  try {
                    current = await this.writer.apply(claimed, event);
                  } catch (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                    throw error;
                  }
                  if (!current) return resolve();
                  if (
                    event.type === 'finished' ||
                    event.type === 'compileError' ||
                    event.type === 'internalError' ||
                    event.type === 'terminated'
                  ) {
                    resolve();
                  }
                },
              )
              .catch(reject);
          });
          await this.jobs.complete(claimed.id, claimed.attempt);
        } catch (error: unknown) {
          // One job's failure must not end the loop for every other
          // submission: log it and let the loop go around for the next claim.
          // This deliberately does not bound retries — the job re-leases after
          // the lease window and may fail again. An attempt cap is scheduling
          // policy, deferred to Phase 4.
          console.error(
            JSON.stringify({
              msg: 'job failed',
              jobId: claimed.id,
              attempt: claimed.attempt,
              error: describeError(error),
            }),
          );
          // Whatever ended the try block without the dispatch promise
          // resolving — the watchdog firing chief among them — must not leave
          // the driver still grading this attempt: DmojDriver reuses DMOJ's
          // submission-id across retries on the precondition that the previous
          // attempt was terminated first (see its `dispatch` doc comment).
          // Cancelling here is what makes that precondition hold on this path
          // too, not only the lease-lapsed one in `heartbeatOnce`. `cancel`
          // itself is fenced by (job id, attempt) in every driver, so calling
          // it here is a safe no-op when there is nothing live to cancel (e.g.
          // `dispatch` rejected before ever registering a live entry) — and
          // in `DmojDriver` it is addressed to the one connection actually
          // running this submission, so a job that never reached a judge
          // cancels nothing rather than terminating somebody else's grade.
          try {
            await this.driver.cancel(String(claimed.id), claimed.attempt);
          } catch (cancelError: unknown) {
            console.error(
              JSON.stringify({
                msg: 'cancel after job failure also failed',
                jobId: claimed.id,
                attempt: claimed.attempt,
                error: describeError(cancelError),
              }),
            );
          }
        } finally {
          if (watchdog) clearTimeout(watchdog);
          if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
          this.current = null;
        }
      } finally {
        // Every exit from the block above — the `continue`s, a throw, a
        // normal completion — gives the judge slot back here. A slot leaked
        // on one path would silently shrink the fleet for the rest of the
        // process's life.
        releaseSlot?.();
      }
    }
  }

  /**
   * Extends the lease for the in-flight job. When the lease has already
   * lapsed and been claimed away, stops the heartbeat and tells the driver to
   * cancel — an abandoned grade must not keep burning judge capacity.
   */
  async heartbeatOnce(): Promise<void> {
    const current = this.current;
    if (!current) return;
    const held = await this.jobs.heartbeat(current.id, current.attempt);
    if (held) return;
    // The awaited heartbeat round-trip is the race window: if this job
    // finished (or was superseded and replaced) while we were waiting on
    // `jobs.heartbeat`, `this.current` now points at whatever the loop
    // claimed next. Touching `heartbeatTimer` or cancelling past this point
    // would act on the successor's state, not this stale call's own job.
    if (this.current !== current) return;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    await this.driver.cancel(String(current.id), current.attempt);
  }

  stop(): void {
    this.running = false;
  }
}

/**
 * A fixed set of independent claim loops over one JobStore — the whole of
 * `JUDGED_CONCURRENCY`.
 *
 * Concurrency is safe on the database side because it was designed for:
 * `JobStore.claim` takes its row under `FOR UPDATE SKIP LOCKED`, so two loops
 * racing get two different jobs (or one gets null) rather than the same row
 * twice — proved against a real Postgres over two connections in
 * `job-store.concurrency.spec.ts` — and `heartbeat`/`complete`/
 * `isCurrentAttempt` all fence on `(job id, attempt)` rather than on the
 * claimant, so no loop can renew or finish another's attempt. `worker_id`
 * itself is written but never read back for control flow; it is diagnostic,
 * which is why suffixing it below is free.
 *
 * Each loop gets `#1`, `#2`, … appended so `grading_jobs.worker_id` still
 * names exactly one loop when a stuck job has to be traced to its logs.
 *
 * It is NOT safe on the judge side by itself, and this is what B2 cost us: a
 * pool that claims more jobs than the fleet can grade leaves the surplus
 * leased with nothing running it, and the grading watchdog that eventually
 * fires cancels a job the judge never started. `Worker` therefore reserves a
 * judge slot through `driver.tryAcquireSlot()` before it claims, so the
 * number of jobs in flight is bounded by the number of judge connections, not
 * by this number. Raising this knob past the number of judge containers now
 * buys nothing at all — the extra loops simply never win a slot. See
 * docs/runbook.md, "Judging throughput".
 */
export function startWorkerPool(
  jobs: JobStore,
  writer: EventWriter,
  driver: JudgeDriver,
  workerId: string,
  concurrency: number,
): { workers: Worker[]; finished: Promise<void>; stop: () => void } {
  const workers = Array.from(
    { length: concurrency },
    (_unused, index) => new Worker(jobs, writer, driver, `${workerId}#${index + 1}`),
  );
  // `Promise.all`, not `race`: `finished` must not settle while any loop is
  // still grading, or a caller awaiting it would let the process exit with a
  // job in flight and its lease still held.
  const finished = Promise.all(workers.map((worker) => worker.start())).then(() => undefined);
  return {
    workers,
    finished,
    stop: () => {
      for (const worker of workers) worker.stop();
    },
  };
}
