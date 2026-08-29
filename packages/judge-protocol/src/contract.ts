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
  | { type: 'dispatched' }
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

export interface DriverCapabilities {
  languages: string[];
  concurrency: number;
}

export interface JudgeDriver {
  start(): Promise<void>;
  capabilities(): DriverCapabilities;
  dispatch(job: GradingJob, emit: EmitEvent): Promise<void>;
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
}
