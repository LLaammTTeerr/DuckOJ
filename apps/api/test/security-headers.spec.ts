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
});
