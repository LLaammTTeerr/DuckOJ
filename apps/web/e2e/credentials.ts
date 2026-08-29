import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The live stack's admin credentials, for the journeys that need one.
 *
 * NEVER hardcoded here. The operator's copy lives in `.secrets/duckadmin.txt`
 * (chmod 600, gitignored, written by `scripts/`), and the file's `password:`
 * line is the single source. Two ways in, in order:
 *
 *   1. `E2E_ADMIN_USER` / `E2E_ADMIN_PASSWORD` in the environment — how CI or
 *      a different deployment supplies its own admin, with no file at all.
 *   2. the secrets file, at `E2E_SECRETS_FILE` or the repo's own
 *      `.secrets/duckadmin.txt` — so the documented command
 *      (`corepack pnpm --filter @duckoj/web test:e2e`) works unmodified on
 *      the machine that provisioned the stack.
 *
 * The value never reaches a log, an error message or a screenshot: the
 * failure below names the file and the variable, never the contents.
 */
export interface AdminCredentials {
  username: string;
  password: string;
}

/**
 * The file holds one `key: value` block per account, blocks separated by a
 * `---` rule — the live stack's copy carries the admin AND a demo pupil. So
 * this parses blocks and CHOOSES one, rather than folding every line into a
 * single map: a flat parse silently returns the last block's password beside
 * the first block's username, which authenticates as whoever happens to be
 * written last.
 */
type Block = Record<string, string>;

function parseBlocks(text: string): Block[] {
  return text
    .split(/^\s*-{3,}\s*$/m)
    .map((chunk) => {
      const block: Block = {};
      for (const line of chunk.split('\n')) {
        const at = line.indexOf(':');
        if (at === -1) continue;
        const key = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        if (key !== '' && value !== '') block[key] = value;
      }
      return block;
    })
    .filter((block) => 'password' in block);
}

export function adminCredentials(): AdminCredentials {
  const wanted = process.env.E2E_ADMIN_USER;
  const fromEnv = process.env.E2E_ADMIN_PASSWORD;
  if (fromEnv !== undefined && fromEnv !== '') {
    return { username: wanted ?? 'duckadmin', password: fromEnv };
  }
  // `import.meta.url` would be the more modern route to "this file's
  // directory", but Playwright runs from the package root and that (apps/web)
  // is the stable anchor its own config already relies on.
  const file =
    process.env.E2E_SECRETS_FILE ?? resolve(process.cwd(), '../../.secrets/duckadmin.txt');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `No admin credentials: set E2E_ADMIN_PASSWORD, or put the operator secrets file at ${file}.`,
    );
  }
  const blocks = parseBlocks(text);
  const block =
    blocks.find((b) => (wanted === undefined ? b.globalRole === 'admin' : b.username === wanted)) ??
    null;
  if (block === null) {
    throw new Error(
      `${file} has no ${wanted === undefined ? 'account with "globalRole: admin"' : `block for ${wanted}`} — regenerate it with scripts/bootstrap-admin.`,
    );
  }
  // Never logged, never asserted on, never typed into a page that is about to
  // be screenshotted.
  return { username: block.username ?? 'duckadmin', password: block.password! };
}
