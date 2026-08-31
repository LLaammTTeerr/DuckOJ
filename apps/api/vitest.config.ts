import { defineConfig } from 'vitest/config';

/**
 * D149 — container-backed specs run on a package-wide budget, not per-file
 * magic numbers.
 *
 * Almost every spec in `apps/api/test` starts a Postgres (and often a Redis)
 * container through `db.harness.ts` / `redis.harness.ts`, runs the whole
 * migration chain, boots a Nest application and dispatches HTTP through it.
 * Vitest's DEFAULTS for that work are `testTimeout: 5_000` and
 * `hookTimeout: 10_000` — budgets a cold image pull, or eight spec files
 * racing podman for CPU, blows through routinely.
 *
 * The result was the campaign's most-reported and least-fixed failure:
 * "X.spec.ts failed under the full parallel run, passes in isolation" (B-10,
 * B-13, B-19, B-21, B-24, F-9, F-11, F-12, F-15, F-30, F-33, B-30, B-33).
 * B-34 finally opened one of them — `problem-comments.spec.ts`, thirteen
 * container-backed cases on the 5 s default while every sibling passed
 * `120_000` by hand — and found a plain defect wearing a flake's clothes.
 * Thirty-eight more spec files had the same hole (`app.smoke`,
 * `org-member-import`'s twenty-one cases, `route-marker-coverage`, …).
 *
 * Setting the floor HERE rather than in each file is what makes it
 * impossible to forget: a new spec inherits it by existing. The per-file
 * `120_000` / `180_000` arguments already written stay — they are all at or
 * above this floor, and rewriting eight hundred of them would be churn with
 * no behavioural change — but nothing new needs one, and
 * `test/db-spec-timeout-policy.spec.ts` fails the suite if a DB-touching
 * spec ever passes an argument BELOW the floor (which would silently opt
 * back out) or if a package grows container specs without a config like this
 * one.
 *
 * `hookTimeout` matters as much as `testTimeout`: `beforeAll` is where the
 * container actually starts, and 10 s is not a container budget either.
 *
 * **Why 180 s and not 120 s.** 120 s was the first number here — the one the
 * hand-written arguments had settled on — and it held for six full api runs.
 * It then lost one: `org-writes.spec.ts`'s FIRST case (the one that pays for
 * the container start and the whole migration chain) timed out at exactly
 * 120 000 ms during a parallel run that took 279 s of wall clock against a
 * nominal 170 s, because something else had the machine. 180 s is what the
 * slowest files in this suite already declared by hand, so it is not a new
 * number; the guard's FLOOR is still 120 000, which is the LEAST any single
 * declaration may be, not what a package should default to.
 *
 * The cost is honest and accepted: a genuinely hung test now takes three
 * minutes to report instead of five seconds. A slow red is worth incalculably
 * more than an intermittent one nobody can reproduce.
 */
export default defineConfig({
  test: {
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
