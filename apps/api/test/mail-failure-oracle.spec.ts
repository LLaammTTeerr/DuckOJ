/**
 * D157 — a transport that fails MID-REQUEST must not answer a question
 * `POST /auth/password/forgot` refuses to answer.
 *
 * D155 closed the case where the deployment has no transport at all: the
 * refusal is decided before the lookup, so it is identical for every address.
 * F-40 also wired the six `SMTP_*` variables into the `api` container, which
 * is what finally makes `SmtpMailer` reachable in production — and that opens
 * the case D155 does not cover.
 *
 * With a real transport, `requestPasswordReset` reaches `mailer.send` only
 * when the address belongs to an account: an unknown address returns at
 * `if (!user) return`. So a relay that is refusing — an expired certificate,
 * a rejected credential, a firewall, every string D156 quotes as the reason
 * the button exists — makes the endpoint answer
 *
 *   * `202` for an address nobody here has, and
 *   * `500` for an address somebody here has.
 *
 * That is D26's membership oracle, arriving through the one door D155 left
 * open, and it needs no timing measurement to read: it is the status line.
 *
 * The same asymmetry exists in the CLOCK even when nothing fails, because
 * only the existing address pays an SMTP round trip. So the fix is both
 * halves at once: the send is not awaited, and its failure is logged rather
 * than raised. The endpoint's contract ("always succeeds, tells you nothing")
 * is the one D26 requires, and the honest report of a failed delivery belongs
 * in the log and on D156's dashboard, which are the two places that can
 * carry it without also answering a stranger's question.
 *
 * `email/verify/send` is deliberately NOT changed: its caller is signed in
 * and the address is their own, so there is nobody to leak to and a truthful
 * error is better than a silent 202. See D157.
 */
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Db } from '@duckoj/db';
import { AccountRecoveryService } from '../src/authn/account-recovery.service.js';
import type { AppConfig } from '../src/config/config.schema.js';
import type { Mailer, OutboundEmail } from '../src/mail/mailer.js';
import type { PasswordService } from '../src/authn/password.service.js';
import type { RateLimiter } from '../src/common/rate-limiter.js';
import { TEST_CONFIG } from './app.harness.js';

const production: AppConfig = {
  ...TEST_CONFIG,
  nodeEnv: 'production',
  smtp: { host: 'smtp.example', port: 587, secure: false },
};

const passwords = { hash: () => Promise.resolve('unused') } as unknown as PasswordService;
const allowingLimiter = {
  allow: () => Promise.resolve(true),
  record: () => Promise.resolve(),
} as unknown as RateLimiter;

/**
 * The one query `requestPasswordReset` makes, plus the token insert. Enough
 * of drizzle's builder to answer `.select().from().where().limit()`; nothing
 * else in the service touches the handle on this path.
 */
function dbWithUser(rows: readonly unknown[]): Db {
  const select = {
    from: () => select,
    where: () => select,
    limit: () => Promise.resolve([...rows]),
  };
  return {
    select: () => select,
    insert: () => ({ values: () => Promise.resolve(undefined) }),
  } as unknown as Db;
}

const KNOWN = [{ id: 7, email: 'teacher@school.example', locale: 'vi' }];
const UNKNOWN: unknown[] = [];

function serviceWith(mailer: Mailer, rows: readonly unknown[]) {
  return new AccountRecoveryService(
    dbWithUser(rows),
    production,
    mailer,
    passwords,
    allowingLimiter,
  );
}

/** A transport that refuses, exactly as a misconfigured relay does. */
function refusingMailer(): Mailer {
  return {
    kind: 'smtp',
    send: () => Promise.reject(new Error('535 5.7.8 Authentication credentials invalid')),
  };
}

/** A transport that never answers, exactly as a firewalled relay does. */
function hangingMailer(): { mailer: Mailer; release: () => void } {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { mailer: { kind: 'smtp', send: () => pending }, release };
}

describe('a failing SMTP transport must not turn password reset into a membership oracle', () => {
  it('answers the same way for an address that exists as for one that does not', async () => {
    const known = serviceWith(refusingMailer(), KNOWN);
    const unknown = serviceWith(refusingMailer(), UNKNOWN);

    // The unknown address has always resolved — it returns at `if (!user)`.
    // The known one must resolve too, or the status line IS the answer to
    // "does this person have an account here".
    await expect(unknown.requestPasswordReset('nobody@nowhere.example')).resolves.toBeUndefined();
    await expect(known.requestPasswordReset('teacher@school.example')).resolves.toBeUndefined();
  });

  it('does not make the caller wait for the relay, so the CLOCK says nothing either', async () => {
    const { mailer, release } = hangingMailer();
    const service = serviceWith(mailer, KNOWN);
    const raced = await Promise.race([
      service.requestPasswordReset('teacher@school.example').then(() => 'returned'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting on the relay'), 100)),
    ]);
    release();
    expect(raced).toBe('returned');
  });

  it('records the failure where an operator can find it', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const service = serviceWith(refusingMailer(), KNOWN);
      await service.requestPasswordReset('teacher@school.example');
      // The send is deliberately not awaited; the rejection lands a tick later.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const logged = errors.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toMatch(/535 5\.7\.8/);
      // The log is for an operator, and it may name the account. The
      // RESPONSE is what must not.
      expect(logged).toMatch(/password reset/i);
    } finally {
      errors.mockRestore();
    }
  });

  it('still delivers when the transport works', async () => {
    const sent: OutboundEmail[] = [];
    const mailer: Mailer = {
      kind: 'smtp',
      send: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    };
    const service = serviceWith(mailer, KNOWN);
    await service.requestPasswordReset('teacher@school.example');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent.map((message) => message.to)).toEqual(['teacher@school.example']);
  });
});
