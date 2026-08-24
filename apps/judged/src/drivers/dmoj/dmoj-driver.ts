import {
  DMOJ_FLAG,
  interpretFlags,
  type DriverCapabilities,
  type EmitEvent,
  type GradingJob,
  type JudgeDriver,
  type JudgeToBridgePacket,
} from '@duckoj/judge-protocol';
import { describeError } from '@duckoj/observability';
import type { AgentClient } from './agent-client.js';
import type { BridgeServer } from './bridge-server.js';

interface LiveJob {
  job: GradingJob;
  emit: EmitEvent;
  /** Current batch number, advanced on batch-begin; reported to the caller as groupIndex. */
  batch: number;
  worstFlags: number;
  /** Whether any case actually executed. An all-skipped run has no determinable verdict. */
  ranAnyCase: boolean;
  /**
   * Batch-aware accumulation, mirroring `aggregateCases` in
   * `@duckoj/contest-formats` (which itself mirrors DMOJ's bridge): loose
   * cases SUM; a batch contributes `min(points)` / `max(total)` over its
   * members ONCE. The old running sums added every batched case's inherited
   * batch total, inflating a k-case batch worth P to k*P — and awarding
   * (k-1)*P to a batch with one failing case that must score 0.
   */
  loosePoints: number;
  looseTotal: number;
  batchAgg: Map<number, { points: number; total: number }>;
  timeMs: number;
  memoryKb: number;
  /**
   * Serialises packet translation for this job.
   *
   * `handle()` runs inside the decoder's synchronous callback and cannot
   * await, while `translate()` awaits `emit()` once per test case. Without
   * this chain, a `grading-end` coalesced into the same TCP chunk as a
   * `test-case-status` is processed while the case loop is still suspended,
   * and the final verdict is computed from a partially-accumulated mask.
   */
  queue: Promise<void>;
}

export class DmojDriver implements JudgeDriver {
  private readonly live = new Map<number, LiveJob>();

  constructor(
    private readonly bridge: BridgeServer,
    private readonly agent: AgentClient,
  ) {
    this.bridge.onPacket((_connection, packet) => this.handle(packet));
  }

  async start(): Promise<void> {}

  capabilities(): DriverCapabilities {
    return { languages: ['cpp17'], concurrency: 1 };
  }

  /**
   * Note on identity: DMOJ's `submission-id` field carries our **grading job
   * id**, not our submission id. The job is the unit of grading, and every
   * reply packet echoes this value back so we can find the live entry.
   *
   * A retry reuses the same job id with a higher attempt. `cancel` sends
   * `terminate-submission` before the retry dispatches, which narrows the
   * window but does not structurally close it: `live` is still keyed by job
   * id alone, and the entry is deleted only on a terminal packet — which a
   * wedged judge may never send, and a wedged judge is exactly what the
   * watchdog exists for. So: watchdog fires -> terminate broadcast ->
   * heartbeats stop -> the lease lapses 40-60s later -> attempt N+1
   * overwrites `live[job]` -> an attempt-N packet arriving after that point
   * finds N+1's entry, accumulates into N+1's mask, and passes fencing
   * because it is emitted through N+1's closure. This requires the judge to
   * be tens of seconds behind on its own socket, which with concurrency 1, a
   * single `judged`, and a sub-second terminate round-trip on a local
   * bridge is unlikely enough to defer past phase 1 — but it is a
   * probabilistic argument, not a proof. The real fix is to key `live` by
   * (job, attempt) instead of job id alone, planned for phase 4 when several
   * judges run concurrently and this stops being a corner case.
   */
  async dispatch(job: GradingJob, emit: EmitEvent): Promise<void> {
    const submissionId = Number(job.id);

    // Before anything else is touched: a judge dispatched to without its
    // package grades as a mystery internal error, not a clean failure. A
    // rejection here must leave no live entry (so a subsequent `cancel` is a
    // harmless no-op) and no `dispatched` event for a job that was never
    // actually sent — which is exactly what happens by rejecting before
    // `live.set` and `emit` below run at all.
    await this.agent.ensure(job.packageHash);

    this.live.set(submissionId, {
      job,
      emit,
      batch: 0,
      loosePoints: 0,
      looseTotal: 0,
      batchAgg: new Map(),
      worstFlags: 0,
      ranAnyCase: false,

      timeMs: 0,
      memoryKb: 0,
      queue: Promise.resolve(),
    });

    // Emitted before the broadcast: a judge that replies fast enough could
    // otherwise queue `grading-begin` -> `compiling` ahead of `dispatched`,
    // putting the lifecycle out of order for the caller. This also means a
    // failed emit never leaves an already-broadcast request orphaned at the
    // judge.
    await emit({ type: 'dispatched' });

    this.bridge.broadcast({
      name: 'submission-request',
      'submission-id': submissionId,
      // Packages materialise at /problems/<hash>/, and judge-server takes a
      // problem's id from the directory basename — so the id *is* the hash.
      // No lookup, no mapping, nothing to keep in sync with the store.
      'problem-id': job.packageHash,
      language: this.bridge.options.languageToExecutor(job.language),
      source: job.source,
      // judge-server takes seconds, we carry milliseconds.
      'time-limit': job.limits.timeMs / 1000,
      'memory-limit': job.limits.memoryKb,
      'short-circuit': false,
      meta: {},
    });
  }

