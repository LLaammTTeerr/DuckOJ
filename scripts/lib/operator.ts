/**
 * What the three `scripts/e2e-*.ts` smoke scripts need from the machine they
 * are run on: the URL this deployment actually serves, and the admin the
 * operator bootstrapped.
 *
 * These scripts are the first thing a province runs to prove a fresh install
 * works, and F-58 found that neither half was true of a default deployment:
 *
 * - they defaulted `E2E_BASE_URL` to `https://localhost:8443`, which is dead
 *   when `SITE_ADDRESS=:80` (the `.env.example` default) — Caddy binds 80 and
 *   compose maps it to 8080, so 8443 refuses the connection outright; and
 * - they opened with an anonymous `POST /auth/register`, which D200's default
 *   `closed` rung refuses `403`. `e2e-problem.ts` called `fail()` on it, so
 *   an operator's first verification ended in a stack trace.
 *
 * F-56 and F-57 taught the Playwright walks to mint their pupils as the admin
 * (`91a8402`, `6309fe2`). This is that same shape for the CLI tools, and the
 * admin parser is *literally* the walks' own — imported, not re-implemented,
 * because two parsers of one secrets file is how one of them ends up
 * authenticating as whoever is written last.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminCredentials, type AdminCredentials } from '../../apps/web/e2e/credentials.js';

export type { AdminCredentials };

/** This repository, from this file's own location rather than the cwd. */
export const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/**
 * The operator's admin, for a judge that takes no sign-ups.
 *
 * Same three ways in as the Playwright walks, in the same order —
 * `E2E_ADMIN_USER`/`E2E_ADMIN_PASSWORD`, then `E2E_SECRETS_FILE`, then the
 * repository's `.secrets/duckadmin.txt` — so an operator who can run
 * `corepack pnpm --filter @duckoj/web test:e2e` can run these unmodified,
 * and a different deployment supplies its own admin with no file at all.
 *
 * The only difference from the walks' call is the default path: Playwright
 * runs from `apps/web` and these run from the repo root.
 *
 * The password never reaches stdout. Every message these scripts print names
 * the *username*, and the failure below names the file and the variable.
 */
export function operatorAdmin(): AdminCredentials {
  return adminCredentials({ secretsFile: join(REPO_ROOT, '.secrets', 'duckadmin.txt') });
}

/**
 * `.env`'s value for `key`, or undefined. Read-only, and tolerant: a missing
 * file is not an error, because these scripts are also run against a stack
 * somebody else deployed, from a checkout that has no `.env` at all.
 */
function fromDotEnv(key: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(REPO_ROOT, '.env'), 'utf8');
  } catch {
    return undefined;
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at === -1) continue;
    if (line.slice(0, at).trim() !== key) continue;
    const value = line.slice(at + 1).trim();
    return value === '' ? undefined : value;
  }
  return undefined;
}

/**
 * The URL this deployment serves, which is the one `.env` decides.
 *
 * `E2E_BASE_URL` still wins — a stack reached through a tunnel or a reverse
 * proxy is named there. Otherwise `SITE_ADDRESS` is read, because that is the
 * variable that decides which port Caddy binds and therefore which of
 * compose's two host mappings is alive:
 *
 * - `:80` (the `.env.example` default, and what this province runs) →
 *   `http://localhost:8080`,
 * - anything binding 443 — `:443`, or a bare hostname, which makes Caddy
 *   provision a certificate and listen on 443 → `https://localhost:8443`.
 *
 * The old hardcoded `https://localhost:8443` was the second case written down
 * as if it were the first, which is why the documented first verification
 * failed to connect on every default deployment.
 */
export function liveBaseUrl(): string {
  const explicit = process.env.E2E_BASE_URL;
  if (explicit !== undefined && explicit !== '') return explicit;
  const siteAddress = fromDotEnv('SITE_ADDRESS') ?? ':80';
  const bindsHttp80 = siteAddress === ':80' || siteAddress.endsWith(':80');
  return bindsHttp80 ? 'http://localhost:8080' : 'https://localhost:8443';
}

/**
 * What these scripts put in the `Origin` header of every cookie-authenticated
 * write.
 *
 * D82 refuses such a write unless its `Origin` is `PUBLIC_ORIGIN` or one of
 * `WS_EXTRA_ORIGINS`, and Node's `fetch` sends none of its own — so a script
 * driving the stack the way a browser at `BASE` would has to say so. That is
 * `BASE`'s own origin by default.
 *
 * `E2E_ORIGIN` overrides it, and exists for the deployment whose `.env` lists
 * only its public name: an operator there can point `E2E_ORIGIN` at
 * `PUBLIC_ORIGIN` instead of editing a live `.env` to run a smoke test.
 */
export function requestOrigin(base: string): string {
  const explicit = process.env.E2E_ORIGIN;
  if (explicit !== undefined && explicit !== '') return new URL(explicit).origin;
  return new URL(base).origin;
}

/**
 * Certificate verification is disabled for the WHOLE process, and ONLY when
 * the target is an https `localhost` — the self-signed certificate Caddy
 * generates for the 8443 mapping. Against `http://localhost:8080` (the
 * default deployment) nothing is disabled at all, and against a real
 * hostname the certificate is checked, because there it is a real one and a
 * blanket opt-out would make these scripts a tool for talking to anything.
 */
export function relaxTlsForSelfSignedLocalhost(base: string): void {
  const url = new URL(base);
  if (url.protocol !== 'https:') return;
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

/**
 * How long to wait before re-offering a submission the meter just refused,
 * or null when it did not refuse one.
 *
 * `POST /submissions` allows **one submission per ten seconds** per account
 * (`SUBMISSION_BURST_LIMIT`, D26/D80), with no exemption for admins because
 * what is being metered is a grading container. These scripts submit three or
 * four times in a row as fast as the judge answers, so they hit it every run
 * — which is not a bug in the meter, and must not be a stack trace in the
 * operator's first verification either. The wait is the server's own
 * `Retry-After`, plus a small margin for clock skew between the two
 * processes; a missing or unparseable header falls back to the burst window.
 */
export function submissionRetryAfterMs(res: Response): number | null {
  if (res.status !== 429) return null;
  const header = res.headers.get('retry-after');
  const seconds = header === null ? Number.NaN : Number(header);
  return (Number.isFinite(seconds) ? Math.max(1, seconds) : 10) * 1000 + 500;
}

/**
 * A hint appended to a registration failure, because the two ways this fails
 * on a real deployment look nothing like a bug in the script.
 */
export function registrationHint(status: number, admin: string): string {
  if (status === 403) {
    return `\n  This judge takes no sign-ups (D200), so accounts are minted by an admin — and '${admin}' was refused, which means it is not a global admin on this stack. Check with 'corepack pnpm bootstrap:admin ${admin}'.`;
  }
  if (status === 401) {
    return `\n  '${admin}' is not signed in. Check the password in .secrets/duckadmin.txt, or set E2E_ADMIN_USER/E2E_ADMIN_PASSWORD.`;
  }
  return '';
}
