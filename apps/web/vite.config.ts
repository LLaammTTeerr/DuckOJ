import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Where the API lives when this app is served by something other than Caddy.
 *
 * `vite dev` and `vite preview` serve the built bundle on their own port with
 * no API behind them, so every `/api/v1/*` call 404s and the app renders as a
 * pile of error states — which is exactly the thing a design review must not
 * be looking at. Proxying to the composed stack lets `vite preview` show the
 * REAL screens (a scoreboard with rows in it, an admin dashboard with
 * numbers) without deploying anything.
 *
 * Read-only as far as this config is concerned: it forwards requests, it does
 * not start, stop or write to the stack. Point it elsewhere with
 * `DUCKOJ_API_ORIGIN` when the stack is on a tailnet address.
 */
const apiOrigin = process.env.DUCKOJ_API_ORIGIN ?? 'http://localhost:8080';
const proxy = {
  '/api': { target: apiOrigin, changeOrigin: false },
  // `/ws` as well as `/api`, and this is not cosmetic (D150). The verdict on
  // the submit page arrives over the socket and ONLY over the socket:
  // `useSubmissionSocket` fetches on `open` and on every `signal` frame, and
  // nothing else on that page ever asks the API again. Without this rule
  // `vite preview` answered `/ws` with its own SPA fallback — an `index.html`
  // and a 200, so the upgrade failed silently — and a submission that the
  // judge had already marked AC sat on screen as an empty panel forever.
  // That is what made `journey`, `contest-day`, `features` and `authoring`
  // fail against a preview build even after their seeding was unblocked.
  //
  // `changeOrigin: false` for the same reason as above: the browser's real
  // `Origin` must reach the gateway, which checks it against the same
  // allow-list D82's CSRF guard uses (D70).
  '/ws': { target: apiOrigin, changeOrigin: false, ws: true },
};

/**
 * The preview port is PINNED, and pinned here rather than passed on a command
 * line, because it is half of a contract with the API (D150).
 *
 * D82 refuses every cookie-authenticated state change whose `Origin` is not
 * on the API's allow-list, so a bundle served by `vite preview` could not sign
 * in, submit, or seed a fixture against the composed stack — which is why no
 * FE agent could run `smoke`/`journey`/`features`/`contest-day` against its
 * own build before deploying it. The other half of the fix is
 * `WS_EXTRA_ORIGINS=…,http://localhost:4321` in the operator `.env`
 * (empty by default, so production is unchanged). An allow-list entry naming
 * a port is worthless if the port drifts, and vite's own default (4173)
 * changes with vite; `strictPort` makes a clash fail loudly instead of
 * silently serving from 4322 and reinstating the 403.
 */
const previewPort = 4321;

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy, port: previewPort, strictPort: true },
  // `exclude` keeps vitest out of `e2e/` — those are Playwright specs driving
  // a real browser against a live stack, and vitest would try to run them in
  // jsdom and fail on the missing `@playwright/test` runner.
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./test/setup.ts'],
    exclude: ['node_modules/**', 'dist/**', 'e2e/**'],
    // D149. No container starts here, so this is not the api package's
    // 120 s floor — it is headroom over `test/setup.ts`'s 5 s
    // `asyncUtilTimeout`, which a case may spend more than once while
    // `pnpm -r test` has every other package running beside it. Vitest's
    // 5 s default would kill such a case before its own `findBy` gave up.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
