/**
 * The claim loop's half of D68: what a `Worker` asks for, and what it does
 * when there is nothing it can run.
 *
 * Stubbed store and driver rather than a Postgres container — every
 * assertion here is about the loop's *call sequence*, and the SQL those
 * calls make is pinned against a real database in
 * `job-language-routing.spec.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { NoCapableJudgeError, type JudgeDriver } from '@duckoj/judge-protocol';
import { JobStore, type ClaimedJob } from '../src/job-store.js';
import { EventWriter } from '../src/event-writer.js';
import { Worker } from '../src/worker.js';

function job(id: number, languageKey = 'cpp17'): ClaimedJob {
  return {
    id,
    attempt: 1,
    submissionId: id,
    revisionId: 1,
    packageHash: 'h',
    source: 'int main(){}',
    languageKey,
    timeMs: 1000,
    memoryKb: 65_536,
    testCount: 1,
  };
}

/** Runs `worker.start()` for long enough to turn the loop a few times. */
async function runBriefly(worker: Worker, ms = 1_400): Promise<void> {
  const running = worker.start();
  await new Promise((resolve) => setTimeout(resolve, ms));
  worker.stop();
  await running;
}

function stubStore(overrides: Partial<JobStore>): JobStore {
  return {
    claim: vi.fn(async () => null),
    markBlocked: vi.fn(async () => []),
    complete: vi.fn(async () => true),
    release: vi.fn(async () => true),
    heartbeat: vi.fn(async () => true),
    isCurrentAttempt: vi.fn(async () => true),
    ...overrides,
  } as unknown as JobStore;
}

const silentWriter = { apply: vi.fn(async () => true) } as unknown as EventWriter;

describe('a claim loop against a heterogeneous fleet', () => {
  it('claims only what the connected judges can grade', async () => {
    const claim = vi.fn(async () => null);
    const store = stubStore({ claim: claim as never });
    const driver = {
      start: async () => {},
      capabilities: () => ({ languages: ['cpp17'], concurrency: 1 }),
      supportedLanguages: () => ['cpp17'],
      dispatch: async () => {},
      cancel: async () => {},
      stop: async () => {},
    } satisfies JudgeDriver;

    await runBriefly(new Worker(store, silentWriter, driver, 'w1'), 300);

    expect(claim).toHaveBeenCalled();
    expect(claim.mock.calls[0]).toEqual(['w1', ['cpp17']]);
  }, 20_000);

  it('claims anything when the driver declares no languages', async () => {
    const claim = vi.fn(async () => null);
    const store = stubStore({ claim: claim as never });
    // No `supportedLanguages` at all — every in-process double, which must
    // keep behaving exactly as it did before D68.
    const driver = {
      start: async () => {},
      capabilities: () => ({ languages: [], concurrency: 1 }),
      dispatch: async () => {},
      cancel: async () => {},
      stop: async () => {},
    } satisfies JudgeDriver;

    await runBriefly(new Worker(store, silentWriter, driver, 'w1'), 300);

    expect(claim.mock.calls[0]).toEqual(['w1', undefined]);
  }, 20_000);

  it('reconciles blocked_reason when a claim comes back empty, but not on every poll', async () => {
    const markBlocked = vi.fn(async () => []);
    const store = stubStore({ markBlocked: markBlocked as never });
    const driver = {
      start: async () => {},
      capabilities: () => ({ languages: ['cpp17'], concurrency: 1 }),
      supportedLanguages: () => ['cpp17'],
      dispatch: async () => {},
      cancel: async () => {},
      stop: async () => {},
    } satisfies JudgeDriver;

    // ~1.4 s is three POLL_MS turns of the loop; the scan window is 5 s, so
    // an unthrottled scan would fire on every one of them.
    await runBriefly(new Worker(store, silentWriter, driver, 'w1'));

    expect(markBlocked).toHaveBeenCalledTimes(1);
    expect(markBlocked).toHaveBeenCalledWith(['cpp17']);
  }, 20_000);

  it('does not diagnose a blocked queue when the fleet is simply down', async () => {
    const markBlocked = vi.fn(async () => []);
    const store = stubStore({ markBlocked: markBlocked as never });
    const driver = {
      start: async () => {},
      // Judges exist in the abstract but none is connected, so the honest
      // diagnosis is "no judge", not "no judge speaks your language".
      capabilities: () => ({ languages: [], concurrency: 0 }),
      supportedLanguages: () => [],
      dispatch: async () => {},
      cancel: async () => {},
      stop: async () => {},
    } satisfies JudgeDriver;

    await runBriefly(new Worker(store, silentWriter, driver, 'w1'));

    expect(markBlocked).not.toHaveBeenCalled();
  }, 20_000);

  it('hands the lease straight back when no connected judge can run the claimed job', async () => {
    let handed = false;
    const release = vi.fn(async () => true);
    const store = stubStore({
      claim: (async () => {
        if (handed) return null;
        handed = true;
        return job(7, 'py3');
      }) as never,
      release: release as never,
    });
    const driver = {
      start: async () => {},
      capabilities: () => ({ languages: ['cpp17'], concurrency: 1 }),
      supportedLanguages: () => ['cpp17'],
      // The capable judge disconnected between the claim and the dispatch.
      dispatch: async () => {
        throw new NoCapableJudgeError('py3', '7');
      },
      cancel: async () => {},
      stop: async () => {},
    } satisfies JudgeDriver;

    await runBriefly(new Worker(store, silentWriter, driver, 'w1'), 600);

    // Released now, rather than sat on for the whole lease window over a
    // fact the loop already has.
    expect(release).toHaveBeenCalledWith(7, 1);
  }, 20_000);
});
