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
