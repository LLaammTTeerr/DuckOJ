/**
 * A failed request, with the STATUS still attached.
 *
 * Every read screen in this app used to turn a failed response into a bare
 * `new Error(error.detail ?? …)`, which throws away the one fact the code
 * downstream actually needs: whether asking again could possibly help.
 * TanStack Query's default policy retries any thrown error three times with
 * exponential backoff, so a 404 — an answer that will be identical every
 * time — held "Loading…" on screen for ~7.4 seconds and cost four requests.
 * See `src/query.ts` for the policy this type exists to feed.
 *
 * Its own module, importing nothing, rather than a second export from
 * `api.ts`: that file pulls in `@duckoj/sdk` and `@duckoj/api-prefix`, which
 * every spec in this suite replaces with `vi.mock`. A test that needs the
 * real error type would otherwise have to load the real client with it.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * The shape `openapi-fetch` hands back on a failed request: the RFC 7807
 * body it could decode, and the `Response` that carried it.
 *
 * Taken structurally rather than imported, because the generated client's
 * error type is a per-route union and every call site only reads `detail`
 * and `code` off it.
 */
export interface FailedRequest {
  error?: { detail?: string | undefined; code?: string | undefined } | undefined;
  response?: { status?: number | undefined } | undefined;
}

/**
 * `throw apiError(result, fallback)` — the one way this app turns a failed
 * response into an exception, so no screen loses the status again.
 *
 * The message still prefers the server's own `detail`: it is the wording
 * that names the actual problem, and D18 shows it verbatim rather than
 * translating it. `status` is 0 when there is no response at all, which is a
 * genuinely transient failure and stays retryable.
 */
export function apiError(result: FailedRequest, fallback: string): ApiError {
  return new ApiError(
    result.response?.status ?? 0,
    result.error?.detail ?? fallback,
    result.error?.code,
  );
}

/**
 * A response `openapi-fetch` has resolved: the body on success, the RFC 7807
 * body on failure, or neither for a 204.
 */
export interface Fetched<T> extends FailedRequest {
  data?: T | undefined;
}

/**
 * `read(result, fallback, absent)` — the reading half of `apiError`, and the
 * one way a query function in this app turns a response into data.
 *
 * **The bug it exists to kill.** `openapi-fetch` RESOLVES on an HTTP error
 * rather than rejecting, so `const { data } = await api.GET(...)` is a
 * perfectly clean-looking line that turns every 500 into `undefined` — and
 * `?? []` / `?? null` a line later turn that into "you belong to no
 * organization", "this school runs no contests", "you have no notifications".
 * The reader is told a fact about the world; the truth was that the question
 * was never answered. B-4 replaced these once and B-8 found nine survivors,
 * which is why the shape is a function now rather than a convention.
 *
 * **`absent` is the whole design.** Some of these reads have a failure that
 * genuinely IS an answer: `GET /auth/me` is 401 to a signed-out visitor, and
 * `GET /contests/{key}/me` is 404 to somebody who has not joined. Those are
 * states, not errors, and blanket-throwing would put a red error page under
 * the most public screens in the app. So a call site names the statuses that
 * mean "nothing here" and everything else propagates — which is exactly the
 * distinction the swallow could not express, and the reason it swallowed
 * everything instead.
 *
 * The thrown `ApiError` keeps its status, so `src/query.ts`'s retry policy
 * still declines to re-ask a question the server has already answered.
 */
export function read<T>(result: Fetched<T>, fallback: string, absent: readonly number[] = []): T | null {
  // Both halves are load-bearing. `error` is what openapi-fetch sets for a
  // failure whose body it could decode; a 4xx with an empty body leaves it
  // undefined, and then only the response's own status still says the
  // request failed. Checking one without the other lets a failure through as
  // `null`, which is the bug this function is named after.
  const status = result.response?.status;
  const failed = result.error !== undefined || (status !== undefined && status >= 400);
  if (!failed) return result.data ?? null;
  const error = apiError(result, fallback);
  if (absent.includes(error.status)) return null;
  throw error;
}
