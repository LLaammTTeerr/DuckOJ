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
}
