import { describe, expect, it } from 'vitest';
import { describeError } from '../src/describe-error.js';

/** Stands in for the argon2id hash a real caller might bind as a parameter. */
const SECRET_PARAM = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$SECRETHASHBYTES';

class DrizzleQueryErrorLike extends Error {
  constructor(
    public readonly query: string,
    public readonly params: unknown[],
    override readonly cause: Error,
  ) {
    // Mirrors drizzle-orm@0.45.2's own message construction:
    // `Failed query: ${query}\nparams: ${params}`.
    super(`Failed query: ${query}\nparams: ${params}`);
  }
}

describe('describeError', () => {
  it('never includes the query text or bind parameters', () => {
    const error = new DrizzleQueryErrorLike(
      'insert into "submissions" ("source") values ($1) returning *',
      [SECRET_PARAM],
      Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    );

    const rendered = JSON.stringify(describeError(error));

    expect(rendered).not.toContain(SECRET_PARAM);
    expect(rendered).not.toContain('insert into');
    // The message header (the leak vector) must not survive into `.frames`.
    expect(rendered).not.toContain('Failed query');
  });

  it('surfaces the constructor name and the driver SQLSTATE from .cause', () => {
    const error = new DrizzleQueryErrorLike(
      'select 1',
      [],
      Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    );

    const described = describeError(error);
    expect(described.name).toBe('DrizzleQueryErrorLike');
    expect(described.driverCode).toBe('40P01');
  });

  it('keeps the stack frames, useful for triage', () => {
    const error = new Error('boom');
    const described = describeError(error);
    expect(described.frames).toContain('describe-error.spec.ts');
  });

  it('withholds contents for a non-Error throw rather than stringifying it', () => {
    const described = describeError('some raw string, possibly sensitive');
    expect(JSON.stringify(described)).not.toContain('possibly sensitive');
  });
});
