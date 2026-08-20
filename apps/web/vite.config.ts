import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
