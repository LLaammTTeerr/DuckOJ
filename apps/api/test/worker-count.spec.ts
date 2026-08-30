import { afterEach, describe, expect, it } from 'vitest';
import {
  WORKER_COUNT_MESSAGE,
  isWorkerCountMessage,
  listenForWorkerCount,
  reportedWorkerCount,
  resetReportedWorkerCount,
  workerCountMessage,
} from '../src/worker-count.js';

/**
 * D86 — the live worker count that reaches `/healthz`.
 *
 * The primary is the only process that knows how many workers are up, and the
 * healthcheck talks to a worker. This is the wire between them.
 */
describe('the worker count a worker reports', () => {
  afterEach(() => {
    resetReportedWorkerCount();
  });

  it('reports 1 before the primary has said anything', () => {
    // Not 0. A worker rendering this response IS a live worker, and the
    // milliseconds between a fork and the primary's first broadcast must not
    // fail the healthcheck of a perfectly good process. `API_WORKERS=1`
    // never forks at all and lands on the same answer by the same reasoning.
    expect(reportedWorkerCount()).toBe(1);
  });

  it('takes the count from the primary broadcast', () => {
    let deliver: ((message: unknown) => void) | undefined;
    listenForWorkerCount((handler) => {
      deliver = handler;
    });

    deliver?.(workerCountMessage(4));
    expect(reportedWorkerCount()).toBe(4);

    // Three left after one died.
    deliver?.(workerCountMessage(3));
    expect(reportedWorkerCount()).toBe(3);
  });

  it('ignores messages that are not the broadcast, keeping the last good count', () => {
    let deliver: ((message: unknown) => void) | undefined;
    listenForWorkerCount((handler) => {
      deliver = handler;
    });
    deliver?.(workerCountMessage(4));

    // A worker's IPC channel carries whatever anyone sends it. None of these
    // may turn `workers` into `undefined` on a response an orchestrator
    // parses — the healthcheck reads `b.workers >= 1`.
    for (const junk of [
      null,
      undefined,
      'hello',
      42,
      {},
      { type: WORKER_COUNT_MESSAGE },
      { type: WORKER_COUNT_MESSAGE, workers: 'two' },
      { type: WORKER_COUNT_MESSAGE, workers: 1.5 },
      { type: WORKER_COUNT_MESSAGE, workers: -1 },
      { type: 'something:else', workers: 9 },
    ]) {
      deliver?.(junk);
      expect(reportedWorkerCount()).toBe(4);
    }
  });

  it('never reports below one, whatever the primary says', () => {
    let deliver: ((message: unknown) => void) | undefined;
    listenForWorkerCount((handler) => {
      deliver = handler;
    });
    // The primary can only ever reach 0 immediately before D85's breaker
    // exits it, and this response can only be produced by a live worker.
    deliver?.(workerCountMessage(0));
    expect(reportedWorkerCount()).toBe(1);
  });

  it('recognises its own message and nothing else', () => {
    expect(isWorkerCountMessage(workerCountMessage(2))).toBe(true);
    expect(isWorkerCountMessage({ type: 'duckoj:other', workers: 2 })).toBe(false);
  });
});
