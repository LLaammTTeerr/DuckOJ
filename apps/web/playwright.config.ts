import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests, deliberately separate from the vitest suites.
 *
 * `vitest` runs in jsdom, which executes the bundle but paints nothing. It
 * cannot see a stylesheet that failed to load, a formula KaTeX rendered
 * twice, an element pushed off-screen, or a console error the app swallowed.
 * Every one of those is invisible to a green jsdom suite — and two real bugs
 * this phase were found by a human opening the page, not by any test.
 *
 * These run against a REAL, ALREADY-RUNNING stack rather than a dev server on
 * purpose. The failures worth catching here — a Caddy route, a missing asset,
 * an API call that 404s behind the proxy — only exist in the composed system.
 * A `vite dev` server would serve the app correctly and prove nothing.
 *
 * Bring the stack up first with `scripts/compose-up.sh`, then:
 *   corepack pnpm --filter @duckoj/web test:e2e
 *
 * Override the target with E2E_BASE_URL for the tailnet or LAN address.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8080';

export default defineConfig({
  testDir: './e2e',
  // No parallelism: these share one live stack and one database. Two workers
  // registering the same username would fail in a way that looks like a bug
  // in the app rather than in the test setup.
  workers: 1,
  fullyParallel: false,
  // A real browser against a real stack is slower than jsdom; the judge in
  // particular takes seconds, not milliseconds.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL,
    // The stack serves plain HTTP on :8080 and Caddy's TLS on :8443 is
    // self-signed, so accept it if someone points E2E_BASE_URL there.
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