  async cancel(jobId: string, attempt: number): Promise<void> {
    const entry = this.live.get(Number(jobId));
    // Fencing: a cancel for a superseded attempt must not stop its successor.
    if (!entry || entry.job.attempt !== attempt) return;
    this.bridge.broadcast({ name: 'terminate-submission' });
  }

  async stop(): Promise<void> {
    await this.bridge.close();
  }

  private handle(packet: JudgeToBridgePacket): void {
    if (packet.name === 'ping-response' || packet.name === 'handshake') return;

    // BridgeServer already records the announced set (from both this packet
    // and the handshake) against the connection, exposed via
    // `bridge.problemsFor()`. The driver itself has nothing to do with it —
    // concurrency is 1, so nothing schedules on it yet.
    if (packet.name === 'supported-problems') return;

    if (packet.name === 'current-submission-id') {
      // A judge that restarted announces its in-flight work. If we hold no
      // live job for it, it is an orphan from a previous `judged` process and
      // would otherwise grade forever against nobody.
      if (!this.live.has(packet['submission-id'])) {
        this.bridge.broadcast({ name: 'terminate-submission' });
      }
      return;
    }

    const submissionId = (packet as { 'submission-id'?: number })['submission-id'];
    if (submissionId === undefined) return;
    const entry = this.live.get(submissionId);
    if (!entry) return;

    // Queue rather than fire-and-forget: `entry` is looked up synchronously
    // here (before any earlier packet's translation may have run), so a
    // `grading-end` coalesced into the same chunk as a `test-case-status`
    // still finds its live entry — but the actual translation runs only
    // after every packet queued ahead of it has finished, in order.
    entry.queue = entry.queue
      .then(() => this.translate(entry, packet))
      .catch((error: unknown) => {
        // Keep the chain alive: one failed packet must not wedge every
        // subsequent packet for this job.
        console.error(
          JSON.stringify({ msg: 'translate failed', jobId: entry.job.id, error: describeError(error) }),
        );
      });
  }

  private async translate(entry: LiveJob, packet: JudgeToBridgePacket): Promise<void> {
    switch (packet.name) {
      case 'grading-begin':
        return entry.emit({ type: 'compiling' });

      case 'compile-error':
        this.live.delete(Number(entry.job.id));
        return entry.emit({ type: 'compileError', message: packet.log });

      case 'compile-message':
        return entry.emit({ type: 'compileMessage', message: packet.log });

      case 'internal-error':
        this.live.delete(Number(entry.job.id));
        return entry.emit({ type: 'internalError', message: packet.message });

      case 'submission-terminated':
        this.live.delete(Number(entry.job.id));
        return entry.emit({ type: 'terminated' });

      case 'batch-begin':
        entry.batch += 1;
        return;

      case 'test-case-status':
        for (const testCase of packet.cases) {
          const outcome = interpretFlags(testCase.status);
          // SC is stripped from the aggregate: interpretFlags checks SC first
          // and would report `null` (-> IE) for the whole submission the
          // moment any single case was skipped, even if another case failed
          // outright. Per-case reporting below is unaffected — it still sees
          // the raw status, so a skipped case still reports skipped: true.
          entry.worstFlags |= testCase.status & ~DMOJ_FLAG.SC;
          if (!outcome.skipped) entry.ranAnyCase = true;
          if (entry.batch === 0) {
            entry.loosePoints += testCase.points;
            entry.looseTotal += testCase['total-points'];
          } else {
            const agg = entry.batchAgg.get(entry.batch);
            if (agg === undefined) {
              entry.batchAgg.set(entry.batch, {
                points: testCase.points,
                total: testCase['total-points'],
              });
            } else {
              agg.points = Math.min(agg.points, testCase.points);
              agg.total = Math.max(agg.total, testCase['total-points']);
            }
          }
          entry.timeMs = Math.max(entry.timeMs, Math.round(testCase.time * 1000));
          entry.memoryKb = Math.max(entry.memoryKb, testCase.memory);
          await entry.emit({
            type: 'caseResult',
            groupIndex: entry.batch,
            // DMOJ numbers cases from 1 across the whole run; we report 0-based.
            caseIndex: testCase.position - 1,
            verdict: outcome.verdict,
            skipped: outcome.skipped,
            flags: outcome.flags,
            timeMs: Math.round(testCase.time * 1000),
            memoryKb: testCase.memory,
            points: testCase.points,
            maxPoints: testCase['total-points'],
            feedback: testCase.feedback || testCase['extended-feedback'],
          });
        }
        return;

      case 'grading-end': {
        this.live.delete(Number(entry.job.id));
        const overall = interpretFlags(entry.worstFlags);
        return entry.emit({
          type: 'finished',
          // `worstFlags` has the SC bit stripped, so a skipped case can no
          // longer decide the submission. A run where nothing executed has
          // no determinable verdict — report IE rather than AC, which mask 0
          // would otherwise yield.
          verdict: entry.ranAnyCase ? (overall.verdict ?? 'IE') : 'IE',
          points: submissionPoints(entry),
          maxPoints: submissionMaxPoints(entry),
          timeMs: entry.timeMs,
          memoryKb: entry.memoryKb,
        });
      }

      default:
        return;
    }
  }
}

/** Loose sum + per-batch min, the bridge's aggregation. */
function submissionPoints(entry: LiveJob): number {
  let points = entry.loosePoints;
  for (const agg of entry.batchAgg.values()) points += agg.points;
  return points;
}

function submissionMaxPoints(entry: LiveJob): number {
  let total = entry.looseTotal;
  for (const agg of entry.batchAgg.values()) total += agg.total;
  return total;
}
