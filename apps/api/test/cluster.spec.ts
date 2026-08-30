import { describe, expect, it } from 'vitest';
import {
  CRASH_LOOP_EXIT_CODE,
  CRASH_LOOP_WINDOW_MS,
  resolveWorkerCount,
  runPrimary,
  type SupervisedCluster,
  type SupervisedWorker,
} from '../src/cluster.js';

describe('resolveWorkerCount', () => {
  it('defaults to the machine parallelism when API_WORKERS is unset', () => {
    expect(resolveWorkerCount({}, 4)).toBe(4);
  });

  it('caps the default at 8 however many cores the machine has', () => {
    // A 64-core box is not a licence to open 64 pools of 10 connections
    // against a Postgres whose default max_connections is 100.
    expect(resolveWorkerCount({}, 64)).toBe(8);
  });

  it('never defaults below one worker', () => {
    expect(resolveWorkerCount({}, 0)).toBe(1);
  });

  it('honours an explicit API_WORKERS', () => {
    expect(resolveWorkerCount({ API_WORKERS: '2' }, 16)).toBe(2);
  });

  it('honours an explicit API_WORKERS above the default cap', () => {
    // The cap is a default, not a ceiling: an operator who has raised
    // max_connections may ask for more, and must not be silently clamped.
    expect(resolveWorkerCount({ API_WORKERS: '12' }, 4)).toBe(12);
  });

  it('treats API_WORKERS=1 as "no clustering"', () => {
    expect(resolveWorkerCount({ API_WORKERS: '1' }, 16)).toBe(1);
  });

  it('ignores surrounding whitespace', () => {
    expect(resolveWorkerCount({ API_WORKERS: ' 3 ' }, 16)).toBe(3);
  });

  it('treats an empty API_WORKERS as unset', () => {
    // Compose writes `API_WORKERS=` for a variable that is declared but has
    // no value; that must mean "default", not "invalid".
    expect(resolveWorkerCount({ API_WORKERS: '' }, 4)).toBe(4);
  });

  it.each(['0', '-1', '2.5', 'four', '4x'])('refuses API_WORKERS=%s', (value) => {
    // Fail at boot rather than silently serving on one worker: a deploy that
    // asked for eight and quietly got one is a capacity incident nobody sees
    // until the contest starts.
    expect(() => resolveWorkerCount({ API_WORKERS: value }, 4)).toThrow(/API_WORKERS/);
  });
});

/**
 * D85 — the crash-loop breaker.
 *
 * The 2026-08-30 outage's second half. The first half was a dependency Nest
 * could not resolve; the second was that nothing above the API could TELL.
 * `runPrimary` re-forked the dying workers on a doubling backoff, and because
 * the primary is what binds the port, the container stayed "up", `podman ps`
 * stayed green, and the healthcheck's connection was accepted by a process
 * that had nobody to hand it to. Fifteen minutes of that.
 *
 * A fake cluster rather than four real forked processes: the property is a
 * SEQUENCE of exits against a clock, and reproducing it for real means
 * waiting out `MAX_BACKOFF_MS` in a test that is then flaky about exactly the
 * timing it exists to pin. Every seam below (`cluster`, `now`, `exit`,
 * `schedule`, `onSignal`) is a default in production and only ever replaced
 * here.
 */
