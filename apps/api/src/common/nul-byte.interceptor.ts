import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { Request } from 'express';
import { AppError } from './app.error.js';

/**
 * U+0000 is not a character any DuckOJ string accepts, and this is the one
 * place that says so (D196).
 *
 * **Why a rule and not a fix per route.** Postgres `text` cannot hold a NUL
 * byte: the driver hands the parameter over and the server answers
 * `22021 invalid byte sequence`, which arrives as a `DrizzleQueryError` and
 * leaves `ProblemFilter` with nothing to map — so it becomes **500
 * `internal_error`**, logged at ERROR with a stack, on inputs a stranger
 * chooses. Measured against the live edge at `eef05c1`, with no cookie and no
 * token: `GET /users/%00`, `/orgs/%00`, `/problems/%00`, `/contests/%00`,
 * `/problems?q=%00`, `/contests?org=%00` and `POST /auth/login` with a NUL in
 * `usernameOrEmail` all answered 500. Signed in, `/users?q=%00`,
 * `/submissions?user=%00` and `/orgs/{slug}/members?q=%00` joined them.
 *
 * There is no shared string primitive to patch: `packages/contracts` builds
 * every field from a bare `z.string()`, and 87 `@Param()` bindings take a raw
 * string with no pipe at all. Adding a `.refine` to each is a rule that drifts
 * the first time somebody adds a field — the failure class this project
 * records once per phase — so the check is stated once, above every handler.
 *
 * **An interceptor, deliberately, and not middleware.** Nest runs middleware
 * BEFORE the guards; a rejection there would answer 422 to an anonymous caller
 * on `GET /users`, where D188 ruled the answer is `401
 * authentication_required` and where "your request is malformed" would imply a
 * well-formed one would have been served. An interceptor runs AFTER `AuthGuard`
 * and `ScopeGuard` and before the handler, so every ruled refusal that comes
 * from a guard still comes first, and no NUL reaches a statement.
 *
 * **What it does move**, named rather than left to be discovered: on a
 * `@Public()` route whose own 401 lives in a service — `GET
 * /orgs/{slug}/members`, D191 — an anonymous `?cursor=%00` now answers 422
 * instead of 401. That is the answer `?limit=1000` has always given there, it
 * creates no oracle (a well-formed cursor from an anonymous caller still
 * answers 401, which is the fact D191 protects), and it is the price of one
 * rule in one place instead of eighty-eight.
 *
 * The refusal is `422 validation_failed`, the same code and shape
 * `ZodValidationPipe` produces, so a client handles one thing.
 */
const NUL = '\u0000';

/** Bounds the walk of a body the import route allows to be 2 MB (D61). */
const MAX_NODES = 100_000;

function bodyHasNul(value: unknown, budget: { left: number }): boolean {
  if (budget.left-- <= 0) return false;
  if (typeof value === 'string') return value.includes(NUL);
  // A raw-body route hands us a Buffer. `Object.values` on one iterates every
  // byte, so it is excluded before the object branch, not inside it — a 2 MB
  // upload would otherwise be a hundred thousand recursive calls that can
  // never find a string anyway.
  if (Buffer.isBuffer(value)) return false;
  if (Array.isArray(value)) return value.some((item) => bodyHasNul(item, budget));
  if (value !== null && typeof value === 'object') {
    // KEYS as well as values, and the key half is not symmetry for its own
    // sake: several columns in this schema are `jsonb`, and Postgres refuses
    // a NUL in a jsonb string with `22P05` exactly as `text` refuses it with
    // `22021` — so `{"a\u0000b": "x"}` is the same 500 one layer down.
    for (const [key, item] of Object.entries(value)) {
      if (key.includes(NUL) || bodyHasNul(item, budget)) return true;
    }
  }
  return false;
}

@Injectable()
export class NulByteInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    // The RAW url, before express decodes it: a NUL can only arrive
    // percent-encoded (`%00`), because a literal one cannot travel in a
    // request line. Checking the raw string covers the path parameters and
    // the query string at once, including the 87 `@Param()` bindings that
    // never see a pipe. `%2500` is the TEXT "%00" and does not match — the
    // needle is a percent immediately followed by two zeroes.
    const url = request.originalUrl ?? request.url ?? '';
    if (url.includes('%00') || url.includes(NUL) || bodyHasNul(request.body, { left: MAX_NODES })) {
      throw new AppError(422, 'validation_failed', 'The request failed validation.', {
        _: ['must not contain a NUL character (U+0000)'],
      });
    }
    return next.handle();
  }
}
