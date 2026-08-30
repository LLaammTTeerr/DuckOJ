/**
 * D16 — login rate limiting.
 *
 * Unlike D13's recovery limiter, this one must NOT be silent: a refused
 * sign-in has to say so, with a `Retry-After`, or a person who mistyped their
 * password four times is told their password is wrong when it is not. There is
 * nothing to conceal — the endpoint already answers 401 for a wrong password,
 * so "you are being throttled" leaks no account's existence.
 *
 * The window is exercised by backdating `rate_events` directly, which is the
 * only deterministic clock a fixed-window limiter has (same trick as
 * `rate-limit.spec.ts`).
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { and, eq, like } from 'drizzle-orm';
import { authenticator } from '@otplib/preset-default';
import { schema, type Db } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';

const PASSWORD = 'a-long-enough-password';

async function registerUser(app: INestApplication, username: string): Promise<void> {
  const res = await request(app.getHttpServer()).post('/api/v1/auth/register').send({
    username,
    email: `${username}@example.com`,
    password: PASSWORD,
    displayName: username,
  });
  expect(res.status).toBe(201);
}

/** One sign-in attempt from `ip`, with an optional deliberately-wrong password. */
function attempt(
  app: INestApplication,
  usernameOrEmail: string,
  opts: { password?: string; ip?: string } = {},
) {
  const req = request(app.getHttpServer()).post('/api/v1/auth/login');
  if (opts.ip) req.set('X-Forwarded-For', `${opts.ip}, 10.0.0.1`);
  return req.send({ usernameOrEmail, password: opts.password ?? 'wrong-password-entirely' });
}

async function loginEvents(db: Db, keyLike: string) {
  return db
    .select({ key: schema.rateEvents.key })
    .from(schema.rateEvents)
    .where(and(eq(schema.rateEvents.purpose, 'login'), like(schema.rateEvents.key, keyLike)));
}

describe('per-identifier throttling', () => {
  it('accepts ten failures, then answers 429 login_rate_limited with a Retry-After', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await registerUser(app, 'throttled');
        // Each attempt from its own IP, so the per-IP window (30) can never
        // be what refuses here — otherwise this test would still pass with
        // the per-username limit deleted.
        for (let i = 0; i < 10; i++) {
          const res = await attempt(app, 'throttled', { ip: `203.0.113.${String(i)}` });
          expect([i, res.status]).toEqual([i, 401]);
        }

        const refused = await attempt(app, 'throttled', { ip: '203.0.113.99' });
        expect(refused.status).toBe(429);
        expect(refused.body.code).toBe('login_rate_limited');
        const retryAfter = Number(refused.headers['retry-after']);
        expect(retryAfter).toBeGreaterThan(0);
        expect(retryAfter).toBeLessThanOrEqual(15 * 60);

        // The refusal itself records nothing: no credential was checked, and
        // counting it would let an attacker hold the window open forever.
        expect(await loginEvents(db, 'user:throttled')).toHaveLength(10);

        // Even the RIGHT password is refused while the window is full — the
        // check runs before the password is looked at.
        const correct = await attempt(app, 'throttled', {
          password: PASSWORD,
          ip: '203.0.113.98',
        });
        expect(correct.status).toBe(429);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('a successful sign-in consumes nothing', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await registerUser(app, 'diligent');
        for (let i = 0; i < 12; i++) {
          const res = await attempt(app, 'diligent', { password: PASSWORD, ip: '198.51.100.7' });
          expect([i, res.status]).toEqual([i, 200]);
        }
        expect(await loginEvents(db, 'login')).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('the window drains: once the failures age out, the account signs in again', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await registerUser(app, 'patient');
        for (let i = 0; i < 10; i++) {
          await attempt(app, 'patient', { ip: `192.0.2.${String(i)}` });
        }
        expect((await attempt(app, 'patient', { ip: '192.0.2.99' })).status).toBe(429);

        await db
          .update(schema.rateEvents)
          .set({ createdAt: new Date(Date.now() - 16 * 60_000) });

        const res = await attempt(app, 'patient', { password: PASSWORD, ip: '192.0.2.99' });
        expect(res.status).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('is keyed on the identifier as submitted, case-insensitively', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await registerUser(app, 'MixedCase');
        for (let i = 0; i < 5; i++) await attempt(app, 'MixedCase', { ip: '203.0.113.1' });
        for (let i = 0; i < 5; i++) await attempt(app, 'mixedcase', { ip: '203.0.113.2' });
        // Ten failures under one key, not five under each.
        expect(await loginEvents(db, 'user:mixedcase')).toHaveLength(10);
        expect((await attempt(app, 'MIXEDCASE', { ip: '203.0.113.3' })).status).toBe(429);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('a two-factor refusal', () => {
  it('counts too — the code is not brute-forceable by someone holding the password', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerUser(app, 'twofactor');
        await agent.post('/api/v1/auth/login').send({ usernameOrEmail: 'twofactor', password: PASSWORD });
        const begin = await agent.post('/api/v1/auth/totp/begin');
        const secret = (begin.body as { secret: string }).secret;
        const confirm = await agent
          .post('/api/v1/auth/totp/confirm')
          .send({ code: authenticator.generate(secret) });
        expect(confirm.status).toBe(200);
        // The enrolment above signed in successfully, which consumes nothing.
        expect(await loginEvents(db, 'login')).toHaveLength(0);

        // Right password, no code: a 401, and it counts.
        const noCode = await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .set('X-Forwarded-For', '203.0.113.10')
          .send({ usernameOrEmail: 'twofactor', password: PASSWORD });
        expect([noCode.status, noCode.body.code]).toEqual([401, 'totp_required']);

        // Right password, wrong code: the guessing attack two-factor exists
        // to stop, and the one that most needs a window.
        const wrongCode = await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .set('X-Forwarded-For', '203.0.113.10')
          .send({ usernameOrEmail: 'twofactor', password: PASSWORD, totpCode: '000000' });
        expect([wrongCode.status, wrongCode.body.code]).toEqual([401, 'invalid_totp_code']);

        expect(await loginEvents(db, 'user:twofactor')).toHaveLength(2);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('per-IP throttling', () => {
  it('stops one host spraying one password across many accounts at thirty', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        // 31 distinct usernames from one IP: the per-username window (10) is
        // never reached, so only the per-IP one can refuse.
        for (let i = 0; i < 30; i++) {
          const res = await attempt(app, `victim-${String(i)}`, { ip: '203.0.113.55' });
          expect([i, res.status]).toEqual([i, 401]);
        }
        const refused = await attempt(app, 'victim-30', { ip: '203.0.113.55' });
        expect([refused.status, refused.body.code]).toEqual([429, 'login_rate_limited']);
        expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);

        // A different host is unaffected — the window is per address, not global.
        const elsewhere = await attempt(app, 'victim-30', { ip: '203.0.113.56' });
        expect(elsewhere.status).toBe(401);
        expect(await loginEvents(db, 'ip:203.0.113.55')).toHaveLength(30);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('takes the FIRST X-Forwarded-For hop, so a client cannot mint a fresh address', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        // Caddy prepends the real client; everything after is client-supplied.
        // Reading the last (or the whole list) would make each of these a
        // different key.
        for (let i = 0; i < 3; i++) {
          await request(app.getHttpServer())
            .post('/api/v1/auth/login')
            .set('X-Forwarded-For', `203.0.113.77, 10.0.0.${String(i)}`)
            .send({ usernameOrEmail: `spray-${String(i)}`, password: 'nope-not-this-one' });
        }
        expect(await loginEvents(db, 'ip:203.0.113.77')).toHaveLength(3);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
