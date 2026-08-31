import type { Page } from '@playwright/test';

/**
 * The console/subresource watchdog every browser test asserts on.
 *
 * Lifted out of `smoke.spec.ts` (where it was first written) so
 * `journey.spec.ts` uses the same one rather than a copy that drifts — and
 * so the list of *expected* failures is a parameter instead of a growing
 * pile of hardcoded exceptions inside it.
 *
 * A journey exercises routes that answer 4xx as part of working correctly:
 * `GET /contests/{key}/me` 404s until you have joined, and `POST /auth/login`
 * 401s with `totp_required` on the first leg of a two-factor sign-in. Those
 * are passed in per test, scoped to a route AND a status, so a 500 on the
 * same route still fails the test.
 */
export interface Allowance {
  status: number;
  /** Matched against the full URL — a substring, or a pattern. */
  url: string | RegExp;
}

function matches(url: string, pattern: string | RegExp): boolean {
  return typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url);
}

/** Fails the test if the page logged an error or failed to fetch a subresource. */
export function watchForBrokenRequests(
  page: Page,
  allowed: readonly Allowance[] = [],
  allowedConsole: readonly (string | RegExp)[] = [],
): { errors: string[] } {
  const errors: string[] = [];
  page.on('console', (msg) => {
    // Chromium emits "Failed to load resource: ..." for every non-2xx
    // response, with no URL attached. That is a duplicate of the `response`
    // handler below, which DOES carry the URL and can therefore be filtered
    // precisely. Keeping both meant an expected 401 was unfilterable and all
    // three page tests failed on it while every real assertion passed.
    if (msg.type() !== 'error') return;
    if (msg.text().startsWith('Failed to load resource')) return;
    // A caller may name console errors it expects — a known message a not-yet
    // redeployed edge still emits, say — the console twin of `allowed` for
    // subresource statuses. Scoped to the exact text, so a different error on
    // the same page still fails the test.
    if (allowedConsole.some((pattern) => matches(msg.text(), pattern))) return;
    errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('response', (res) => {
    // A 4xx/5xx on a subresource is the exact shape of the Caddy bugs this
    // project has shipped three times: the document loads, an asset does not.
    if (res.status() < 400) return;
    // `GET /auth/me` answering 401 to a signed-out visitor is the app working
    // as designed — every page issues it to decide whether to show a session.
    // It is the one universal expected failure, and it is scoped to that
    // exact route and status so a 500 there would still fail the test.
    if (res.status() === 401 && res.url().includes('/auth/me')) return;
    if (allowed.some((a) => a.status === res.status() && matches(res.url(), a.url))) return;
    errors.push(`${res.status()} ${res.url()}`);
  });
  return { errors };
}
