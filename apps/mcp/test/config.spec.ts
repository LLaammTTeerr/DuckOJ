/**
 * Credential discovery and the writes switch.
 *
 * The switch gets its own tests despite being one comparison, because it is
 * the one line between "an agent may read this judge" and "an agent may
 * submit as its owner": every value that is not exactly `1` must be off,
 * including the ones that look enabled (`true`, `yes`).
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, normalizeBaseUrl, resolveConfig, writesEnabled } from '../src/config.js';

async function configDir(contents: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'duckoj-mcp-'));
  if (contents !== null) await writeFile(join(dir, 'config.json'), contents);
  return join(dir, 'config.json');
}

describe('writesEnabled', () => {
  it('is true only for exactly "1"', () => {
    expect(writesEnabled({ DUCKOJ_MCP_WRITES: '1' })).toBe(true);
    for (const value of ['0', '', 'true', 'yes', 'on', ' 1']) {
      expect(writesEnabled({ DUCKOJ_MCP_WRITES: value })).toBe(false);
    }
    expect(writesEnabled({})).toBe(false);
  });
});

describe('normalizeBaseUrl', () => {
  it('appends the API prefix to a bare origin', () => {
    expect(normalizeBaseUrl('http://localhost:8080')).toBe('http://localhost:8080/api/v1');
    expect(normalizeBaseUrl('http://localhost:8080/')).toBe('http://localhost:8080/api/v1');
  });

  it('leaves a URL that already names a path alone', () => {
    expect(normalizeBaseUrl('http://localhost:8080/api/v1')).toBe('http://localhost:8080/api/v1');
    expect(normalizeBaseUrl('https://oj.example/judge/api/v1/')).toBe(
      'https://oj.example/judge/api/v1',
    );
  });

  it('hands a non-URL back untouched rather than rewriting a typo', () => {
    expect(normalizeBaseUrl('localhost:8080')).toBe('localhost:8080');
  });
});

describe('resolveConfig', () => {
  it('reads the oj config file', async () => {
    const path = await configDir(JSON.stringify({ baseUrl: 'https://oj.test/api/v1', token: 'tok' }));
    const config = await resolveConfig({ env: {}, configPath: path });
    expect(config).toEqual({ baseUrl: 'https://oj.test/api/v1', token: 'tok', writes: false });
  });

  it('lets the environment win field by field', async () => {
    const path = await configDir(JSON.stringify({ baseUrl: 'https://oj.test/api/v1', token: 'file' }));
    const config = await resolveConfig({ env: { DUCKOJ_TOKEN: 'env' }, configPath: path });
    expect(config.token).toBe('env');
    expect(config.baseUrl).toBe('https://oj.test/api/v1');
  });

  it('works from the environment alone, with no file at all', async () => {
    const path = await configDir(null);
    const config = await resolveConfig({
      env: { DUCKOJ_URL: 'http://localhost:8080', DUCKOJ_TOKEN: 't', DUCKOJ_MCP_WRITES: '1' },
      configPath: path,
    });
    expect(config).toEqual({ baseUrl: 'http://localhost:8080/api/v1', token: 't', writes: true });
  });

  it('refuses, naming the way out, when there is no credential', async () => {
    const path = await configDir(null);
    await expect(resolveConfig({ env: {}, configPath: path })).rejects.toBeInstanceOf(ConfigError);
    await expect(resolveConfig({ env: {}, configPath: path })).rejects.toThrow(/oj login/);
  });

  it('treats an unreadable or malformed config file as absent', async () => {
    const path = await configDir('{ not json');
    await expect(resolveConfig({ env: {}, configPath: path })).rejects.toBeInstanceOf(ConfigError);
  });
});
