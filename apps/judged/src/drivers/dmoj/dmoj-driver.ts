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
import type { BridgeServer, JudgeConnection } from './bridge-server.js';

interface LiveJob {
  job: GradingJob;
  emit: EmitEvent;
  /**
   * The judge connection this submission is on, or undefined while it is
   * still queued behind a busy judge. `cancel` reads this to decide whether
   * there is anything to terminate, and where to send it.
   */
  connection: string | undefined;
  /**
   * Set by `cancel` for a job that never reached a judge, so a `dispatch`
   * parked in `acquireConnection` gives up instead of grabbing the next free
   * connection for a job nobody is waiting on any more.
   */
  cancelled: boolean;
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

/** What a judge connection is doing, as far as this process can tell. */
interface Assignment {
  submissionId: number;
  /**
   * True once the `submission-request` has actually been written to that
   * socket (or the judge has told us it is grading it). Only a `sent`
   * assignment may be terminated: `terminate-submission` carries no
   * submission id, so firing one at a judge that never received the request
   * would terminate whatever it picks up next.
   */
  sent: boolean;
}

export class DmojDriver implements JudgeDriver {
  private readonly live = new Map<number, LiveJob>();
  /**
   * Judge connection id -> the submission that connection is grading.
   *
   * This map is the whole of the B2 fix. A DMOJ judge holds ONE submission at
   * a time (judge-server keeps a single `current_submission` and answers
   * `current-submission-id` with it), and `terminate-submission` names no
   * submission — so the only safe way to cancel is to know which socket is
   * running which grade and write to that socket alone.
   *
   * It is maintained from both ends: we record what we send, and every reply
   * packet carrying a `submission-id` confirms (or corrects) it from the
   * wire. A judge that redials clears its own entry at handshake.
   */
  private readonly assignments = new Map<string, Assignment>();
  /** Dispatches parked until some connection frees up. */
  private readonly waiting: Array<() => void> = [];
  /** Judge slots reserved by `tryAcquireSlot` but not necessarily dispatched yet. */
  private slotsHeld = 0;

  constructor(
    private readonly bridge: BridgeServer,
    private readonly agent: AgentClient,
  ) {
    this.bridge.onPacket((connection, packet) => this.handle(connection, packet));
  }

  async start(): Promise<void> {}

  capabilities(): DriverCapabilities {
    // One grade per connection, so the fleet's ceiling is the number of
    // connected judges — 0 when none is connected, which is honest: nothing
    // can run. `idleCapacity()` is the live, moment-to-moment version.
    return { languages: ['cpp17'], concurrency: this.bridge.judgeCount() };
  }

  /**
   * How many more jobs this driver can take on right now.
   *
   * Reservations, not assignments, are what is counted: a worker holds a slot
   * from before it claims until after it completes, so a slot already spent
   * on a dispatch is not free again merely because the request has been
   * written.
   */
  idleCapacity(): number {
    return Math.max(0, this.bridge.judgeCount() - this.slotsHeld);
  }

  /**
   * Back-pressure for `startWorkerPool`: reserves one judge execution slot,
   * or returns null when every judge is spoken for. Synchronous on purpose —
   * with no preemption between the check and the increment, two claim loops
   * cannot both take the last slot.
   *
   * Without this the pool claims more jobs than the judge fleet can run, and
   * the surplus sits leased-but-unrunnable until its own grading watchdog
   * fires — which is precisely the cancel that B2 turned into a stray
   * terminate.
   */
  tryAcquireSlot(): (() => void) | null {
    if (this.slotsHeld >= this.bridge.judgeCount()) return null;
    this.slotsHeld += 1;
    let released = false;
    return () => {
      // Idempotent: the worker's `finally` may run more than once across a
      // retry path, and a double release would invent capacity.
      if (released) return;
      released = true;
      this.slotsHeld -= 1;
      this.wake();
    };
  }

  /** Wakes every parked dispatch; each re-checks for a free connection in turn. */
  private wake(): void {
    while (this.waiting.length > 0) this.waiting.shift()!();
  }

