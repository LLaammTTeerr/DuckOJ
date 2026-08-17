import type { JudgeDriver } from '@qhhoj/judge-protocol';
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
      const claimed = await this.jobs.claim(this.workerId);
      if (!claimed) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        continue;
      }

      this.current = claimed;
      this.heartbeatTimer = setInterval(() => {
        void this.heartbeatOnce();
      }, HEARTBEAT_MS);
      let watchdog: NodeJS.Timeout | null = null;

      try {
        await new Promise<void>((resolve, reject) => {
          watchdog = setTimeout(() => {
            reject(
              new Error(
                `grading exceeded ${this.maxGradingMs}ms for job ${claimed.id} attempt ${claimed.attempt}`,
              ),
            );
          }, this.maxGradingMs);

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
                const current = await this.writer.apply(claimed, event);
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
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        if (watchdog) clearTimeout(watchdog);
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        this.current = null;
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
