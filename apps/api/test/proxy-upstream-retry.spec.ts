// B5, the real cause of B4's `GET /api/v1/submissions/NaN` → 422 → **502**.
// Caddy's own access log recorded it, once, at 2026-08-30T05:06:14Z:
//
//   {"logger":"http.log.error",
//    "msg":"dial tcp: lookup api on 10.89.0.1:53: server misbehaving",
//    "request":{"uri":"/api/v1/submissions/NaN", … },"status":502}
//
// The API never wobbled — `podman inspect duckoj_api_1` reports
// `RestartCount 0` and no worker ever exited. What failed was **name
// resolution**: `reverse_proxy api:3000` dials a hostname, so Go resolves
// `api` against podman's aardvark-dns on *every* dial that cannot reuse a
// pooled connection, and aardvark-dns answers SERVFAIL under load often
// enough to be seen in a day's traffic. One transient blip, one 502, for a
// request the API was up and ready to answer.
//
// The same log holds 896 more 502s, all `connect: connection refused` on
// `/api/v1/problems` against three different container IPs — the API being
// recreated by the loop's redeploys. Same shape, same cost: every deploy
// spends its restart window turning healthy traffic into gateway errors.
//
// Both classes are *dial* failures: Caddy never wrote a byte upstream, so
// retrying is unconditionally safe — no idempotency question arises, and
// Caddy is explicit about this ("if the request cannot be sent, it is safe
// to retry"). The proxy simply was not told to. `lb_try_duration` is the
// switch: with it, a dial failure re-selects the upstream — re-resolving the
// hostname — for up to the duration given, so a DNS blip or a restarting
// container costs latency instead of an error page.
//
// This is asserted against the Caddyfile rather than over a live socket
// because the failure is in the deployment topology, not in any code this
// suite can boot: there is no way to make podman's DNS misbehave from a unit
// test, and a test that waited for one would be a flake generator. What can
// be pinned is the policy — and the policy being absent is the bug.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function caddyfile(): string {
  return readFileSync(join(repoRoot, 'Caddyfile'), 'utf8');
}

/** Every `reverse_proxy api:3000 { … }` block, brace-matched. */
function apiProxyBlocks(source: string): string[] {
  const blocks: string[] = [];
  const opener = /reverse_proxy\s+api:3000\s*\{/g;
  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    let depth = 1;
    let i = opener.lastIndex;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
      i += 1;
    }
    blocks.push(source.slice(opener.lastIndex, i - 1));
  }
  return blocks;
}

describe('Caddy upstream dial failures', () => {
  it('proxies the API on more than one handle, each with its own policy', () => {
    // /api/*, /ws and the health probes are three separate `reverse_proxy`
    // directives to the same upstream. Policy is per-directive, so "we set
    // it once" is not a defence — this pins that the count the assertions
    // below iterate over is the real one.
    const blocks = apiProxyBlocks(caddyfile());
    expect(blocks.length).toBe(3);
  });

  it('retries a dial failure instead of answering 502', () => {
    for (const block of apiProxyBlocks(caddyfile())) {
      const match = /lb_try_duration\s+(\d+)s/.exec(block);
      expect(match, `a reverse_proxy to api:3000 declares no lb_try_duration:\n${block}`).not.toBeNull();
      // Long enough to ride out a DNS blip and a container recreate, short
      // enough that a genuinely dead upstream still fails fast rather than
      // holding the client (and a Caddy goroutine) indefinitely.
      const seconds = Number(match?.[1]);
      expect(seconds).toBeGreaterThanOrEqual(5);
      expect(seconds).toBeLessThanOrEqual(30);
    }
  });

  it('waits between retries rather than spinning', () => {
    // The default `lb_try_interval` is 250ms, but leaving it implicit means
    // the retry loop's shape depends on a Caddy default; against `connection
    // refused` (which fails instantly) an unspecified interval is the
    // difference between a handful of retries and thousands.
    for (const block of apiProxyBlocks(caddyfile())) {
      expect(block, `a reverse_proxy to api:3000 declares no lb_try_interval:\n${block}`).toMatch(
        /lb_try_interval\s+\d+ms/,
      );
    }
  });
});
