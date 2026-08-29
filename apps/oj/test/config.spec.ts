import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configPath, loadConfig, saveConfig } from '../src/config.js';

afterEach(() => {
  delete process.env.DUCKOJ_URL;
  delete process.env.DUCKOJ_TOKEN;
});

describe('config', () => {
  it('round-trips, and the file is not world-readable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oj-config-'));
    const path = configPath(dir);
    await saveConfig({ baseUrl: 'http://localhost:3000/api/v1', token: 'secret' }, path);
    const { statSync } = await import('node:fs');
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(await loadConfig(path)).toEqual({ baseUrl: 'http://localhost:3000/api/v1', token: 'secret' });
  });

  it('tightens a config file that already exists and is world-readable', async () => {
    // `mode` on `writeFile` only applies at creation, so an existing file
    // keeps whatever permissions it had — a config written by an older `oj`,
    // or by hand, has to be repaired rather than merely not made worse.
    const { chmodSync, statSync, writeFileSync } = await import('node:fs');
    const dir = await mkdtemp(join(tmpdir(), 'oj-config-'));
    const path = configPath(dir);
    writeFileSync(path, '{}');
    chmodSync(path, 0o644);

    await saveConfig({ baseUrl: 'http://localhost:3000/api/v1', token: 'secret' }, path);
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  it('environment wins over the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oj-config-'));
    const path = configPath(dir);
    await saveConfig({ baseUrl: 'http://file', token: 'file-token' }, path);
    process.env.DUCKOJ_TOKEN = 'env-token';
    expect(await loadConfig(path)).toEqual({ baseUrl: 'http://file', token: 'env-token' });
  });

  it('a missing file is null, not a crash', async () => {
    expect(await loadConfig('/nonexistent/config.json')).toBeNull();
  });
});
