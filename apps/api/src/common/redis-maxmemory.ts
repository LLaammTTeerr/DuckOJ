/**
 * The startup check for an unbounded Redis.
 *
 * B12 scanned the live Redis under load and found **zero keys without a TTL**:
 * one write path, `SET … PX`, and realtime is pub/sub which stores nothing. So
 * `maxmemory 0` with the default `noeviction` policy is *safe here* — every
 * key expires, and the memory used peaked at 1.47 MB.
 *
 * It is safe by a property of the code, not by configuration, which is exactly
 * why this warns rather than sets. Setting `maxmemory` + `allkeys-lru` would
 * be configuring an eviction policy for a workload that never needs one, and
 * would quietly turn the first non-expiring key anyone adds into a key that
 * *silently disappears under pressure* instead of one that shows up as growth.
 * The failure this guards is the opposite one: somebody adds a `SET` with no
 * expiry, and an unbounded Redis grows until the host's OOM killer decides
 * which container dies. A warning at boot is the cheapest thing that puts the
 * word `maxmemory` in front of an operator before that happens.
 *
 * Everything here fails silent-but-for-a-debug-line. A managed Redis may
 * refuse `CONFIG GET` outright, Redis may simply not be up yet when the API
 * boots, and neither is a reason for the API not to start.
 */
import { Redis } from 'ioredis';

/** What this check needs from a connection. Named so a test can supply one. */
export interface ConfigurableRedis {
  config(operation: 'GET', parameter: string): Promise<unknown>;
  disconnect(): void;
}

export interface CheckLogger {
  warn(message: string): void;
  debug(message: string): void;
}

/** The warning's text, exported so the test asserts the operator-facing words. */
export const UNBOUNDED_REDIS_WARNING =
  'redis maxmemory is 0 (unbounded) with no eviction policy: safe only because every key this ' +
  'API writes carries a TTL (see docs/runbook.md, "Redis is unbounded on purpose"). ' +
  'A key written without one will grow until the host runs out of memory.';

/**
 * Reads `maxmemory` and warns when it is `0`.
 *
 * `CONFIG GET` answers as a flat array — `['maxmemory', '0']` — on every
 * ioredis version this project has used; a reply of any other shape is treated
 * as "could not tell", never as zero. Guessing zero from an unparseable reply
 * would put a scary line in the log of a correctly-configured deployment,
 * which is how a warning becomes noise and then becomes ignored.
 */
export async function warnIfRedisUnbounded(
  redisUrl: string,
  logger: CheckLogger,
  connect: (url: string) => ConfigurableRedis = openRedis,
): Promise<void> {
  let redis: ConfigurableRedis | undefined;
  try {
    redis = connect(redisUrl);
    const reply = await redis.config('GET', 'maxmemory');
    const value = readMaxmemory(reply);
    if (value === null) {
      logger.debug('redis maxmemory check: unrecognised CONFIG GET reply');
      return;
    }
    if (value === '0') logger.warn(UNBOUNDED_REDIS_WARNING);
  } catch (error) {
    // Debug, not warn: a Redis that is not up yet, or one that forbids
    // `CONFIG`, is not a misconfiguration of THIS setting and must never look
    // like one — nor stop the API from starting.
    logger.debug(
      'redis maxmemory check skipped: ' + (error instanceof Error ? error.message : String(error)),
    );
  } finally {
    redis?.disconnect();
  }
}

function readMaxmemory(reply: unknown): string | null {
  if (!Array.isArray(reply)) return null;
  const at = reply.indexOf('maxmemory');
  if (at < 0) return null;
  const value: unknown = reply[at + 1];
  return typeof value === 'string' ? value : null;
}

function openRedis(url: string): ConfigurableRedis {
  const redis = new Redis(url, {
    // A boot-time check must not hang a boot: fail now, log debug, move on.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 2000,
    connectTimeout: 2000,
  });
  redis.on('error', () => undefined);
  return redis;
}