  /**
   * Parks until some connection has no submission on it, then takes it.
   *
   * The take is synchronous with the check, so two woken dispatches cannot
   * claim the same connection: the first sets `assignments` before the second
   * resumes, and the second falls back into the queue.
   */
  private async acquireConnection(entry: LiveJob, submissionId: number): Promise<string> {
    for (;;) {
      if (entry.cancelled) {
        throw new Error(`submission ${submissionId} was cancelled before any judge took it`);
      }
      const free = this.bridge.connectionIds().find((id) => !this.assignments.has(id));
      if (free !== undefined) {
        this.assignments.set(free, { submissionId, sent: false });
        entry.connection = free;
        return free;
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
  }

  /**
   * Frees `connectionId`, but only if it still holds `submissionId` — a
   * blind delete would hand away a connection that has since been given to
   * somebody else's grade.
   */
  private releaseConnection(connectionId: string, submissionId: number): void {
    if (this.assignments.get(connectionId)?.submissionId !== submissionId) return;
    this.assignments.delete(connectionId);
    const entry = this.live.get(submissionId);
    if (entry && entry.connection === connectionId) entry.connection = undefined;
    this.wake();
  }

  /** Retires a live job and whatever connection it held. */
  private finish(entry: LiveJob): void {
    const submissionId = Number(entry.job.id);
    this.live.delete(submissionId);
    if (entry.connection !== undefined) this.releaseConnection(entry.connection, submissionId);
  }

  /**
   * Note on identity: DMOJ's `submission-id` field carries our **grading job
   * id**, not our submission id. The job is the unit of grading, and every
   * reply packet echoes this value back so we can find the live entry.
   *
   * A retry reuses the same job id with a higher attempt, so `live` keyed by
   * job id alone still cannot tell attempt N's late packets from attempt
   * N+1's. `cancel` now terminates attempt N on its own connection before the
   * retry can dispatch, and that connection is not handed out again until the
   * judge answers — which narrows the window hard, but is still an argument
   * from timing, not a proof. Keying `live` by (job, attempt) remains the
   * structural fix and is still outstanding.
   *
   * A dispatch does NOT go on the wire until some judge connection is idle: a
   * DMOJ judge grades one submission per connection, and a second
   * `submission-request` to a busy judge is either dropped or queued behind
   * the first with no way for us to tell which. Callers are expected to hold
   * a `tryAcquireSlot` reservation, in which case a connection is already
   * free and this never actually parks.
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

    const entry: LiveJob = {
      job,
      emit,
      connection: undefined,
      cancelled: false,
      batch: 0,
      loosePoints: 0,
      looseTotal: 0,
      batchAgg: new Map(),
      worstFlags: 0,
      ranAnyCase: false,

      timeMs: 0,
      memoryKb: 0,
      queue: Promise.resolve(),
    };
    // Registered before the wait, not after: `cancel` has to be able to find
    // a job that is still queued behind a busy judge — that is the whole B2
    // scenario — and tell it to give up.
    this.live.set(submissionId, entry);

    let connectionId: string;
    try {
      connectionId = await this.acquireConnection(entry, submissionId);
    } catch (error) {
      this.live.delete(submissionId);
      // Rejecting, never resolving: `Worker` settles its wrapper promise on a
      // terminal event or on a rejected dispatch, so a dispatch that returned
      // quietly here would leave the claim loop hanging on a job that will
      // never produce an event.
      throw error;
    }

    try {
      // Emitted before the request goes out: a judge that replies fast enough
      // could otherwise queue `grading-begin` -> `compiling` ahead of
      // `dispatched`, putting the lifecycle out of order for the caller. This
      // also means a failed emit never leaves an already-sent request
      // orphaned at the judge.
      await emit({ type: 'dispatched' });
      if (entry.cancelled) {
        throw new Error(`submission ${submissionId} was cancelled before any judge took it`);
      }

      const delivered = this.bridge.sendTo(connectionId, {
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
      if (!delivered) {
        throw new Error(
          `judge ${connectionId} disconnected before submission ${submissionId} was sent`,
        );
      }
      // Only now may this submission be terminated on this connection.
      const assignment = this.assignments.get(connectionId);
      if (assignment?.submissionId === submissionId) assignment.sent = true;
    } catch (error) {
      // Nothing (or nothing complete) reached the judge, so hand the
      // connection straight back rather than leaving it marked busy forever.
      this.releaseConnection(connectionId, submissionId);
      this.live.delete(submissionId);
      throw error;
    }
  }

  /**
   * B2. `terminate-submission` carries no submission id
   * (`packages/judge-protocol/src/dmoj-packets.ts`), so it terminates whatever
   * the connection it lands on is running. Broadcasting one — which is what
   * this used to do — kills every judge's current grade, and with two claim
   * loops against one judge that grade belongs to a different student: a
   * permanent `errored`/`IE`, no requeue, nothing to appeal.
   *
   * So a terminate goes to exactly one connection, and only when that
   * connection is provably running THIS submission. Anything else — a job
   * still queued behind a busy judge, a job whose judge vanished, a job the
   * judge already finished — cancels nothing, and says so in the log.
   */
  async cancel(jobId: string, attempt: number): Promise<void> {
    const submissionId = Number(jobId);
    const entry = this.live.get(submissionId);
    // Fencing: a cancel for a superseded attempt must not stop its successor.
    if (!entry || entry.job.attempt !== attempt) return;

    const connectionId = entry.connection;
    const assignment = connectionId === undefined ? undefined : this.assignments.get(connectionId);
    if (
      connectionId !== undefined &&
      assignment?.submissionId === submissionId &&
      assignment.sent &&
      this.bridge.sendTo(connectionId, { name: 'terminate-submission' })
    ) {
      // The live entry stays: the judge answers `submission-terminated`, and
      // that packet is what turns this into a `terminated` event and frees
      // the connection.
      return;
    }

    // Not on any judge. Retire it locally and let a parked dispatch move on.
    // No `terminated` event is emitted, because nothing was terminated —
    // emitting one would write a permanent errored/IE for a submission no
    // judge ever touched.
    console.warn(
      JSON.stringify({
        msg: 'cancel for a submission no judge is running',
        jobId,
        attempt,
        connection: connectionId ?? null,
      }),
    );
    entry.cancelled = true;
    this.finish(entry);
    this.wake();
  }

  async stop(): Promise<void> {
    await this.bridge.close();
  }

  private handle(connection: JudgeConnection, packet: JudgeToBridgePacket): void {
    if (packet.name === 'handshake') {
      // A judge that crashed mid-grade redials under the same `judge_nodes`
      // name, and BridgeServer reuses that id for the new socket. Whatever we
      // believed the old socket was grading died with it — without this the
      // stale assignment marks the fresh connection busy forever and, with
      // one judge, every later dispatch parks for good.
      const stale = this.assignments.get(connection.id);
      if (stale) this.releaseConnection(connection.id, stale.submissionId);
      // Also the point at which capacity appears for a first-time connection.
      this.wake();
      return;
    }
    if (packet.name === 'ping-response') return;

    // BridgeServer already records the announced set (from both this packet
    // and the handshake) against the connection, exposed via
    // `bridge.problemsFor()`. Dispatch picks a connection by idleness, not by
    // problem set, so the driver itself still has nothing to do with it.
    if (packet.name === 'supported-problems') return;

    if (packet.name === 'current-submission-id') {
      // A judge that restarted announces its in-flight work. If we hold no
      // live job for it, it is an orphan from a previous `judged` process and
      // would otherwise grade forever against nobody.
      //
      // Targeted, never broadcast: an id-less terminate sent to the OTHER
      // judges would kill their real, live grades to clean up this one's
      // orphan.
      if (!this.live.has(packet['submission-id'])) {
        this.bridge.sendTo(connection.id, { name: 'terminate-submission' });
        return;
      }
      this.assignments.set(connection.id, { submissionId: packet['submission-id'], sent: true });
      return;
    }

    const submissionId = (packet as { 'submission-id'?: number })['submission-id'];
    if (submissionId === undefined) return;
    const entry = this.live.get(submissionId);
    if (!entry) return;

    // The wire is the authority on which connection is grading what: this
    // corrects our bookkeeping after a reconnect, and confirms it otherwise.
    // Guarded so a late packet for an already-retired submission cannot steal
    // a connection that has since been given to somebody else's grade.
    const held = this.assignments.get(connection.id);
    if (!held || held.submissionId === submissionId) {
      this.assignments.set(connection.id, { submissionId, sent: true });
      entry.connection = connection.id;
    }

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
        this.finish(entry);
        return entry.emit({ type: 'compileError', message: packet.log });

      case 'compile-message':
        return entry.emit({ type: 'compileMessage', message: packet.log });

      case 'internal-error':
        this.finish(entry);
        return entry.emit({ type: 'internalError', message: packet.message });

      case 'submission-terminated':
        this.finish(entry);
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
        // `finish`, not a bare delete: the judge is free again the moment it
        // says so, and a dispatch parked on this connection must be woken.
        this.finish(entry);
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
