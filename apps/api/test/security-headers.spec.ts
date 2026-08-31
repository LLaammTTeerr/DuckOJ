// The SPA's `index.html` is served by Caddy's `file_server`, never by Node —
// so the one document that runs author-controlled statement HTML through
// `dangerouslySetInnerHTML` (apps/web/src/markdown.ts) can only be given a
// Content-Security-Policy at the edge. These headers were entirely absent
// (verified against the live stack: `curl -sD - http://localhost:8080/` carried
// no CSP, HSTS, X-Content-Type-Options, Referrer-Policy or X-Frame-Options),
// which is a defence a browser cannot supply for itself.
//
// This spec pins the Caddyfile the same way `proxy-keepalive.spec.ts` does: by
// reading it and asserting the directives are present, because there is no way
// to unit-test "the browser received this header" without standing the whole
// proxy up. The empirical half — a throwaway `caddy` container serving this
// file and answering the headers — was run by hand during the fix.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const caddyfile = readFileSync(join(repoRoot, 'Caddyfile'), 'utf8');

/**
 * The site-level `header { … }` block — everything before the first `handle`.
 * Scoping the search to it keeps a header that only appears inside a `handle`
 * (the SPA's CSP) from being mistaken for a site-wide one.
 */
function siteHeaderBlock(): string {
  const start = caddyfile.indexOf('header {');
  expect(start, 'Caddyfile has no site-level `header {` block').toBeGreaterThan(-1);
  // The first `handle` AFTER the block opens — searching from 0 would match the
  // word inside this block's own explanatory comment.
  const firstHandle = caddyfile.indexOf('handle', start);
  return caddyfile.slice(start, firstHandle === -1 ? undefined : firstHandle);
}

describe('Caddy security headers', () => {
  it('sends the always-on hardening headers on every response', () => {
    const block = siteHeaderBlock();
    // HSTS: enforced over the HTTPS the deployment terminates, ignored on http.
    expect(block).toMatch(/Strict-Transport-Security\s+"max-age=\d+/);
    // MIME-sniffing off — the classic sniff-to-text/html upload XSS.
    expect(block).toMatch(/X-Content-Type-Options\s+"nosniff"/);
    // Referrer trimmed cross-origin so a statement's outbound links leak no path.
    expect(block).toMatch(/Referrer-Policy\s+"strict-origin-when-cross-origin"/);
    // Clickjacking cover for browsers predating `frame-ancestors`.
    expect(block).toMatch(/X-Frame-Options\s+"DENY"/);
    // Version/tech disclosure stripped at the edge (also off in app.setup.ts).
    expect(block).toMatch(/-X-Powered-By/);
  });

  it('carries a Content-Security-Policy compatible with KaTeX and inline SVG', () => {
    const csp = /Content-Security-Policy\s+"([^"]+)"/.exec(caddyfile);
    expect(csp, 'Caddyfile declares no Content-Security-Policy').not.toBeNull();
    const policy = csp![1]!;

    // Default is same-origin only.
    expect(policy).toMatch(/default-src 'self'/);
    // The Vite build emits NO inline scripts, so scripts are locked to 'self'
    // with no `'unsafe-inline'` — an injected <script> cannot run.
    expect(policy).toMatch(/script-src 'self'(?![^;]*'unsafe-inline')/);
    // KaTeX writes inline `style="…"` on every formula: inline styles MUST be
    // allowed or maths renders wrong. This is the one concession, and it is on
    // style-src only — never script-src.
    expect(policy).toMatch(/style-src [^;]*'unsafe-inline'/);
    // No plugins, no <base> hijack, no framing, no cross-origin form posts.
    expect(policy).toMatch(/object-src 'none'/);
    expect(policy).toMatch(/base-uri 'self'/);
    expect(policy).toMatch(/frame-ancestors 'none'/);
    expect(policy).toMatch(/form-action 'self'/);
  });

  // D120. index.html carries ONE inline <script> (D116's pre-paint theme
  // setter, added after this CSP was written), and `script-src 'self'` with no
  // hash blocks it — a CSP violation the browser logs on EVERY page, which took
  // the whole Playwright suite red against the live stack. The fix is the
  // script's sha256 in script-src, never `'unsafe-inline'`; this pins the two
  // together so index.html and the Caddyfile can never silently diverge again.
  it('allows index.html’s pre-paint theme bootstrap by its exact hash (D120)', () => {
    const indexHtml = readFileSync(join(repoRoot, 'apps', 'web', 'index.html'), 'utf8');
    const inline = /<script>([\s\S]*?)<\/script>/.exec(indexHtml);
    expect(inline, 'apps/web/index.html has no inline <script> to hash').not.toBeNull();
    const hash = 'sha256-' + createHash('sha256').update(inline![1]!, 'utf8').digest('base64');
    const csp = /Content-Security-Policy\s+"([^"]+)"/.exec(caddyfile)![1]!;
    const scriptSrc = /script-src ([^;]+)/.exec(csp)![1]!;
    expect(scriptSrc, `script-src must carry the theme-bootstrap hash ${hash}`).toContain(hash);
    // The hash is an allowance for ONE known script, not a door for any inline.
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });
});
