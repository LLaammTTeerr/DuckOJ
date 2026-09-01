/**
 * D155 — a production deployment that cannot send mail says so, and says it
 * about ITSELF rather than about the account.
 *
 * The failure this closes: a teacher clicks "reset my password", the API
 * answers 202, the UI says a mail was sent, and no mail exists — because
 * `LogMailer` is the transport and the reset link went to a container log
 * nobody reads. Nothing is wrong until a student is locked out on contest
 * day, and by then the evidence is gone.
 *
 * The rule and why it keeps D26's property, argued in full in D155:
 *
 * - The refusal is decided by `mailer.kind` and `nodeEnv` — two facts about
 *   the SERVER. It cannot vary with the address in the request, so it cannot
 *   answer "does this person have an account here", which is the whole reason
 *   `POST /auth/password/forgot` is uniform.
 * - It is therefore taken FIRST: before the rate limiter, before the user
 *   lookup. That is the assertion this file leans on hardest — a refusal
 *   raised after the lookup would be uniform in body and non-uniform in
 *   timing, and a timing oracle is still an oracle.
 * - `log` outside production stays a success, because there it is a
 *   deliberate configuration and the developer reading the log IS the
 *   delivery (see `LogMailer`'s own header). ~900 specs and every local
 *   `.env` depend on that, and none of them are the failure above.
 *
 * A unit test on the service, not an HTTP one: the property is "nothing else
 * ran", and the cleanest proof of that is a database handle and a rate
 * limiter that throw if they are touched at all.
 */
import { describe, expect, it } from 'vitest';
import type { Db } from '@duckoj/db';
import { AccountRecoveryService } from '../src/authn/account-recovery.service.js';
import type { AppConfig } from '../src/config/config.schema.js';
import { LogMailer, SmtpMailer, type Mailer } from '../src/mail/mailer.js';
import type { PasswordService } from '../src/authn/password.service.js';
import type { RateLimiter } from '../src/common/rate-limiter.js';
import { AppError } from '../src/common/app.error.js';
import { TEST_CONFIG } from './app.harness.js';

/** Anything that reaches these has already broken the property under test. */
const forbiddenDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`the database was touched (.${String(property)}) before the refusal`);
    },
  },
) as unknown as Db;

const forbiddenLimiter = {
  allow: () => {
    throw new Error('the rate limiter was consulted before the refusal');
  },
  record: () => {
    throw new Error('the rate limiter was consulted before the refusal');
  },
} as unknown as RateLimiter;

const passwords = {
  hash: () => Promise.resolve('unused'),
} as unknown as PasswordService;

function serviceWith(config: AppConfig, mailer: Mailer, db: Db = forbiddenDb) {
  return new AccountRecoveryService(db, config, mailer, passwords, forbiddenLimiter);
}

const production: AppConfig = { ...TEST_CONFIG, nodeEnv: 'production' };
const smtpConfigured: AppConfig = {
  ...production,
  smtp: { host: 'smtp.example', port: 587, secure: false },
};

/** The `AppError` a caller gets, or a failure saying what came out instead. */
async function refusalOf(work: Promise<unknown>): Promise<AppError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('the call succeeded; no refusal to inspect');
}

describe('a production stack with no mail transport refuses to pretend', () => {
  it('answers 503 to a password-reset request, naming the configuration', async () => {
    const service = serviceWith(production, new LogMailer());
    const error = await refusalOf(service.requestPasswordReset('teacher@school.example'));
    expect(error.status).toBe(503);
    expect(error.code).toBe('mail_unavailable');
    // The message is about the deployment, not the address.
    expect(error.detail).not.toContain('teacher@school.example');
  });

  it('refuses before the lookup, so the refusal cannot depend on the address', async () => {
    // `forbiddenDb` throws a plain Error on ANY property access, so reaching
    // this expectation at all proves the refusal came first. Two addresses,
    // one of which would exist on a real stack and one of which would not:
    // both must produce the identical refusal.
    const service = serviceWith(production, new LogMailer());
    const known = await refusalOf(service.requestPasswordReset('teacher@school.example'));
    const unknown = await refusalOf(service.requestPasswordReset('nobody@nowhere.example'));
    expect(unknown.status).toBe(known.status);
    expect(unknown.code).toBe(known.code);
    expect(unknown.detail).toBe(known.detail);
  });

  it('refuses a verification resend the same way', async () => {
    const service = serviceWith(production, new LogMailer());
    const error = await refusalOf(service.sendVerification(42));
    expect(error.status).toBe(503);
    expect(error.code).toBe('mail_unavailable');
  });

  it('does not refuse when SMTP is configured', async () => {
    // The gate is the transport, not the environment: a production stack that
    // was wired correctly must behave exactly as it did before D155. It gets
    // as far as the database, which is the failure `forbiddenDb` raises —
    // any AppError here would mean the refusal fired on a working mailer.
    const service = serviceWith(smtpConfigured, new SmtpMailer(smtpConfigured));
    await expect(service.requestPasswordReset('teacher@school.example')).rejects.toThrow(
      /the rate limiter was consulted/,
    );
  });

  it('leaves development and test alone, where the log IS the delivery', async () => {
    // TEST_CONFIG is `NODE_ENV=test` with no SMTP host — the configuration
    // the whole suite runs on. A refusal here would break ~900 specs and,
    // worse, make a developer stand up a mail server to register a user.
    const service = serviceWith(TEST_CONFIG, new LogMailer());
    await expect(service.requestPasswordReset('teacher@school.example')).rejects.toThrow(
      /the rate limiter was consulted/,
    );
  });
});
