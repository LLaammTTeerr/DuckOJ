/**
 * One translation from "the API said no" to "the agent is told why".
 *
 * Every DuckOJ refusal is `application/problem+json` with a machine `code`
 * and a human `detail` (see `apps/api/src/common/app.error.ts`), and an agent
 * on the other end of a tool call can only act on the machine half. So the
 * mapping is deliberate rather than a stringified exception: `code` is
 * carried through untouched so a caller can branch on it, `detail` is the
 * sentence a person reads, and — for D80's metered `POST /submissions` — the
 * `Retry-After` header becomes a `retryAfterSeconds` NUMBER in the JSON.
 *
 * That last one is the whole reason this file is not three lines. `oj`
 * already learned it (`apps/oj/src/commands.ts`): "submission refused" with
 * no wait tells something driving the API in a loop nothing about how to stop
 * being refused, and the seconds are the entire answer. An agent loops harder
 * than a person does.
 */

/** The `application/problem+json` body every DuckOJ refusal carries. */
export interface ProblemJson {
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  fields?: Record<string, string[]>;
}

/** The JSON an agent receives for a failed tool call. */
export interface FailureJson {
  error: {
    code: string;
    detail: string;
    status: number;
    /** Present only when the API answered 429 with a `Retry-After` (D80). */
    retryAfterSeconds?: number;
    fields?: Record<string, string[]>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

function readFields(source: Record<string, unknown>): Record<string, string[]> | undefined {
  const value = source['fields'];
  if (!isRecord(value)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [key, messages] of Object.entries(value)) {
    if (Array.isArray(messages)) out[key] = messages.map((m) => String(m));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A code for a refusal that carried none — a proxy's 502, a body that was not
 * problem+json at all. Named per status rather than one `http_error` so a
 * caller can still branch: `unauthorized` is "mint a new token" and
 * `not_found` is "this does not exist, or you may not see it" (which for
 * DuckOJ reads are the same answer, deliberately — reads answer 404, never
 * 403, for things the actor may not see).
 */
function fallbackCode(status: number): string {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status > 0) return 'request_failed';
  return 'transport_error';
}

/**
 * `Retry-After` is whole seconds (RFC 9110). A `0` or a malformed value is
 * dropped rather than passed on: telling a caller to retry in zero seconds
 * invites the retry that will be refused, which is the one thing the header
 * exists to prevent.
 */
function parseRetryAfter(response: Response | undefined): number | undefined {
  const raw = response?.headers.get('Retry-After');
  if (raw === null || raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.ceil(seconds);
}

/** A refusal from the DuckOJ API, already reduced to what a caller can use. */
export class ApiFailure extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: string;
  readonly retryAfterSeconds: number | undefined;
  readonly fields: Record<string, string[]> | undefined;

  constructor(init: {
    code: string;
    status: number;
    detail: string;
    retryAfterSeconds?: number | undefined;
    fields?: Record<string, string[]> | undefined;
  }) {
    super(init.detail);
    this.name = 'ApiFailure';
    this.code = init.code;
    this.status = init.status;
    this.detail = init.detail;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.fields = init.fields;
  }

  static from(response: Response | undefined, body: unknown): ApiFailure {
    const status = response?.status ?? 0;
    const problem = isRecord(body) ? body : {};
    const detail =
      readString(problem, 'detail') ??
      readString(problem, 'title') ??
      (status > 0 ? `the API answered HTTP ${String(status)}` : 'the API could not be reached');
    return new ApiFailure({
      code: readString(problem, 'code') ?? fallbackCode(status),
      status,
      detail,
      retryAfterSeconds: parseRetryAfter(response),
      fields: readFields(problem),
    });
  }

  /** `{ error: … }`, with the optional members omitted rather than null. */
  toJSON(): FailureJson {
    return {
      error: {
        code: this.code,
        detail: this.detail,
        status: this.status,
        ...(this.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: this.retryAfterSeconds }
          : {}),
        ...(this.fields !== undefined ? { fields: this.fields } : {}),
      },
    };
  }

  /** The one-line human half, wait included when there is one. */
  summary(): string {
    const wait =
      this.retryAfterSeconds === undefined
        ? ''
        : ` — try again in ${String(this.retryAfterSeconds)}s`;
    return `${this.code}: ${this.detail}${wait}`;
  }
}

/** What `openapi-fetch` resolves to, narrowed to the parts this file reads. */
export interface FetchOutcome<T> {
  data?: T | undefined;
  error?: unknown;
  response: Response;
}

/**
 * `openapi-fetch` RESOLVES an HTTP error into `{ error, response }` and only
 * throws on a transport failure, so every call site would otherwise repeat
 * the same three-line check. `data === undefined` is treated as a failure
 * too: no tool here reads a 204, so a body-less success is a surprise worth
 * surfacing rather than an `undefined` handed to a formatter.
 */
export function unwrap<T>(result: FetchOutcome<T>): T {
  if (result.error !== undefined || result.data === undefined) {
    throw ApiFailure.from(result.response, result.error);
  }
  return result.data;
}

/**
 * Anything thrown inside a tool becomes an `ApiFailure`, because the tool
 * result has exactly one error shape and an agent should not have to tell a
 * `TypeError` from a 404. A transport failure (`fetch` rejecting) arrives
 * here as a plain `Error` and gets status 0.
 */
export function asApiFailure(err: unknown): ApiFailure {
  if (err instanceof ApiFailure) return err;
  return new ApiFailure({
    code: 'transport_error',
    status: 0,
    detail: err instanceof Error ? err.message : String(err),
  });
}
