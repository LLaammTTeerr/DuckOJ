import { Catch, HttpException, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ProblemDetailsDto } from '@duckoj/contracts';
import { describeError } from '@duckoj/observability';
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
  413: 'Payload Too Large',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/**
 * Machine-readable codes, declared independently of `TITLES`.
 *
 * `@duckoj/contracts` promises that `code` is "stable across wording changes".
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
  413: 'payload_too_large',
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
    if (problem.status >= 500) this.logger.error(describeError(exception));

    // Set before `status`/`send`: headers an `AppError` carries are part of
    // the answer (a 429's `Retry-After` is where a client actually looks),
    // and they must not depend on any handler having remembered to reach for
    // the response object itself.
    if (exception instanceof AppError && exception.headers) {
      for (const [name, value] of Object.entries(exception.headers)) res.setHeader(name, value);
    }
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
    // Express middleware throws before Nest ever sees the request, and what it
    // throws is an `http-errors` object, not an `HttpException`: the json body
    // parser's `PayloadTooLargeError` is the one that matters here. Without
    // this branch a 1 MB submission answered `500 internal_error` — logged at
    // ERROR, so an oversized paste read as a server fault — while the 413
    // `payload_too_large` entry in the tables above sat unreachable.
    //
    // Deliberately narrow: a 4xx AND `expose: true`, which is `http-errors`'s
    // own marker for "this status and message are safe to show the client".
    // A driver error that merely happens to carry a `status` field cannot pick
    // its own response code, and nothing 5xx-shaped can dodge the logging
    // below. Only the status is taken — never the error's message.
    if (isExposedClientError(exception)) {
      return {
        type: 'about:blank',
        title: titleFor(exception.status),
        status: exception.status,
        code: codeFor(exception.status),
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

function isExposedClientError(error: unknown): error is { status: number } {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { status?: unknown; expose?: unknown };
  return (
    candidate.expose === true &&
    typeof candidate.status === 'number' &&
    candidate.status >= 400 &&
    candidate.status < 500
  );
}

function titleFor(status: number): string {
  return TITLES[status] ?? 'Error';
}

function codeFor(status: number): string {
  return CODES[status] ?? `http_${status}`;
}
