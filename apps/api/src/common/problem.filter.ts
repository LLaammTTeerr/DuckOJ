import { Catch, HttpException, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ProblemDetailsDto } from '@qhhoj/contracts';
import { AppError } from './app.error.js';

/**
 * Human-readable titles. These are display strings: rewording one is a
 * copy-edit, not a contract change. Nothing may be derived from them — see
 * `CODES`.
 */
const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/**
 * Machine-readable codes, declared independently of `TITLES`.
 *
 * `@qhhoj/contracts` promises that `code` is "stable across wording changes".
 * This map is what makes that true: the previous implementation snake-cased the
 * *title*, so editing a display string silently rewrote the wire contract, and
 * every status outside the nine listed collapsed to a single indistinguishable
 * `error`. Both are now impossible — a title edit cannot reach this table, and
 * an unlisted status gets a distinct, stable `http_<status>` rather than being
 * merged with every other unlisted status.
 *
 * The values are exactly those the old derivation produced, so this change is
 * not observable to a client. The one exception is 500, which used to answer
 * `internal_server_error` when raised as an `HttpException` and `internal_error`
 * otherwise: one status, two codes, for one meaning. It is `internal_error`
 * everywhere now.
 *
 * Domain-specific codes (`username_taken`, `organization_not_found`, …) do not
 * live here — they come from the `AppError` that was thrown. This table is only
 * the fallback for exceptions raised without one.
 */
const CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  422: 'unprocessable_content',
  429: 'too_many_requests',
  500: 'internal_error',
  503: 'service_unavailable',
};

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const problem = this.toProblem(exception, req.originalUrl);
    if (problem.status >= 500) this.logger.error(describe(exception));

    res.status(problem.status).type('application/problem+json').send(problem);
  }

  private toProblem(exception: unknown, instance: string): ProblemDetailsDto {
    if (exception instanceof AppError) {
      return {
        type: 'about:blank',
        title: titleFor(exception.status),
        status: exception.status,
        code: exception.code,
        instance,
        ...(exception.detail ? { detail: exception.detail } : {}),
        ...(exception.fields ? { fields: exception.fields } : {}),
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        type: 'about:blank',
        title: titleFor(status),
        status,
        code: codeFor(status),
        instance,
      };
    }
    return {
      type: 'about:blank',
      title: TITLES[500]!,
      status: 500,
      code: CODES[500]!,
      instance,
    };
  }
}

function titleFor(status: number): string {
  return TITLES[status] ?? 'Error';
}

function codeFor(status: number): string {
  return CODES[status] ?? `http_${status}`;
}

/**
 * A log-safe rendering of an unhandled exception.
 *
 * Logging the raw exception is a credential leak here, not merely noisy.
 * `drizzle-orm@0.45.2` builds every `DrizzleQueryError` as
 * ``new Error(`Failed query: ${query}\nparams: ${params}`)`` and also keeps
 * `query`/`params` as own properties — and `AuthService.register` passes the
 * argon2id password hash as a bind parameter. Verified against this exact
 * version: `.message` contains the hash, and because V8 prefixes `.stack` with
 * `name: message`, so does the *first line of the stack*. Logging "name, code
 * and stack" verbatim would therefore have re-created the very leak it was
 * meant to close.
 *
 * So: the exception's class name, the underlying driver's SQLSTATE from the
 * `.cause` chain, and the stack **frames only** — everything from the first
 * `    at ` onwards, with the message header sliced off. That is enough for an
 * operator to see what failed and where, and it carries no query text, no bind
 * parameters, and no free-form message that might have interpolated either.
 */
function describe(exception: unknown): Record<string, unknown> {
  if (!(exception instanceof Error)) {
    return { name: typeof exception, note: 'non-Error exception; contents withheld' };
  }
  const driverCode = driverCodeOf(exception);
  return {
    // The *constructor* name, not `.name`: `DrizzleQueryError` never assigns
    // `this.name`, so `.name` inherits a useless `'Error'` from the prototype
    // and the single most useful piece of triage — which layer threw — would be
    // lost. `constructor.name` gives `DrizzleQueryError`, `PostgresError`, etc.
    name: exception.constructor?.name ?? exception.name,
    ...(driverCode ? { driverCode } : {}),
    frames: framesOf(exception.stack),
  };
}

/**
 * SQLSTATE (or an equivalent driver error code) from the exception or anything
 * on its `.cause` chain — postgres-js's `PostgresError` is reached through
 * `DrizzleQueryError.cause`. This is the one field worth surfacing verbatim:
 * it is a fixed five-character class, never user data. The chain is walked with
 * a depth bound so a self-referential `cause` cannot spin.
 */
function driverCodeOf(error: Error): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = current.cause;
  }
  return undefined;
}

/** The `    at …` frames of a stack, with the `name: message` header removed. */
function framesOf(stack: string | undefined): string {
  if (!stack) return '';
  const firstFrame = stack.indexOf('\n    at ');
  return firstFrame === -1 ? '' : stack.slice(firstFrame + 1);
}
