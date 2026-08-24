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
import { schema, type Db } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin } from './submissions.fixtures.js';
import { MAILER, type LogMailer } from '../src/mail/mailer.js';
import { RateLimiter } from '../src/common/rate-limiter.js';

function mailerOf(app: INestApplication): LogMailer {
  return app.get<LogMailer>(MAILER);
}

async function forgot(app: INestApplication, email: string) {
  return request(app.getHttpServer()).post('/auth/password/forgot').send({ email });
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
  }, 60_000);

  it('a second address keeps its own window', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await registerAndLogin(request.agent(app.getHttpServer()), 'lam');
        await registerAndLogin(request.agent(app.getHttpServer()), 'kim');
        for (let i = 0; i < 6; i++) await forgot(app, 'lam@example.com');
        await forgot(app, 'kim@example.com');
        // Filter on subject too: kim's registration mailed her a verification
        // link, and this assertion is about the one *reset* mail.
        expect(
          mailerOf(app).sent.filter(
            (m) => m.to === 'kim@example.com' && m.subject === 'Reset your DuckOJ password',
          ),
        ).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

  it('verification resends share the same discipline', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'lam');
        for (let i = 0; i < 7; i++) {
          await agent.post('/auth/email/verify/send').expect(202);
        }
        // Five verification mails total per user per hour — and registration's
        // own automatic send consumed the first of those slots, so the seven
        // resends above only got four more through. Same window, shared.
        expect(mailerOf(app).sent).toHaveLength(5);
      } finally {
        await app.close();
      }
    });
  }, 60_000);
});
