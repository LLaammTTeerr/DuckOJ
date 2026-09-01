import type { Verdict } from './verdict.js';

export interface GradingLimits {
  timeMs: number;
  memoryKb: number;
}

export interface GradingJob {
  id: string;
  /** Fencing token. Events carrying a stale attempt are rejected, not merged. */
  attempt: number;
  kind: 'submission';
  /** Content-addressed. The driver — not the contract — knows about problem codes. */
  packageHash: string;
  revisionId: string;
  language: string;
  source: string;
  limits: GradingLimits;
}

export type GradingEvent =
  /**
   * `node` names the judge the job actually went to — the `judge_nodes.name`
   * the bridge connection authenticated as. Optional, and absent means "this
   * driver does not know", which is the honest answer for every in-process
   * double: the alternative, inventing a name, would write a join row
   * claiming a judge graded something it never saw.
   */
  | { type: 'dispatched'; node?: string }
  | { type: 'compiling' }
  | { type: 'compileError'; message: string }
  | { type: 'compileMessage'; message: string }
  | {
      type: 'caseResult';
      groupIndex: number;
      caseIndex: number;
      verdict: Verdict | null;
      skipped: boolean;
      flags: string[];
      timeMs: number;
      memoryKb: number;
      points: number;
      maxPoints: number;
      feedback: string;
    }
  | {
      type: 'finished';
      verdict: Verdict;
      points: number;
      maxPoints: number;
      timeMs: number;
      memoryKb: number;
    }
  | { type: 'internalError'; message: string }
  | { type: 'terminated' };

export type EmitEvent = (event: GradingEvent) => Promise<void>;

/**
 * Tells the caller that the driver has **given up** on a job it accepted:
 * the judge running it vanished, and no verdict is coming.
 *
 * This is not a `GradingEvent`, and deliberately so. Every event in that
 * union is something to write down about the submission, and there is
 * nothing to write down here — an `internalError` or `terminated` would put
 * a permanent IE on a student's submission whose only misfortune was being
 * on the judge that restarted. An abandoned attempt is a *retry*, not a
 * result.
 *
 * It exists because `dispatch()` resolves when the request has been written
 * to the judge, not when grading ends: by the time a judge dies mid-grade
 * the dispatch promise settled minutes ago, so there is no promise left to
 * reject and the caller is parked on a terminal event that will never
 * arrive. Without this channel the only thing that ever settled that wait
 * was the caller's own grading ceiling — 300 s at the floor, up to 30
 * minutes for a large dataset — with the lease lapse still to come after it.
 *
 * Called at most once per dispatch, and never after a terminal event.
 */
export type AbandonJob = (reason: string) => void;

/**
 * `dispatch` rejected because no connected judge can run this job's language
 * at all — as distinct from "every judge that can is busy", which waits.
 *
 * Part of the contract rather than of one driver, because the caller's
 * response is different in kind: waiting is normal and ends when a judge
 * frees up, whereas this ends only when a *different* judge connects, which
 * may be never. A caller should hand the lease straight back and leave the
 * job queued (see `grading_jobs.blocked_reason`, D68) instead of holding it
 * for the lease window over a fact it already has.
 *
 * A caller that does not know this class still behaves correctly — it is an
 * `Error` like any other dispatch rejection, and the only cost is a minute
 * of lease.
 */
export class NoCapableJudgeError extends Error {
  constructor(
    readonly language: string,
    readonly jobId: string,
  ) {
    super(`no connected judge supports language ${language} (job ${jobId})`);
    this.name = 'NoCapableJudgeError';
  }
}

export interface DriverCapabilities {
  languages: string[];
  concurrency: number;
}

export interface JudgeDriver {
  start(): Promise<void>;
  capabilities(): DriverCapabilities;
  /**
   * Hands a job to the fleet. Resolves once the job has been **accepted**
   * (for `DmojDriver`, once the request is on the wire) — NOT when grading
   * finishes, which is reported through `emit`.
   *
   * `abandon` is how the driver reports the third outcome, the one this
   * signature had no room for: neither "accepted" nor "a verdict", but
   * "the judge holding this is gone". Optional so a caller that has no
   * recovery to do may omit it; a driver that cannot detect the condition
   * simply never calls it.
   */
  dispatch(job: GradingJob, emit: EmitEvent, abandon?: AbandonJob): Promise<void>;
  cancel(jobId: string, attempt: number): Promise<void>;
  stop(): Promise<void>;
  /**
   * Back-pressure. Reserves one execution slot on the judge fleet and returns
   * the function that gives it back, or null when the fleet is saturated.
   *
   * A claim loop calls this BEFORE it claims, and releases only once the job
   * is finished — so `judged` never leases more jobs than the judges can
   * actually run. Without it, surplus jobs sit leased-but-unrunnable until
   * their own grading watchdog fires, and that watchdog's `cancel` is exactly
   * what a driver may be unable to target safely (see `DmojDriver.cancel`).
   *
   * Synchronous on purpose: with no preemption between the check and the
   * reservation, two loops cannot both take the last slot.
   *
   * Optional. A driver that omits it is treated as unlimited, which is what
   * every in-process test double wants.
   */
  tryAcquireSlot?(): (() => void) | null;
  /**
   * The language keys the fleet can grade **right now** — the union over
   * every connected judge, not a static declaration.
   *
   * A claim loop passes this to `JobStore.claim` so a job no connected judge
   * can run is never claimed in the first place. That ordering is the whole
   * point: claiming such a job and then refusing to dispatch it would leave
   * the oldest-first queue permanently stuck on it, since the same loop
   * would re-claim the same row on the next turn forever (D68).
   *
   * Optional, like `tryAcquireSlot`, and for the same reason: a driver that
   * omits it is treated as able to run anything, which is what every
   * in-process test double wants. An empty array is NOT the same as
   * omitting — it means "connected judges exist that can run nothing", and
   * a caller must claim nothing.
   */
  supportedLanguages?(): string[];
  /**
   * Re-reads whatever the driver uses to translate a judge's announced
   * capabilities into our language keys, so a language added to the database
   * while this process runs becomes reachable **without a restart** (D173).
   * Resolves `true` when that translation actually changed.
   *
   * A claim loop calls it on the same throttle as its `blocked_reason`
   * reconciliation — i.e. only while claims are coming back empty, which is
   * exactly the state a newly-added language would be stuck behind, and
   * never while the fleet is busy.
   *
   * Optional: a driver that omits it declares a translation that cannot go
   * stale, which is what every in-process test double is. It must never
   * reject on a transient failure it can absorb — a caller treats a
   * rejection as "the fleet's languages are what they were".
   */
  refreshCapabilities?(): Promise<boolean>;
}
