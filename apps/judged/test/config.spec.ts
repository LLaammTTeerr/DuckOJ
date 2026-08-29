import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  BRIDGE_PORT: '9999',
  HEALTH_PORT: '3001',
  WORKER_ID: 'judged-1',
};

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    expect(loadConfig(valid).bridgePort).toBe(9999);
  });

  it('names the offending key when the environment is invalid', () => {
    expect(() => loadConfig({ ...valid, DATABASE_URL: 'nope' })).toThrow(/DATABASE_URL/);
  });

  it('refuses to start without a Redis URL', () => {
    const { REDIS_URL: _omitted, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/REDIS_URL/);
  });

  it('runs one claim loop per judge by default, and this stack has one judge', () => {
    // D28: a DMOJ judge grades one submission per connection, so a second
    // loop against a single judge can never win a judge slot.
    expect(loadConfig(valid).concurrency).toBe(1);
  });

  it('takes JUDGED_CONCURRENCY from the environment as a number', () => {
    expect(loadConfig({ ...valid, JUDGED_CONCURRENCY: '4' }).concurrency).toBe(4);
  });

  it('rejects a concurrency that is not a positive whole number, by name', () => {
    expect(() => loadConfig({ ...valid, JUDGED_CONCURRENCY: '0' })).toThrow(/JUDGED_CONCURRENCY/);
    expect(() => loadConfig({ ...valid, JUDGED_CONCURRENCY: '1.5' })).toThrow(/JUDGED_CONCURRENCY/);
    // The judge, not judged, is the ceiling — an absurd value here would only
    // deepen the queue at the judge while looking like a tuning win.
    expect(() => loadConfig({ ...valid, JUDGED_CONCURRENCY: '99' })).toThrow(/JUDGED_CONCURRENCY/);
  });
});
