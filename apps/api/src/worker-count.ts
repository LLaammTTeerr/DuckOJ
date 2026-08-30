/**
 * How many api workers are alive, as known inside a worker — D86.
 *
 * ## Why this exists
 *
 * In `node:cluster`'s default round-robin mode the **primary** binds the port
 * and hands accepted connections to workers. So "the port answers" and "the
 * application answers" are different facts, and on 2026-08-30 they came
 * apart: every worker was dead, the primary held the socket, and the
 * container healthcheck — `fetch('http://localhost:3000/healthz')` — opened a
 * connection that was accepted and never replied to. It did not fail; it
 * hung, and each probe cost its full timeout while `podman ps` said `Up`.
 *
 * A healthcheck that must be *answered*, with a body, by a process that can
 * run a route, cannot be fooled that way. `{ workers: n }` is the second
 * half: the number is the primary's own count of live workers, pushed to
 * each worker over the cluster IPC channel, so the probe also carries the
 * one fact only the supervisor knows.
 *
 * ## Why the default is 1 rather than 0
 *
 * A worker that has not yet received a broadcast reports `1`, not `0`,
 * because a worker rendering this response IS a live worker — reporting 0
 * there would be a lie that fails the healthcheck of a perfectly good
 * process during the milliseconds between its fork and the primary's first
 * message. And `API_WORKERS=1` never forks at all (`main.ts` bootstraps
 * directly, no primary, no IPC), which is the same honest answer by a
 * different route.
 *
 * The count is therefore a floor, never an overstatement: it is either what
 * the primary last said, or the one worker you are talking to.
 */

/** The `type` discriminator on the primary's broadcast. */
export const WORKER_COUNT_MESSAGE = 'duckoj:worker-count';

export interface WorkerCountMessage {
  type: typeof WORKER_COUNT_MESSAGE;
  workers: number;
}

export function workerCountMessage(workers: number): WorkerCountMessage {
  return { type: WORKER_COUNT_MESSAGE, workers };
}

/**
 * Narrows an arbitrary IPC message.
 *
 * A worker's `message` channel carries whatever anyone sends it, so this
 * checks the shape rather than trusting it: a malformed or hostile message
 * must leave the last good count alone rather than turning `workers` into
 * `undefined` on a response an orchestrator parses.
 */
export function isWorkerCountMessage(value: unknown): value is WorkerCountMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { type?: unknown; workers?: unknown };
  return (
    candidate.type === WORKER_COUNT_MESSAGE &&
    typeof candidate.workers === 'number' &&
    Number.isInteger(candidate.workers) &&
    candidate.workers >= 0
  );
}

/** `null` until the primary has said otherwise. See the header. */
let reported: number | null = null;

/**
 * Subscribes to the primary's broadcasts.
 *
 * `subscribe` is passed in rather than `process.on` being called here so this
 * is drivable from a test with a fake message stream — and so importing this
 * module (which `HealthController` does) never attaches a listener to
 * `process` as a side effect of being imported.
 */
export function listenForWorkerCount(subscribe: (handler: (message: unknown) => void) => void): void {
  subscribe((message) => {
    if (isWorkerCountMessage(message)) reported = message.workers;
  });
}

/** What `/healthz` reports. Never below 1 — see the header. */
export function reportedWorkerCount(): number {
  return reported === null ? 1 : Math.max(1, reported);
}

/** Test-only: drops what the primary last said. */
export function resetReportedWorkerCount(): void {
  reported = null;
}
