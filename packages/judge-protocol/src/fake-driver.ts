import type { DriverCapabilities, EmitEvent, GradingEvent, GradingJob, JudgeDriver } from './contract.js';

/**
 * An in-process JudgeDriver used by tests.
 *
 * Its real purpose is architectural: an abstraction with one implementation is
 * a guess. Having a second implementation from day one is what keeps
 * `JudgeDriver` honest about which concepts belong to the contract and which
 * belong to DMOJ.
 */
export class FakeDriver implements JudgeDriver {
  private readonly scripted = new Map<string, GradingEvent[]>();
  private readonly live = new Map<string, { attempt: number; emit: EmitEvent }>();

  script(jobId: string, events: GradingEvent[]): void {
    this.scripted.set(jobId, events);
  }

  async start(): Promise<void> {}

  capabilities(): DriverCapabilities {
    return { languages: ['cpp17'], concurrency: 1 };
  }

  async dispatch(job: GradingJob, emit: EmitEvent): Promise<void> {
    this.live.set(job.id, { attempt: job.attempt, emit });
    await emit({ type: 'dispatched' });
    for (const event of this.scripted.get(job.id) ?? []) {
      await emit(event);
    }
  }

  async cancel(jobId: string, attempt: number): Promise<void> {
    const entry = this.live.get(jobId);
    // Fencing applies to cancellation too: a cancel for a superseded attempt
    // must not terminate the attempt that replaced it.
    if (!entry || entry.attempt !== attempt) return;
    this.live.delete(jobId);
    await entry.emit({ type: 'terminated' });
  }

  async stop(): Promise<void> {
    this.live.clear();
  }
}
