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

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
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
