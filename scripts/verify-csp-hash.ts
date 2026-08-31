/**
 * Assert the Caddy CSP `script-src` allows every inline `<script>` in the
 * BUILT `apps/web/dist/index.html` — the artefact Caddy actually serves.
 *
 *   corepack pnpm verify:csp   # after `vite build`
 *
 * D120 shipped the theme-bootstrap script's sha256 in the Caddyfile and a unit
 * test (apps/api/test/security-headers.spec.ts) pinning it to the SOURCE
 * `apps/web/index.html`. That test has one hole: Caddy serves the built file,
 * not the source, and Vite is free to transform an inline script during the
 * build (HTML minify, a future esbuild default, a Vite bump). If it ever does,
 * the source hash stays what the test expects while the SERVED bytes — and
 * their hash — change, so the CSP silently blocks the script on every page and
 * the whole site's client JS is refused, exactly the D120 class of breakage.
 * A unit test cannot close this: CI and the root `verify` ritual both build
 * AFTER the tests run, so a vitest reading `dist/` would never see it. This
 * runs immediately after the build instead, where the artefact exists.
 *
 * It also hashes EVERY inline script, not just the first: the D120 regex takes
 * one match, so a second inline script added to index.html would slip past it
 * unhashed and be blocked in production with the test still green.
 *
 * Exit 0 = every inline script's hash is present in `script-src`; exit 1 with
 * the offending hash otherwise. It never touches the running stack.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const builtIndex = join(repoRoot, 'apps', 'web', 'dist', 'index.html');
const caddyfilePath = join(repoRoot, 'Caddyfile');

function die(message: string): never {
  console.error(`verify:csp FAILED — ${message}`);
  process.exit(1);
}

let html: string;
try {
  html = readFileSync(builtIndex, 'utf8');
} catch {
  die(
    `${builtIndex} not found. Build the web app first ` +
      `(corepack pnpm --filter @duckoj/web exec vite build), then re-run.`,
  );
}

// Every `<script …>…</script>` whose opening tag has no `src=` — those are the
// inline scripts a `script-src` with no `'unsafe-inline'` must allow by hash.
// External `<script src=…>` are covered by `'self'` and are not hashed.
const inlineHashes: string[] = [];
const scriptTag = /<script(\b[^>]*)>([\s\S]*?)<\/script>/gi;
let match: RegExpExecArray | null;
while ((match = scriptTag.exec(html)) !== null) {
  const attrs = match[1] ?? '';
  const body = match[2] ?? '';
  if (/\bsrc\s*=/i.test(attrs)) continue; // external, allowed by 'self'
  inlineHashes.push('sha256-' + createHash('sha256').update(body, 'utf8').digest('base64'));
}

if (inlineHashes.length === 0) {
  // The built page carries no inline script at all — nothing to allow. That is
  // a legitimate state (the theme bootstrap could be removed), so it passes.
  console.log('verify:csp OK — the built index.html carries no inline <script>.');
  process.exit(0);
}

const caddyfile = readFileSync(caddyfilePath, 'utf8');
const cspMatch = /Content-Security-Policy\s+"([^"]+)"/.exec(caddyfile);
if (!cspMatch) die(`${caddyfilePath} declares no Content-Security-Policy.`);
const policy = cspMatch[1]!;
const scriptSrcMatch = /script-src ([^;]+)/.exec(policy);
if (!scriptSrcMatch) die('the CSP has no script-src directive.');
const scriptSrc = scriptSrcMatch[1]!;

if (scriptSrc.includes("'unsafe-inline'")) {
  die("script-src carries 'unsafe-inline' — the hash allow-list is meant to make it unnecessary.");
}

const missing = inlineHashes.filter((h) => !scriptSrc.includes(h));
if (missing.length > 0) {
  die(
    `the built index.html has inline script(s) whose hash is not in the Caddyfile ` +
      `script-src:\n  ${missing.join('\n  ')}\n` +
      `Update the '${caddyfilePath}' script-src to include the hash(es) above.`,
  );
}

console.log(
  `verify:csp OK — ${String(inlineHashes.length)} built inline script hash(es) all present in the Caddyfile script-src.`,
);
