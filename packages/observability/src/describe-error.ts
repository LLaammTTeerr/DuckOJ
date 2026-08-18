/**
 * A log-safe rendering of a caught error, shared by every service that logs
 * one. First written for `apps/api`'s `ProblemFilter` and lifted out here so
 * `apps/judged` reuses the exact same logic rather than a second, drifting
 * copy — see that file's history for why this exists at all:
 *
 * Logging the raw error is a credential leak here, not merely noisy.
 * `drizzle-orm@0.45.2` builds every `DrizzleQueryError` as
 * ``new Error(`Failed query: ${query}\nparams: ${params}`)`` and also keeps
 * `query`/`params` as own properties — and a bind parameter can carry a
 * password hash or other sensitive value. `.message` can contain it, and
 * because V8 prefixes `.stack` with `name: message`, so can the *first line
 * of the stack*. Logging "name, code and stack" verbatim would therefore
 * re-create the very leak this is meant to close.
 *
 * So: the exception's class name, the underlying driver's SQLSTATE from the
 * `.cause` chain, and the stack **frames only** — everything from the first
 * `    at ` onwards, with the message header sliced off. That is enough for
 * an operator to see what failed and where, and it carries no query text, no
 * bind parameters, and no free-form message that might have interpolated
 * either.
 */
export function describeError(exception: unknown): Record<string, unknown> {
  if (!(exception instanceof Error)) {
    return { name: typeof exception, note: 'non-Error exception; contents withheld' };
  }
  const driverCode = driverCodeOf(exception);
  return {
    // The *constructor* name, not `.name`: `DrizzleQueryError` never assigns
    // `this.name`, so `.name` inherits a useless `'Error'` from the prototype
    // and the single most useful piece of triage — which layer threw — would
    // be lost. `constructor.name` gives `DrizzleQueryError`, `PostgresError`,
    // etc.
    name: exception.constructor?.name ?? exception.name,
    ...(driverCode ? { driverCode } : {}),
    frames: framesOf(exception.stack),
  };
}

/**
 * SQLSTATE (or an equivalent driver error code) from the exception or
 * anything on its `.cause` chain — postgres-js's `PostgresError` is reached
 * through `DrizzleQueryError.cause`. This is the one field worth surfacing
 * verbatim: it is a fixed five-character class, never user data. The chain
 * is walked with a depth bound so a self-referential `cause` cannot spin.
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
