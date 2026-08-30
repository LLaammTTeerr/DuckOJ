/**
 * Where the server gets its credential, and whether it may write.
 *
 * `DUCKOJ_URL`/`DUCKOJ_TOKEN` win; otherwise the `oj` CLI's own
 * `~/.config/duckoj/config.json` is read, so somebody who has already run
 * `oj login` gets a working MCP server with no second credential to manage.
 *
 * **This duplicates `apps/oj/src/config.ts` on purpose.** `oj mcp` launches
 * this server, so `@duckoj/oj` depends on `@duckoj/mcp`; importing the reader
 * back out of `oj` would close that cycle and break `pnpm -r`'s topological
 * order and the `tsc -b` project graph with it. Twenty-five lines of file
 * reading is the cheaper of the two, and the file's SHAPE (`{ baseUrl,
 * token }`) is the contract both halves are written against.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { API_PREFIX } from '@duckoj/api-prefix';

export interface ServerConfig {
  baseUrl: string;
  token: string;
  /** `DUCKOJ_MCP_WRITES=1` — write tools are registered only when true. */
  writes: boolean;
}

export function ojConfigPath(
  root = process.env['DUCKOJ_CONFIG_DIR'] ?? join(homedir(), '.config', 'duckoj'),
): string {
  return join(root, 'config.json');
}

/**
 * A base URL that names only an origin gets the API prefix appended; one that
 * already names a path is used exactly as given.
 *
 * `DUCKOJ_URL=http://localhost:8080` is what a person types and what every
 * other environment variable in this repo means by a URL, but the SDK's
 * `baseUrl` is a request PREFIX — pointed at the origin it asks Caddy for
 * `/problems`, which falls through to the SPA catch-all and answers `200
 * text/html`. A 200 that is not JSON is the worst possible failure here: it
 * is not an error anywhere, it is a parse failure five frames away. So the
 * one case that cannot be a deliberate choice — no path at all — is fixed,
 * and any other path is left alone because a deploy that mounts the API
 * somewhere else must still be reachable.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Not a URL at all: hand it back untouched so the failure is the SDK's
    // own, at the call site, rather than a confusing rewrite of a typo.
    return trimmed;
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') return trimmed;
  return `${parsed.origin}/${API_PREFIX}`;
}

/** True only for `1` — an unset or empty variable must never open writes. */
export function writesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['DUCKOJ_MCP_WRITES'] === '1';
}

async function readOjConfig(path: string): Promise<{ baseUrl?: string; token?: string }> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof raw !== 'object' || raw === null) return {};
    const record = raw as Record<string, unknown>;
    return {
      ...(typeof record['baseUrl'] === 'string' ? { baseUrl: record['baseUrl'] } : {}),
      ...(typeof record['token'] === 'string' ? { token: record['token'] } : {}),
    };
  } catch {
    return {};
  }
}

export class ConfigError extends Error {}

/**
 * Environment first, file second, field by field — the same precedence `oj`
 * uses, so `DUCKOJ_TOKEN=… ` alone can point a logged-in machine at a
 * narrower token without editing the file.
 */
export async function resolveConfig(options: {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
} = {}): Promise<ServerConfig> {
  const env = options.env ?? process.env;
  const file = await readOjConfig(options.configPath ?? ojConfigPath());
  const baseUrl = env['DUCKOJ_URL'] ?? file.baseUrl;
  const token = env['DUCKOJ_TOKEN'] ?? file.token;
  if (baseUrl === undefined || token === undefined) {
    throw new ConfigError(
      'no DuckOJ credential — set DUCKOJ_URL and DUCKOJ_TOKEN, or run: ' +
        `oj login --url <baseUrl> --token <token> (config: ${options.configPath ?? ojConfigPath()})`,
    );
  }
  return { baseUrl: normalizeBaseUrl(baseUrl), token, writes: writesEnabled(env) };
}
