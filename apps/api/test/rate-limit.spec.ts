/**
 * D13 — the recovery endpoints stop mailing after five requests per key per
 * hour, and say nothing about it.
 *
 * "Say nothing" is load-bearing: the sixth request must be byte-for-byte the
 * response the first got, or the limiter becomes a probe for "this address
 * gets mail here". The window test backdates rows in `rate_events` directly —
 * the only deterministic clock a fixed-window limiter has.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { createDb, schema, type Db } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { testDbUrl, withTestDb } from './db.harness.js';
import { registerAndLogin } from './submissions.fixtures.js';
import { MAILER, type LogMailer } from '../src/mail/mailer.js';
import { passwordResetMail } from '../src/mail/templates.js';
import { RateLimiter, refusalPurpose } from '../src/common/rate-limiter.js';

function mailerOf(app: INestApplication): LogMailer {
  return app.get<LogMailer>(MAILER);
}

async function forgot(app: INestApplication, email: string) {
  return request(app.getHttpServer()).post('/api/v1/auth/password/forgot').send({ email });
}

/** Pushes every rate_events row past the one-hour window. */
async function ageAllEvents(db: Db): Promise<void> {
  await db
    .update(schema.rateEvents)
    .set({ createdAt: new Date(Date.now() - 61 * 60_000) });
}

describe('rate limiting on outbound recovery mail (D13)', () => {
  it('mails five times, then silently stops — and the response never changes', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await registerAndLogin(request.agent(app.getHttpServer()), 'lam');
        const email = 'lam@example.com';
        // Registration sends its own verification mail; count from here so
        // the pinned 5 below stays about the forgot endpoint alone.
        const before = mailerOf(app).sent.length;

        let firstBody = '';
        for (let i = 1; i <= 6; i++) {
          const res = await forgot(app, email);
          expect(res.status).toBe(202);
          if (i === 1) firstBody = JSON.stringify(res.body);
          // The sixth answer is indistinguishable from the first.
          expect(JSON.stringify(res.body)).toBe(firstBody);
        }
        // The literal 5, not the constant — pinned the same way
        // MIN_RATED_PARTICIPANTS is.
        expect(mailerOf(app).sent.length - before).toBe(5);
      } finally {
        await app.close();
      }
    });
  });

  it('a second address keeps its own window', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await registerAndLogin(request.agent(app.getHttpServer()), 'lam');
        await registerAndLogin(request.agent(app.getHttpServer()), 'kim');
        for (let i = 0; i < 6; i++) await forgot(app, 'lam@example.com');
        await forgot(app, 'kim@example.com');
        // Filter on subject too: kim's registration mailed her a verification
        // link, and this assertion is about the one *reset* mail. The subject
        // comes from the template rather than a literal, because since D57 it
        // is written in the reader's language and kim has chosen none.
        const resetSubject = passwordResetMail('vi', { url: '', ttlMinutes: 0 }).subject;
        expect(
          mailerOf(app).sent.filter((m) => m.to === 'kim@example.com' && m.subject === resetSubject),
        ).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  });

  it('an exhausted window reopens once its rows age out', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await registerAndLogin(request.agent(app.getHttpServer()), 'lam');
        // Offset past the registration verification mail (and its rate event,
        // which lives under the email_verification purpose and so survives
        // the reset-scoped cleanup below).
        const before = mailerOf(app).sent.length;
        for (let i = 0; i < 6; i++) await forgot(app, 'lam@example.com');
        expect(mailerOf(app).sent.length - before).toBe(5);

        await ageAllEvents(db);
        await forgot(app, 'lam@example.com');
        expect(mailerOf(app).sent.length - before).toBe(6);
        // The aged rows are gone, not merely uncounted — the opportunistic
        // delete is the only thing keeping this table bounded. (Scoped to
        // this purpose: the delete is per purpose+key, so the aged
        // email_verification row from registration is not its business.)
        expect(
          await db
            .select()
            .from(schema.rateEvents)
            .where(eq(schema.rateEvents.purpose, 'password_reset')),
        ).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  });

  it('probing an address that does not exist burns a window too', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        for (let i = 0; i < 3; i++) await forgot(app, 'ghost@example.com');
        const rows = await db.select().from(schema.rateEvents);
        expect(rows).toHaveLength(3);
      } finally {
        await app.close();
      }
    });
  });

  it('two purposes sharing one key hold separate windows', async () => {
    // Directly on the limiter: the HTTP suites cannot discriminate here
    // because their keys (an email, a user id) never collide across
    // purposes — exactly the situation that lets a dropped purpose filter
    // survive every other test.
    await withTestDb(async (db) => {
      const limiter = new RateLimiter(db);
      expect(await limiter.allow('a', 'shared-key', 1, 60_000)).toBe(true);
      expect(await limiter.allow('a', 'shared-key', 1, 60_000)).toBe(false);
      expect(await limiter.allow('b', 'shared-key', 1, 60_000)).toBe(true);
    });
  });

  it('consumeOnce admits exactly one of three CONCURRENT callers (D34)', async () => {
    // `allow(purpose, key, 1, window)` counts and then inserts with no lock,
    // which is fine for the mail limits it was written for and wrong for a
    // single-use credential: three callers presenting the same TOTP code at
    // the same instant — what a phishing relay does by construction — all
    // read a count of zero and all pass.
    //
    // Three real connections, not `withTestDb`: that helper runs the whole
    // test inside one rolled-back transaction, so a nested
    // `db.transaction()` is a SAVEPOINT of the same xid and
    // `pg_advisory_xact_lock` is re-entrant within it — the lock would be
    // taken three times by one session and serialise nothing. See
    // `testDbUrl`'s own comment.
    const url = await testDbUrl();
    const connections = [createDb(url), createDb(url), createDb(url)];
    try {
      const results = await Promise.all(
        connections.map((c) => new RateLimiter(c.db).consumeOnce('totp_used', '7:123456', 120_000)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      // A different key is unaffected, so this is not passing by refusing
      // everything.
      expect(
        await new RateLimiter(connections[0]!.db).consumeOnce('totp_used', '7:654321', 120_000),
      ).toBe(true);
    } finally {
      await connections[0]!.db
        .delete(schema.rateEvents)
        .where(eq(schema.rateEvents.purpose, 'totp_used'));
      await Promise.all(connections.map((c) => c.close()));
    }
  });

  it('verification resends share the same discipline', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'lam');
        for (let i = 0; i < 7; i++) {
          await agent.post('/api/v1/auth/email/verify/send').expect(202);
        }
        // Five verification mails total per user per hour — and registration's
        // own automatic send consumed the first of those slots, so the seven
        // resends above only got four more through. Same window, shared.
        expect(mailerOf(app).sent).toHaveLength(5);
      } finally {
        await app.close();
      }
    });
  });
});

