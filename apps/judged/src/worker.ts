import type { JudgeDriver } from '@qhhoj/judge-protocol';
import type { EventWriter } from './event-writer.js';
import type { ClaimedJob, JobStore } from './job-store.js';

export const HEARTBEAT_MS = 20_000;
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

      try {
        await new Promise<void>((resolve, reject) => {
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
