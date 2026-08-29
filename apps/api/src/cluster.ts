/**
 * Multi-process mode for the API.
 *
 * Measured, not guessed (load/RESULTS.md, 2026-08-29): at 500 VUs the `api`
 * container burned ~120% of ONE core while Postgres used ~110% of a
 * sixteen-core host and Caddy ~30%. A Node process runs JavaScript on a
 * single thread, so ~120% is that thread pegged plus libuv/GC on the side —
 * the stack was saturating one core with thirteen idle. Nothing about the
 * queries was slow; there was simply one of the thing doing the work.
 *
 * `node:cluster` is the whole fix: the primary binds the port once and the
 * kernel round-robins accepted connections across workers. Nothing else in
 * the API holds cross-request state that a second process would break —
 * sessions and rate limits are counted in the database (`RateLimiter`'s
 * header documents exactly this), and realtime wake-ups already fan out
 * through Redis precisely so that several instances each notify their own
 * sockets (`RedisSubmissionPublisher`'s header says so). Clustering is
 * therefore the same deployment shape the code was already written for,
 * inside one container instead of across several.
 *
 * This module deliberately does NOT import `loadConfig`, the Nest app, or
 * anything else the workers need: the primary's only job is to keep workers
 * alive, and a supervisor that dies on a configuration error takes the whole
 * API with it instead of letting one worker fail loudly and restart.
 */
import cluster from 'node:cluster';

/** Default ceiling on workers, however many cores the machine reports. */
const DEFAULT_MAX_WORKERS = 8;

/** First re-fork delay after a worker dies. Doubles, up to `MAX_BACKOFF_MS`. */
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * A worker that stayed up this long is treated as healthy: the next death
 * starts its backoff over at `BASE_BACKOFF_MS` rather than inheriting the
 * escalation from an unrelated crash an hour ago.
 */
const STABLE_UPTIME_MS = 30_000;

/**
 * How many API workers to run. `1` means "no clustering" — the process
 * bootstraps the application directly, exactly as it did before this existed.
 *
 * The default is capped at {@link DEFAULT_MAX_WORKERS} because workers are not
 * free downstream: each one opens its own Postgres pool (`createDb`, `max:
 * 10`), so eight workers is already 80 connections against a `postgres:16`
 * whose default `max_connections` is 100. The cap applies only to the
 * *default* — an explicit `API_WORKERS` is honoured as written, since an
 * operator who raised `max_connections` must not be silently clamped back
 * down to a number this file guessed.
 *
 * An unparseable value throws rather than falling back. A deploy that asked
 * for eight workers and quietly got one is a capacity incident that surfaces
 * during the contest, not at boot.
 *
 * @param parallelism `os.availableParallelism()`, injected so this is testable.
 */
export function resolveWorkerCount(env: NodeJS.ProcessEnv, parallelism: number): number {
  const raw = env.API_WORKERS?.trim();
  // Compose renders a declared-but-empty variable as `API_WORKERS=`; that is
  // "unset", not "invalid".
  if (raw === undefined || raw === '') {
    return Math.max(1, Math.min(parallelism, DEFAULT_MAX_WORKERS));
  }
  // `Number` alone accepts '2.5', '0x4', ' ' and '1e3'; require plain digits.
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid API_WORKERS=${raw} — expected a positive integer`);
  }
  const count = Number(raw);
  if (count < 1) {
    throw new Error(`Invalid API_WORKERS=${raw} — expected a positive integer`);
  }
  return count;
}

/**
 * Runs the supervisor loop in the primary process: fork `count` workers, and
 * re-fork any that exit, with exponential backoff so a worker that crashes on
 * startup (a bad `DATABASE_URL`, say) does not become a fork bomb.
 *
 * Never returns — the primary stays alive as long as the container does.
 */
export function runPrimary(count: number, log: (message: string) => void = defaultLog): void {
  let backoffMs = BASE_BACKOFF_MS;
  let shuttingDown = false;
  /** Fork time per worker id, to tell "crashed on boot" from "ran for a day". */
  const startedAt = new Map<number, number>();

  const fork = (): void => {
    if (shuttingDown) return;
    const worker = cluster.fork();
    startedAt.set(worker.id, Date.now());
  };

  cluster.on('exit', (worker, code, signal) => {
    const uptimeMs = Date.now() - (startedAt.get(worker.id) ?? Date.now());
    startedAt.delete(worker.id);
    if (shuttingDown) return;

    // A worker that ran long enough to be healthy resets the escalation;
    // one that died on startup escalates it. Without the reset, a single
    // crash loop at 03:00 would still be imposing a 30s re-fork delay on an
    // unrelated crash the next afternoon.
    if (uptimeMs >= STABLE_UPTIME_MS) backoffMs = BASE_BACKOFF_MS;
    const delayMs = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);

    log(
      `api worker ${String(worker.process.pid)} exited (code=${String(code)} signal=${String(signal)}) ` +
        `after ${String(Math.round(uptimeMs / 1000))}s — re-forking in ${String(delayMs)}ms`,
    );
    // `unref` so a re-fork timer never keeps the primary alive through a
    // shutdown it has already decided on.
    setTimeout(fork, delayMs).unref();
  });

  // Podman sends SIGTERM on `stop` / `--force-recreate` and waits ~10s before
  // SIGKILL. Without this the primary ignores it (workers get it too, and
  // exit, and the loop above dutifully re-forks them) and every recreate
  // costs the full kill timeout.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log(`api primary received ${signal} — stopping ${String(count)} workers`);
      for (const worker of Object.values(cluster.workers ?? {})) worker?.kill(signal);
      // Nothing left holding the loop open once the workers are gone, so the
      // primary exits on its own; this is only the backstop for a worker
      // that ignores the signal.
      setTimeout(() => process.exit(0), 10_000).unref();
    });
  }

  log(`api primary ${String(process.pid)} starting ${String(count)} workers`);
  for (let i = 0; i < count; i += 1) fork();
}

/**
 * Plain stderr, not the Nest/pino logger: the primary must not construct the
 * application (that is the workers' job), and pino's transport machinery is
 * one more thing that can fail in the process whose only duty is to survive.
 */
function defaultLog(message: string): void {
  process.stderr.write(`${JSON.stringify({ level: 'info', msg: message })}\n`);
}
