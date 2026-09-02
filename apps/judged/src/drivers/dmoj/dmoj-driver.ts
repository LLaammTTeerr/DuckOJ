import {
  DMOJ_FLAG,
  interpretFlags,
  NoCapableJudgeError,
  type AbandonJob,
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
   * Told when the judge holding this job disappears. Optional because
   * `JudgeDriver.dispatch` makes it optional — a caller with no recovery to
   * do (every driver test that only reads events) simply passes nothing.
   */
  abandon: AbandonJob | undefined;
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
  /**
   * The batch a case currently belongs to, reported to the caller as
   * groupIndex — `0` means "outside any batch", i.e. a loose case.
   *
   * Set from `batchCount` on `batch-begin` and back to 0 on `batch-end`.
   * judge-server brackets every batch with that pair and yields loose cases
   * outside any pair (`dmoj/judge.py:479-533`), and a DMOJ `test_cases:` list
   * may legally interleave the two — so without honouring `batch-end` (which
   * `translate` used to swallow) every loose case AFTER a batch was filed
   * under that batch and folded into its min()/max() aggregate instead of
   * summing on its own.
   */
  batch: number;
  /**
   * How many batches have begun. Kept separate from `batch` on purpose: the
   * obvious one-counter version — reset to 0 on end, `+= 1` on begin — hands
   * the SECOND batch the index 1 again, merging two independent batches into
   * one aggregate. Monotonic here, so every batch keeps a distinct key.
   */
  batchCount: number;
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

/**
 * The packets after which a judge is free again — exactly the set for which
 * `translate` calls `finish`. Kept beside it because it must stay that set: a
 * name added to one and not the other either leaks a connection or hands one
 * away while it is still grading.
 */
const TERMINAL_PACKETS: ReadonlySet<string> = new Set([
  'grading-end',
  'submission-terminated',
  'compile-error',
  'internal-error',
]);

/**
 * The attempt recorded for a connection we know is BUSY but whose grade we
 * cannot name — the `current-submission-id` case where the announcement
 * contradicts a placement we built ourselves (D205, fix round 1).
 *
 * Negative on purpose: attempts start at 1 and only rise, so this can never
 * collide with a real one. That is the whole of its behaviour — the
 * connection is out of the free pool because it holds an assignment, every
 * packet on it is discarded as unattributable because the attempt matches
 * nothing, and a terminal packet releases it because the value still equals
 * itself.
 */
const UNKNOWN_ATTEMPT = -1;

/** What a judge connection is doing, as far as this process can tell. */
interface Assignment {
  submissionId: number;
  /**
   * Which ATTEMPT of that job id this connection is running (D205).
   *
   * The submission id alone is not an identity: DMOJ's `submission-id` is our
   * grading JOB id and a retry reuses it with a higher attempt, so with only
   * the id recorded here, a connection still running attempt N is
   * indistinguishable from the one running attempt N+1 — and every packet
   * from the former is routed into the latter's event stream.
   */
  attempt: number;
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
    this.bridge.onDisconnect((id) => this.onJudgeGone(id));
  }

  /**
   * A judge connection went away. Whatever it was grading is not coming
   * back: judge-server holds one `current_submission` per connection and
   * keeps no state across a reconnect, so there is nothing to resume and
   * nobody left to terminate.
   *
   * The job is retired locally and its caller told through `abandon`, which
   * is the whole point — the caller's `dispatch` promise resolved when the
   * request went on the wire, so without this the wait for a terminal event
   * ends only at the grading ceiling (300 s at the floor, 30 minutes at the
   * cap), with the lease lapse still to come after that.
   *
   * No `GradingEvent` is emitted, deliberately. `internalError` or
   * `terminated` here would write a permanent IE onto a submission whose
   * only misfortune was being on the judge that restarted — B2's failure
   * shape, arrived at from the other direction.
   */
  private onJudgeGone(connectionId: string): void {
    const assignment = this.assignments.get(connectionId);
    if (!assignment) {
      // An idle judge leaving frees no job, but it does change capacity, and
      // a dispatch parked in `acquireConnection` must re-check rather than
      // sleep on a connection list that has moved under it.
      this.wake();
      return;
    }
    const submissionId = assignment.submissionId;
    // Frees the connection AND wakes parked dispatches.
    this.releaseConnection(connectionId, submissionId, assignment.attempt);
    const entry = this.live.get(submissionId);
    // Attempt-fenced (D205): a judge that dies still holding a SUPERSEDED
    // attempt of job S must not retire and abandon the successor now running
    // on a different judge — that would requeue a healthy grade on the
    // strength of an unrelated machine's death.
    if (!entry || entry.job.attempt !== assignment.attempt) return;
    // `entry` came straight out of `live`, so identity is trivially true
    // here; through `retire` regardless, so that every removal from `live` in
    // this file reads the same way and none of them can drift back to a
    // delete by bare job id.
    this.retire(entry, submissionId);
    console.warn(
      JSON.stringify({
        msg: 'judge disconnected while grading',
        judge: connectionId,
        jobId: entry.job.id,
        attempt: entry.job.attempt,
      }),
    );
    entry.abandon?.(
      `judge ${connectionId} disconnected while grading job ${entry.job.id} attempt ${String(entry.job.attempt)}`,
    );
  }

  async start(): Promise<void> {}

  capabilities(): DriverCapabilities {
    // One grade per connection, so the fleet's ceiling is the number of
    // connected judges — 0 when none is connected, which is honest: nothing
    // can run. `idleCapacity()` is the live, moment-to-moment version.
    //
    // `languages` was the hardcoded `['cpp17']` and was therefore a lie the
    // moment a second, differently-configured judge joined — it described
    // the deployment rather than the fleet. It is now the union of what the
    // connected judges actually announced (D68).
    return { languages: this.supportedLanguages(), concurrency: this.bridge.judgeCount() };
  }

  /**
   * `JudgeDriver.supportedLanguages`: what the connected fleet can grade
   * right now. The claim loop passes this to `JobStore.claim`, so a job in a
   * language nobody speaks is never claimed — it stays `queued` and visible
   * instead of being leased by a worker that cannot run it (D68).
   */
  supportedLanguages(): string[] {
    return this.bridge.supportedLanguages();
  }

  /**
   * `JudgeDriver.refreshCapabilities`: re-read `language_driver_keys`, so a
   * language seeded while this process runs becomes gradeable without a
   * restart (D173).
   *
   * The bridge already refreshes on handshake, and that is not enough on its
   * own: a migration run against a live stack — `FORCE_MIGRATE=1` on
   * 2026-09-01 — changes the rows with no judge reconnecting, and D171's
   * sanctioned ordering deploys the judge *before* the migration, so in the
   * blessed flow the handshake always precedes the rows. The claim loop is
   * the trigger that covers both.
   */
  refreshCapabilities(): Promise<boolean> {
    return this.bridge.refreshLanguages();
  }

  /** The connections that could run `language`, connected right now, busy or not. */
  private capableConnections(language: string): string[] {
    const executor = this.bridge.options.languageToExecutor(language);
    return this.bridge.connectionIds().filter((id) => this.bridge.executorsFor(id).has(executor));
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
   * Parks until some connection that can run this job's language has no
   * submission on it, then takes it.
   *
   * The take is synchronous with the check, so two woken dispatches cannot
   * claim the same connection: the first sets `assignments` before the second
   * resumes, and the second falls back into the queue.
   *
   * Capability is re-checked on every turn of the loop, not once on entry:
   * the only judge that could run this language may disconnect while this
   * dispatch is parked behind it, and parking on a connection that will never
   * come back is exactly the silent hang the grading ceiling was left to
   * clean up. A connected fleet with no capable member therefore throws
   * `NoCapableJudgeError` — including after a wake (D68).
   */
  private async acquireConnection(entry: LiveJob, submissionId: number): Promise<string> {
    for (;;) {
      if (entry.cancelled) {
        throw new Error(`submission ${submissionId} was cancelled before any judge took it`);
      }
      const capable = this.capableConnections(entry.job.language);
      // Judges are connected and not one of them can run this: a capability
      // gap, which waiting cannot close — only a differently-configured judge
      // can, and that may never arrive.
      //
      // The `judgeCount() > 0` guard is what keeps that distinct from an
      // EMPTY fleet, which is transient by nature: a judge restarting leaves
      // the bridge with no connections for a second or two, and a dispatch
      // that gave up there would fail every job in flight across a routine
      // `podman restart judge` — including the reconnect path
      // `judge-affinity.spec.ts` pins. An empty fleet parks, exactly as it
      // did before D68, and the callers that must not park are held off by
      // `tryAcquireSlot`, which hands out no slot when no judge is connected.
      if (capable.length === 0 && this.bridge.judgeCount() > 0) {
        throw new NoCapableJudgeError(entry.job.language, entry.job.id);
      }
      const free = capable.find((id) => !this.assignments.has(id));
      if (free !== undefined) {
        this.assignments.set(free, { submissionId, attempt: entry.job.attempt, sent: false });
        entry.connection = free;
        return free;
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
  }

  /**
   * Frees `connectionId`, but only if it still holds this exact
   * `(submissionId, attempt)` — a blind delete would hand away a connection
   * that has since been given to somebody else's grade.
   *
   * The attempt is part of that check for the same reason it is part of
   * `Assignment` at all (D205): with a retry reusing the job id, "still holds
   * submission S" is true of BOTH the connection running the superseded
   * attempt and the one running its successor, so a release meant for the
   * former would free the latter and let a third job be dispatched on top of
   * a live grade.
   */
  private releaseConnection(connectionId: string, submissionId: number, attempt: number): void {
    const held = this.assignments.get(connectionId);
    if (held?.submissionId !== submissionId || held.attempt !== attempt) return;
    this.assignments.delete(connectionId);
    const entry = this.live.get(submissionId);
    // Same fencing on the live entry: unpinning `connection` here when the
    // live entry is a LATER attempt would tell `cancel` there is nothing to
    // terminate for a job that is very much still running.
    //
    // This lookup is by id where `retire` below is by identity, and the pair
    // of conditions is why it can be: an entry that matches BOTH this attempt
    // and this connection is this attempt's entry. Two entry objects for one
    // `(job, attempt)` cannot coexist — `JobStore.claim` bumps the attempt on
    // every claim, and the one path that builds an entry it then throws away
    // (`dispatch`'s catch) retires its own before rethrowing.
    if (entry && entry.job.attempt === attempt && entry.connection === connectionId) {
      entry.connection = undefined;
    }
    this.wake();
  }

  /**
   * Drops `entry` from `live` — but only if `live` still holds THIS entry.
   *
   * Identity, not job id (D205, fix round 1). A packet is queued onto its
   * entry's `queue` while that entry is the live one, and the queue drains
   * later, after an `emit` per test case has been awaited. By then a retry
   * may have replaced `live[jobId]` with its own entry, and a delete by id
   * would evict the SUCCESSOR: every later packet for that job then finds no
   * live entry at all, so the successor never receives a terminal event and
   * the judge running it is never handed back. On the one-judge fleet this
   * repository ships, that is the whole queue stopped.
   *
   * The window is not exotic. `Worker.heartbeatOnce` cancels only once it has
   * learned its lease was already claimed away, so the successor is dispatched
   * BEFORE the predecessor is cancelled, and the predecessor's packets are
   * still perfectly legitimate when they are queued.
   */
  private retire(entry: LiveJob, submissionId: number): void {
    if (this.live.get(submissionId) === entry) this.live.delete(submissionId);
  }

  /** Retires a live job and whatever connection it held. */
  private finish(entry: LiveJob): void {
    const submissionId = Number(entry.job.id);
    this.retire(entry, submissionId);
    if (entry.connection !== undefined) {
      this.releaseConnection(entry.connection, submissionId, entry.job.attempt);
    }
  }

  /**
   * Note on identity: DMOJ's `submission-id` field carries our **grading job
   * id**, not our submission id. The job is the unit of grading, and every
   * reply packet echoes this value back so we can find the live entry.
   *
   * A retry reuses the same job id with a higher attempt, so `live` keyed by
   * job id alone cannot tell attempt N's late packets from attempt N+1's.
   * D29 narrowed that window by terminating attempt N on its own connection
   * and not handing that connection out again until the judge answers, and
   * said in as many words that it was an argument from timing rather than a
   * proof. **D205 closed it for every connection whose assignment this driver
   * built from its own dispatch** — which is every connection in the normal
   * flow. `live` is still keyed by job id, because `cancel` and the
   * `current-submission-id` orphan check both look one up with no attempt in
   * hand; the attempt lives on `Assignment` instead, and the driver routes on
   * it.
   *
   * What is NOT closed, and cannot be from this side of the wire: a judge
   * announcing `current-submission-id` names a job id and no attempt, so the
   * attempt recorded for a reconnecting judge is an inference from the only
   * live entry that id resolves to. Right in every flow we can construct,
   * never provable. D205 says so, and says what it costs.
   *
   * A dispatch does NOT go on the wire until some judge connection is idle: a
   * DMOJ judge grades one submission per connection, and a second
   * `submission-request` to a busy judge is either dropped or queued behind
   * the first with no way for us to tell which. Callers are expected to hold
   * a `tryAcquireSlot` reservation, in which case a connection is already
   * free and this never actually parks.
   */
  async dispatch(job: GradingJob, emit: EmitEvent, abandon?: AbandonJob): Promise<void> {
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
      abandon,
      connection: undefined,
      cancelled: false,
      batch: 0,
      batchCount: 0,
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
      // By identity: this dispatch may have been parked for a long time, and
      // a later attempt of the same job may already own `live[submissionId]`.
      this.retire(entry, submissionId);
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
      // `node` names the connection, which IS the `judge_nodes.name` the
      // judge authenticated as — that is what makes `grading_jobs
      // .judge_node_id` a fact about which machine ran the code rather than
      // a guess (D68). Emitted here, before the request goes out, for the
      // same reason `dispatched` itself is: the write must not be able to
      // land after the judge's first reply.
      await emit({ type: 'dispatched', node: connectionId });
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
      if (assignment?.submissionId === submissionId && assignment.attempt === job.attempt) {
        assignment.sent = true;
      }
    } catch (error) {
      // Nothing (or nothing complete) reached the judge, so hand the
      // connection straight back rather than leaving it marked busy forever.
      this.releaseConnection(connectionId, submissionId, job.attempt);
      this.retire(entry, submissionId);
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
      // The connection must be running THIS attempt, not merely this job id
      // (D205): an id-less terminate aimed at the attempt-N connection while
      // this entry is attempt N+1 would kill the wrong run.
      assignment.attempt === attempt &&
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
      if (stale) this.releaseConnection(connection.id, stale.submissionId, stale.attempt);
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
      const announced = packet['submission-id'];
      const claimed = this.live.get(announced);
      if (!claimed) {
        this.bridge.sendTo(connection.id, { name: 'terminate-submission' });
        return;
      }
      // No attempt can be recovered here, and none ever will be: the packet
      // is `{ name, submission-id }` and nothing else
      // (`packages/judge-protocol/src/dmoj-packets.ts`), because judge-server
      // has no notion of our attempt counter — it echoes back the single
      // number we put in `submission-request`, which is the job id. So this
      // branch cannot tell "judge-1 is still chewing on attempt 1" from
      // "judge-1 is running the attempt 2 we dispatched".
      //
      // It therefore never overwrites a claim built from a dispatch we made:
      // that one knows its attempt, this one does not. Terminating instead
      // would be worse than doing nothing — the announcement may well BE the
      // live attempt, seen after a `judged` restart, and an id-less terminate
      // would kill it.
      if (this.assignments.has(connection.id)) return;

      // What it must NOT do is return here leaving the connection unassigned.
      // The judge has just told us it is grading. An unassigned connection is
      // in the free pool, and the next dispatch writes a second
      // `submission-request` to a judge already holding one — "either dropped
      // or queued behind the first with no way for us to tell which", the
      // hazard `dispatch`'s own comment names and D29 exists to prevent.
      //
      // So it is recorded busy either way, and only the attempt differs:
      //
      //  - The live entry is placed on some OTHER connection. The
      //    announcement contradicts a placement we built ourselves, so it is
      //    almost certainly a superseded attempt still running — and its
      //    attempt is exactly what cannot be recovered. `UNKNOWN_ATTEMPT`
      //    says so: busy, unattributable, released by its terminal packet.
      //  - Otherwise the live entry is unplaced (a redial cleared it, or the
      //    job is a restart's re-claim). This is the reconnect-recovery path
      //    D29 relies on, and adopting the live entry's own attempt is the
      //    best available reading of the only evidence there is. It is an
      //    INFERENCE, not a fact — see D205.
      const placedElsewhere =
        claimed.connection !== undefined && claimed.connection !== connection.id;
      this.assignments.set(connection.id, {
        submissionId: announced,
        attempt: placedElsewhere ? UNKNOWN_ATTEMPT : claimed.job.attempt,
        sent: true,
      });
      if (!placedElsewhere) claimed.connection = connection.id;
      return;
    }

    const submissionId = (packet as { 'submission-id'?: number })['submission-id'];
    if (submissionId === undefined) return;
    const entry = this.live.get(submissionId);
    if (!entry) return;

    const held = this.assignments.get(connection.id);

    // D205. The live entry is keyed by job id, and a retry reuses that id, so
    // `entry` may well be a LATER attempt than the one this connection is
    // running. Routing on the id alone hands attempt N's packets to attempt
    // N+1: a `grading-end` finalises a submission that is still compiling,
    // with a verdict computed from the previous run's cases, and a
    // `test-case-status` builds the subtask summary out of two runs mixed
    // together.
    //
    // Stated once: a packet belongs to `entry` only if it arrives on the
    // connection `entry` is placed on, or on a connection that is both
    // unassigned and not contradicted by a placement elsewhere. The second
    // disjunct below is what keeps the reconnect path working — a redial's
    // `retire`/handshake clears BOTH the assignment and `entry.connection`,
    // so a recovered judge's first packet is adopted, exactly as it was
    // before this guard existed.
    //
    // Written as an unconditional OR rather than "if assigned, compare
    // attempts, else compare placement" (fix round 1, F5). The two forms
    // agree in every state reachable today, but the branching one has a trap:
    // it lets a connection whose attempt happens to match take over an entry
    // already placed on another socket, which is the theft this whole guard
    // exists to stop.
    const foreign =
      (held !== undefined && held.attempt !== entry.job.attempt) ||
      (entry.connection !== undefined && entry.connection !== connection.id);
    if (foreign) {
      console.warn(
        JSON.stringify({
          msg: 'packet from a superseded attempt discarded',
          jobId: entry.job.id,
          // `null`, not the sentinel: this connection is known to be busy and
          // its attempt is genuinely unknown, which is not the same claim as
          // "attempt -1".
          packetAttempt:
            held === undefined || held.attempt === UNKNOWN_ATTEMPT ? null : held.attempt,
          liveAttempt: entry.job.attempt,
          connection: connection.id,
          placedOn: entry.connection ?? null,
        }),
      );
      // A terminal packet still frees the connection it arrived on, even
      // though its content is thrown away — and it frees it for all four
      // terminal names, not only `submission-terminated`.
      //
      // That set is not new behaviour, which is the point: before this guard,
      // every one of these four reached `translate` and called `finish`,
      // which released the connection. Dropping the TRANSLATION of a stale
      // packet is the change; dropping the BOOKKEEPING with it would be a
      // second, unasked-for one, and its failure mode is a connection marked
      // busy with a grade nobody is listening for. On the one-judge fleet
      // this repository ships that is the entire queue stopped, which is
      // strictly worse than the wrong verdict this guard removes.
      //
      // The hazard in releasing early — the successor lands on a socket that
      // still has an unconsumed id-less `terminate-submission` in flight —
      // does not survive contact with the socket. Both the terminate and the
      // successor's `submission-request` are written to the SAME connection,
      // and judge-server reads one stream in order, so the terminate is
      // always processed first. See D205 for what remains unverified.
      //
      // `entry.connection` is deliberately NOT touched: the live attempt is
      // somewhere else, and `releaseConnection` is fenced so it stays there.
      if (held !== undefined && TERMINAL_PACKETS.has(packet.name)) {
        this.releaseConnection(connection.id, submissionId, held.attempt);
      }
      return;
    }

    // The wire is the authority on which connection is grading what: this
    // corrects our bookkeeping after a reconnect, and confirms it otherwise.
    // Guarded so a late packet for an already-retired submission cannot steal
    // a connection that has since been given to somebody else's grade.
    if (!held || held.submissionId === submissionId) {
      this.assignments.set(connection.id, {
        submissionId,
        attempt: entry.job.attempt,
        sent: true,
      });
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
        return entry.emit({
          type: 'compileError',
          message: cleanCompileLog(packet.log, entry.job.packageHash),
        });

      case 'compile-message':
        return entry.emit({
          type: 'compileMessage',
          message: cleanCompileLog(packet.log, entry.job.packageHash),
        });

      case 'internal-error':
        this.finish(entry);
        return entry.emit({ type: 'internalError', message: packet.message });

      case 'submission-terminated':
        this.finish(entry);
        return entry.emit({ type: 'terminated' });

      case 'batch-begin':
        entry.batchCount += 1;
        entry.batch = entry.batchCount;
        return;

      case 'batch-end':
        entry.batch = 0;
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


/**
 * Everything in `ESC [ … <letter>` — gcc's SGR colours and its `ESC [K`.
 *
 * Built from the code point rather than written as a literal `\x1b` so the
 * pattern carries no control character of its own (`no-control-regex`).
 */
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*[A-Za-z]`, 'g');

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Makes a judge's compile log fit to hand to the person who submitted.
 *
 * `submission.access.ts` returns `compileOutput` verbatim and `submit.tsx`
 * renders it into a `<pre>`, so whatever arrives here is what a student reads.
 * Two things arrive that should not (both observed on the live stack, B3):
 *
 *  - **gcc's terminal colour escapes.** The judge compiles on a pipe but gcc
 *    is invoked with colour on, so every diagnostic is wrapped in `\x1b[01m`
 *    /`\x1b[K`/`\x1b[m`. In a browser those are control characters, not
 *    colour — the message reads as line noise.
 *  - **The package hash where the filename belongs.** `judged` sends the
 *    package hash as DMOJ's `problem-id` (see `dispatch`), and judge-server
 *    names the compile unit `{problem_id}.{ext}`
 *    (`dmoj/executors/base_executor.py:122`), so every diagnostic line is
 *    addressed to a 64-hex blob. It identifies the problem's TEST PACKAGE,
 *    which is not the submitter's business and is not a name that helps them.
 *
 * CRLF is normalised for the same reason: the log is rendered as text, not
 * fed to a terminal.
 */
export function cleanCompileLog(log: string, packageHash: string): string {
  const hash = escapeForRegex(packageHash);
  return log
    .replace(ANSI_ESCAPE, '')
    // `<hash>cpp.cpp` -> `solution.cpp`: the executor appends its own suffix
    // before the extension, so anything between the hash and the dot goes too.
    .replace(new RegExp(`${hash}[A-Za-z0-9_]*\\.([A-Za-z0-9]+)`, 'g'), 'solution.$1')
    // Any bare mention left over (a path, a linker line) still must not leak.
    .replace(new RegExp(hash, 'g'), 'solution')
    .replace(/\r\n/g, '\n');
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
