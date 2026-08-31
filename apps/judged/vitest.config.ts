import { defineConfig } from 'vitest/config';

/**
 * D143 — container-backed specs run on a package-wide budget.
 *
 * `apps/judged/test` starts Postgres containers through its own
 * `db.harness.ts` exactly as `apps/api` does, so it inherits the same hazard
 * vitest's 5 s / 10 s defaults create under whole-suite load. See
 * `apps/api/vitest.config.ts` for the full account; the policy is enforced
 * across every package by
 * `apps/api/test/db-spec-timeout-policy.spec.ts`.
 */
export default defineConfig({
  test: {
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
