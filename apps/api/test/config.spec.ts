import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config.schema.js';

const valid = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_TTL_HOURS: '720',
  TOTP_ENC_KEY: 'a'.repeat(64),
  PUBLIC_ORIGIN: 'http://localhost:5173',
};

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const config = loadConfig(valid);
    expect(config.port).toBe(3000);
    expect(config.sessionTtlHours).toBe(720);
  });

  it('throws with the offending keys when the environment is invalid', () => {
    expect(() => loadConfig({ ...valid, DATABASE_URL: 'not-a-url' })).toThrow(/DATABASE_URL/);
  });

  it('rejects a TOTP key that is not 32 bytes of hex', () => {
    expect(() => loadConfig({ ...valid, TOTP_ENC_KEY: 'short' })).toThrow(/TOTP_ENC_KEY/);
  });

  it('refuses to start without a Redis URL', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
    const { REDIS_URL: _omitted, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/REDIS_URL/);
  });
});