/**
 * D47 — a refusal is recorded, so the admin dashboard can show one.
 *
 * `rate_events` holds one row per ATTEMPT, admitted or not, which means the
 * table alone cannot answer "how many callers did the limiter actually turn
 * away in the last hour" — the question an operator asks during an incident.
 * A refusal therefore writes a second row under a `refused:`-prefixed
 * purpose. `purpose` is plain text precisely so a new one costs no migration
 * (the column's own doc comment), the marker can never be confused with a
 * real window (different purpose string), and the expired-rows sweeper
 * already bounds the table by age.
 */
describe('refusals are counted (D47)', () => {
  async function refusalRows(db: Db, purpose: string): Promise<number> {
    const rows = await db
      .select({ id: schema.rateEvents.id })
      .from(schema.rateEvents)
      .where(eq(schema.rateEvents.purpose, refusalPurpose(purpose)));
    return rows.length;
  }

  it('marks an `allow` refusal and leaves an admitted attempt unmarked', async () => {
    await withTestDb(async (db) => {
      const limiter = new RateLimiter(db);
      expect(await limiter.allow('mark_a', 'k', 2, 60_000)).toBe(true);
      expect(await limiter.allow('mark_a', 'k', 2, 60_000)).toBe(true);
      expect(await refusalRows(db, 'mark_a')).toBe(0);

      expect(await limiter.allow('mark_a', 'k', 2, 60_000)).toBe(false);
      expect(await limiter.allow('mark_a', 'k', 2, 60_000)).toBe(false);
      expect(await refusalRows(db, 'mark_a')).toBe(2);
    });
  });

  it('marks a `retryAfterSeconds` refusal, which is how login refuses', async () => {
    await withTestDb(async (db) => {
      const limiter = new RateLimiter(db);
      expect(await limiter.retryAfterSeconds('mark_b', 'k', 1, 60_000)).toBeNull();
      expect(await refusalRows(db, 'mark_b')).toBe(0);

      await limiter.record('mark_b', 'k', 60_000);
      expect(await limiter.retryAfterSeconds('mark_b', 'k', 1, 60_000)).not.toBeNull();
      expect(await refusalRows(db, 'mark_b')).toBe(1);
    });
  });

  it('marks a `consumeOnce` refusal — the replayed credential', async () => {
    await withTestDb(async (db) => {
      const limiter = new RateLimiter(db);
      expect(await limiter.consumeOnce('mark_c', 'k', 60_000)).toBe(true);
      expect(await limiter.consumeOnce('mark_c', 'k', 60_000)).toBe(false);
      expect(await refusalRows(db, 'mark_c')).toBe(1);
    });
  });

  it('a marker never counts against the window it records', async () => {
    // The marker shares the key and differs only in purpose. If the prefix
    // were dropped, every refusal would extend its own window forever and a
    // limit of 2 would become a limit of 2 followed by an infinite refusal.
    await withTestDb(async (db) => {
      const limiter = new RateLimiter(db);
      expect(await limiter.allow('mark_d', 'k', 1, 60_000)).toBe(true);
      expect(await limiter.allow('mark_d', 'k', 1, 60_000)).toBe(false);
      await db
        .delete(schema.rateEvents)
        .where(eq(schema.rateEvents.purpose, 'mark_d'));
      // Only the refusal marker is left; the real window is empty again.
      expect(await limiter.allow('mark_d', 'k', 1, 60_000)).toBe(true);
    });
  });
});