describe('runPrimary — the crash-loop breaker', () => {
  interface Scheduled {
    fn: () => void;
    ms: number;
  }

  class FakeCluster implements SupervisedCluster {
    workers: Record<string, SupervisedWorker | undefined> = {};
    readonly created: SupervisedWorker[] = [];
    readonly killed: string[] = [];
    private listener:
      | ((worker: SupervisedWorker, code: number | null, signal: string | null) => void)
      | undefined;
    private nextId = 1;

    fork(): SupervisedWorker {
      const id = this.nextId++;
      const worker: SupervisedWorker = {
        id,
        process: { pid: 10_000 + id },
        kill: (signal?: string) => this.killed.push(`${String(id)}:${signal ?? ''}`),
      };
      this.workers[String(id)] = worker;
      this.created.push(worker);
      return worker;
    }

    on(
      _event: 'exit',
      listener: (worker: SupervisedWorker, code: number | null, signal: string | null) => void,
    ): unknown {
      this.listener = listener;
      return this;
    }

    /** The event `node:cluster` emits when a worker process goes away. */
    die(worker: SupervisedWorker, code: number | null = 1, signal: string | null = null): void {
      delete this.workers[String(worker.id)];
      this.listener?.(worker, code, signal);
    }
  }

  interface Harness {
    cluster: FakeCluster;
    exits: number[];
    scheduled: Scheduled[];
    logs: string[];
    advance: (ms: number) => void;
    signal: (name: 'SIGTERM' | 'SIGINT') => void;
  }

  function start(count: number): Harness {
    const fake = new FakeCluster();
    const exits: number[] = [];
    const scheduled: Scheduled[] = [];
    const logs: string[] = [];
    const handlers = new Map<string, () => void>();
    let clock = 1_000_000;

    runPrimary(count, {
      cluster: fake,
      now: () => clock,
      exit: (code) => exits.push(code),
      schedule: (fn, ms) => scheduled.push({ fn, ms }),
      onSignal: (name, handler) => handlers.set(name, handler),
      log: (message) => logs.push(message),
    });

    return {
      cluster: fake,
      exits,
      scheduled,
      logs,
      advance: (ms) => {
        clock += ms;
      },
      signal: (name) => handlers.get(name)?.(),
    };
  }

  it('exits non-zero when every worker dies inside the window, instead of re-forking', () => {
    const h = start(4);
    expect(h.cluster.created).toHaveLength(4);

    // A boot failure: each worker dies within milliseconds of its fork. The
    // first three deaths leave a worker standing, so they are ordinary
    // re-forks on the doubling backoff — the supervisor cannot yet tell this
    // from three unrelated crashes.
    const [first, second, third, last] = h.cluster.created;
    for (const worker of [first!, second!, third!]) {
      h.advance(20);
      h.cluster.die(worker, 1, null);
    }
    expect(h.exits).toEqual([]);
    expect(h.scheduled.map((s) => s.ms)).toEqual([1_000, 2_000, 4_000]);

    // The fourth death empties the fleet, 80 ms after start. That is not a
    // crash, it is a build that cannot boot.
    h.advance(20);
    h.cluster.die(last!, 1, null);

    expect(h.exits).toEqual([CRASH_LOOP_EXIT_CODE]);
    // And NOTHING further was queued: the re-fork is the thing being refused.
    // (The three already pending are unref'd timers in production, and
    // `process.exit` takes them with it.)
    expect(h.scheduled).toHaveLength(3);
    expect(h.cluster.created).toHaveLength(4);
    expect(h.logs.at(-1)).toMatch(/cannot boot/);
  });

  it('keeps re-forking while at least one worker is still alive', () => {
    const h = start(4);
    h.advance(50);
    h.cluster.die(h.cluster.created[0]!, 1, null);

    // Three still up: this is one crashed worker, not a build that cannot
    // boot, and the supervisor's whole job is to replace it.
    expect(h.exits).toEqual([]);
    expect(h.scheduled).toHaveLength(1);
    expect(h.scheduled[0]!.ms).toBe(1_000);
  });

  it('re-forks rather than exiting when the fleet is lost long after start', () => {
    const h = start(2);
    // A day of healthy service, then something takes both workers at once —
    // an OOM sweep, a host hiccup. That is not a build that cannot boot, and
    // re-forking is the right answer to it.
    h.advance(CRASH_LOOP_WINDOW_MS + 1);
    h.cluster.die(h.cluster.created[0]!, null, 'SIGKILL');
    h.cluster.die(h.cluster.created[1]!, null, 'SIGKILL');

    expect(h.exits).toEqual([]);
    expect(h.scheduled).toHaveLength(2);
  });

  it('does not trip on the workers a shutdown kills', () => {
    const h = start(2);
    h.signal('SIGTERM');
    h.advance(10);
    h.cluster.die(h.cluster.created[0]!, null, 'SIGTERM');
    h.cluster.die(h.cluster.created[1]!, null, 'SIGTERM');

    // A recreate is every worker dying inside the window, and it must not be
    // reported as a failed boot — the breaker would turn every deploy's own
    // `podman stop` into a non-zero exit.
    expect(h.exits).toEqual([]);
    // Only the shutdown backstop, no re-forks.
    expect(h.scheduled.map((s) => s.ms)).toEqual([10_000]);
  });

  it('trips as soon as the fleet is empty, whatever the fleet size', () => {
    const h = start(1);
    h.advance(20);
    h.cluster.die(h.cluster.created[0]!, 1, null);
    expect(h.exits).toEqual([CRASH_LOOP_EXIT_CODE]);
  });
});
