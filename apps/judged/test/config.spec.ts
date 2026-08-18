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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
    const { REDIS_URL: _omitted, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/REDIS_URL/);
  });
});
