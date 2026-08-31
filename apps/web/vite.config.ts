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
const proxy = { '/api': { target: apiOrigin, changeOrigin: false } };

/**
 * The preview port is PINNED, and pinned here rather than passed on a command
 * line, because it is half of a contract with the API (D149).
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
  },
});
