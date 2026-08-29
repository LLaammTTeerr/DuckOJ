import { describe, expect, it } from 'vitest';
import type { EmitEvent, GradingJob, JudgeDriver } from '@duckoj/judge-protocol';
import type { EventWriter } from '../src/event-writer.js';
import type { ClaimedJob, JobStore } from '../src/job-store.js';
import { startWorkerPool } from '../src/worker.js';

/**
 * The pool is the whole of `JUDGED_CONCURRENCY`: N independent claim loops
 * over the same JobStore, each of which is an unmodified `Worker`.
 *
 * The property that matters — and the one a single worker cannot satisfy —
 * is that N jobs are in flight *at the same time*. Counting jobs that were
 * eventually claimed would pass against one worker too (it claims them one
 * after another), so this test holds every dispatch open until it has seen N
 * of them, and only then releases. With concurrency 1 the second dispatch
 * never begins and the wait below times out, which is exactly the red this
 * test is here to produce.
 *
 * `claim()`'s real concurrency safety (`FOR UPDATE SKIP LOCKED`, and the
 * (job, attempt) fencing on heartbeat/complete) is already covered against a
 * real Postgres by `job-store.concurrency.spec.ts`. This file deliberately
 * fakes the store instead: the thing under test is the spawn code in
 * `startWorkerPool`, not the SQL.
 */

interface Claim {
  jobId: number;
  workerId: string;
}

/** A JobStore that hands out `count` jobs, one per `claim()`, then nothing. */
function fakeJobStore(count: number, claims: Claim[]): JobStore {
  let next = 0;
  const store = {
    claim: async (workerId: string): Promise<ClaimedJob | null> => {
      if (next >= count) return null;
      next += 1;
      claims.push({ jobId: next, workerId });
      return {
        id: next,
        attempt: 1,
        submissionId: null,
        revisionId: 1,
        packageHash: 'h',
        source: 'int main(){}',
        languageKey: 'cpp17',
        timeMs: 1000,
        memoryKb: 65_536,
        testCount: 1,
      };
    },
    heartbeat: async () => true,
    complete: async () => true,
    isCurrentAttempt: async () => true,
    reclaimExpired: async () => [],
  };
  return store as unknown as JobStore;
}

/** A driver whose dispatch blocks until `release()` is called. */
function blockingDriver(): { driver: JudgeDriver; inFlight: string[]; release: () => void } {
  const inFlight: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const driver: JudgeDriver = {
    start: async () => {},
    capabilities: () => ({ languages: ['cpp17'], concurrency: 2 }),
    dispatch: async (job: GradingJob, emit: EmitEvent) => {
      inFlight.push(job.id);
      await emit({ type: 'dispatched' });
      await gate;
      await emit({ type: 'finished', verdict: 'AC', points: 1, maxPoints: 1, timeMs: 1, memoryKb: 1 });
    },
    cancel: async () => {},
    stop: async () => {},
  };
  return { driver, inFlight, release };
}

/**
 * A driver with `capacity` judge execution slots, the shape `DmojDriver`
 * exposes once it tracks which connection is grading what. Dispatch blocks
 * until released, so a claim loop that ignored `tryAcquireSlot` would visibly
 * hold more jobs than there are slots.
 */
function saturatingDriver(capacity: number): {
  driver: JudgeDriver;
  inFlight: string[];
  release: () => void;
} {
  const inFlight: string[] = [];
  let held = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const driver: JudgeDriver = {
    start: async () => {},
    capabilities: () => ({ languages: ['cpp17'], concurrency: capacity }),
    tryAcquireSlot: () => {
      if (held >= capacity) return null;
      held += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held -= 1;
      };
    },
    dispatch: async (job: GradingJob, emit: EmitEvent) => {
      inFlight.push(job.id);
      await emit({ type: 'dispatched' });
      await gate;
      await emit({ type: 'finished', verdict: 'AC', points: 1, maxPoints: 1, timeMs: 1, memoryKb: 1 });
    },
    cancel: async () => {},
    stop: async () => {},
  };
  return { driver, inFlight, release };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('startWorkerPool', () => {
  it('runs N independent claim loops that hold N distinct jobs in flight at once', async () => {
    const claims: Claim[] = [];
    const jobs = fakeJobStore(3, claims);
    const writer = { apply: async () => true } as unknown as EventWriter;
    const { driver, inFlight, release } = blockingDriver();

    const pool = startWorkerPool(jobs, writer, driver, 'judged-1', 3);
    try {
      await waitFor(() => inFlight.length === 3);

      expect(new Set(inFlight).size).toBe(3);
      expect(new Set(claims.map((c) => c.jobId)).size).toBe(3);
      // Distinct worker ids, so `grading_jobs.worker_id` still names exactly
      // one loop when a job has to be diagnosed after the fact.
      expect(new Set(claims.map((c) => c.workerId)).size).toBe(3);
      for (const claim of claims) expect(claim.workerId).toMatch(/^judged-1#[123]$/);
    } finally {
      release();
      pool.stop();
      await pool.finished;
    }
  }, 30_000);

  /**
   * B2's back-pressure half. A DMOJ judge grades one submission per
   * connection, so a pool that claims more jobs than there are idle
   * connections leaves the extras leased-but-unrunnable until their own
   * grading watchdog fires — and it is that watchdog's `cancel` that used to
   * terminate whatever the judge was really running. The pool must therefore
   * reserve a judge slot BEFORE it claims, not after.
   */
  it('claims no more jobs than the driver has idle judge slots', async () => {
    const claims: Claim[] = [];
    const jobs = fakeJobStore(2, claims);
    const writer = { apply: async () => true } as unknown as EventWriter;
    const { driver, inFlight, release } = saturatingDriver(1);

    const pool = startWorkerPool(jobs, writer, driver, 'judged-1', 2);
    try {
      await waitFor(() => inFlight.length === 1);
      // Ample time for the second loop to claim job 2 if it were not gated.
      await new Promise((r) => setTimeout(r, 300));
      expect(inFlight).toHaveLength(1);
      expect(claims).toHaveLength(1);

      // Releasing the one slot is what lets the queue move.
      release();
      await waitFor(() => inFlight.length === 2);
      expect(claims).toHaveLength(2);
    } finally {
      release();
      pool.stop();
      await pool.finished;
    }
  }, 30_000);

  it('is a single loop, with the plain worker id, at concurrency 1', async () => {
    const claims: Claim[] = [];
    const jobs = fakeJobStore(2, claims);
    const writer = { apply: async () => true } as unknown as EventWriter;
    const { driver, inFlight, release } = blockingDriver();

    const pool = startWorkerPool(jobs, writer, driver, 'judged-1', 1);
    try {
      await waitFor(() => inFlight.length === 1);
      // Give a second loop, if one existed, ample time to claim job 2.
      await new Promise((r) => setTimeout(r, 200));
      expect(inFlight).toHaveLength(1);
      expect(claims.map((c) => c.workerId)).toEqual(['judged-1#1']);
    } finally {
      release();
      pool.stop();
      await pool.finished;
    }
  }, 30_000);
});
