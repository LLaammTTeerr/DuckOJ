import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api-error.js';

/** TanStack Query's own default, kept: three attempts after the first. */
const MAX_ATTEMPTS = 3;

/**
 * Retry only what asking again could actually fix.
 *
 * TanStack Query's default policy is "retry any thrown error three times",
 * which is right for a dropped connection and wrong for every 4xx: the
 * server has already given its final answer, and repeating the question
 * three more times over ~7 seconds of exponential backoff only keeps the
 * "Loading…" spinner up while it does. Measured on the live stack before
 * this existed — `/users/NOPE` fired 404 at 114 ms, 1119 ms, 3129 ms and
 * 7135 ms before the page would say "No such user."
 *
 * 5xx and network-level failures (no response at all, so `status` is 0)
 * stay retryable, because those are exactly the cases a retry is for.
 */
export function retryTransientOnly(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < MAX_ATTEMPTS;
}

/**
 * The query client the app ships (`main.tsx`).
 *
 * A function rather than a module-level singleton so a test can build the
 * REAL policy instead of the `retry: false` stub every spec in this suite
 * uses — which is precisely why the shipped retry behaviour had no coverage
 * and the 4xx storm above went unnoticed. See `test/query-retry.spec.tsx`.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: retryTransientOnly } } });
}
