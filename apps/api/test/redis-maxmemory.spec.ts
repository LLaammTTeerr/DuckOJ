/**
 * The unbounded-Redis startup warning.
 *
 * B12 recorded `maxmemory 0` + `noeviction` as "recorded, not fixed", with
 * the reason it is currently safe (every key this API writes carries a TTL)
 * and the reason that safety is a property of the code rather than of the
 * configuration. The ruling taken here is to warn rather than to set — see
 * the module's own header — so what has to be true is: it warns on zero, it
 * stays quiet on a real limit, and it can never keep the API from starting.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  UNBOUNDED_REDIS_WARNING,
  warnIfRedisUnbounded,
  type ConfigurableRedis,
} from '../src/common/redis-maxmemory.js';

function logger() {
  return { warn: vi.fn(), debug: vi.fn() };
}

/** A Redis whose `CONFIG GET maxmemory` answers `reply`. */
function answering(reply: unknown): { redis: ConfigurableRedis; disconnected: () => boolean } {
  let disconnected = false;
  return {
    redis: {
      config: () => Promise.resolve(reply),
      disconnect: () => {
        disconnected = true;
      },
    },
    disconnected: () => disconnected,
  };
}

describe('warnIfRedisUnbounded', () => {
  it('warns when maxmemory is 0, naming the runbook section', async () => {
    const log = logger();
    const { redis } = answering(['maxmemory', '0']);

    await warnIfRedisUnbounded('redis://x', log, () => redis);

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]?.[0])).toBe(UNBOUNDED_REDIS_WARNING);
    // The operator has to be able to find out what to do about it.
    expect(UNBOUNDED_REDIS_WARNING).toContain('runbook.md');
  });

  it('stays quiet when a limit is set', async () => {
    const log = logger();
    const { redis } = answering(['maxmemory', '268435456']);

    await warnIfRedisUnbounded('redis://x', log, () => redis);

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('closes the connection it opened, whatever the answer was', async () => {
    const log = logger();
    const bounded = answering(['maxmemory', '1']);
    await warnIfRedisUnbounded('redis://x', log, () => bounded.redis);
    expect(bounded.disconnected()).toBe(true);

    // A boot-time probe that leaks a socket per start is a slow leak nobody
    // ever attributes to a log line.
    const failing: ConfigurableRedis = {
      config: () => Promise.reject(new Error('NOPERM')),
      disconnect: vi.fn(),
    };
    await warnIfRedisUnbounded('redis://x', log, () => failing);
    expect(failing.disconnect).toHaveBeenCalled();
  });

  it('never throws, and never guesses zero, when it cannot ask', async () => {
    const log = logger();

    // A managed Redis that forbids CONFIG.
    await expect(
      warnIfRedisUnbounded('redis://x', log, () => ({
        config: () => Promise.reject(new Error('ERR unknown command')),
        disconnect: () => undefined,
      })),
    ).resolves.toBeUndefined();

    // A Redis that is simply not up yet when the API boots.
    await expect(
      warnIfRedisUnbounded('redis://x', log, () => {
        throw new Error('ECONNREFUSED');
      }),
    ).resolves.toBeUndefined();

    // An unrecognised reply shape.
    const { redis } = answering({ maxmemory: '0' });
    await warnIfRedisUnbounded('redis://x', log, () => redis);

    // Not one warning across any of them: a scary line in a correctly
    // configured deployment's log is how a warning becomes noise.
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledTimes(3);
  });
});
