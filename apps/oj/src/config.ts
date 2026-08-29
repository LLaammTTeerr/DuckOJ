/**
 * `~/.config/duckoj/config.json` — `{ baseUrl, token }`, written by
 * `oj login`. Environment overrides (`DUCKOJ_URL` / `DUCKOJ_TOKEN`) win, so
 * CI never needs a file. The token is a personal access token from
 * `/auth/tokens`; the file is chmod 600 because it is a credential.
 */
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface OjConfig {
  baseUrl: string;
  token: string;
}

export function configPath(root = process.env.DUCKOJ_CONFIG_DIR ?? join(homedir(), '.config', 'duckoj')): string {
  return join(root, 'config.json');
}

/**
 * Writes the credential file, owner-readable from the instant it exists.
 *
 * `mode` on `writeFile` applies only when the file is CREATED, which is
 * exactly the case the trailing `chmod` could not cover: without it the file
 * appeared at `0666 & ~umask` — 0644 on a normal machine — and held a live
 * access token for as long as the write and the chmod took. On a shared
 * machine that is a readable window, not a theoretical one. The `chmod`
 * stays, because `mode` does nothing when the file already exists and a
 * config written by an older `oj` (or by hand) must still be tightened.
 */
export async function saveConfig(config: OjConfig, path = configPath()): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function loadConfig(path = configPath()): Promise<OjConfig | null> {
  const fromEnv = { baseUrl: process.env.DUCKOJ_URL, token: process.env.DUCKOJ_TOKEN };
  if (fromEnv.baseUrl !== undefined && fromEnv.token !== undefined) {
    return { baseUrl: fromEnv.baseUrl, token: fromEnv.token };
  }
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<OjConfig>;
    if (typeof raw.baseUrl !== 'string' || typeof raw.token !== 'string') return null;
    // A partial env override still wins field-by-field.
    return { baseUrl: fromEnv.baseUrl ?? raw.baseUrl, token: fromEnv.token ?? raw.token };
  } catch {
    return null;
  }
}
