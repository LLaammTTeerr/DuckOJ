/**
 * D57 — the two preferences the server holds for a reader, and what `null`
 * means in each of them.
 *
 * `users.locale` and `users.timezone` carried `NOT NULL DEFAULT 'vi' /
 * 'Asia/Ho_Chi_Minh'` until 0023, and with a default there is no such thing
 * as "the reader has not chosen": every account looked exactly like one that
 * had asked for Vietnamese and ICT. This file pins the distinction, and the
 * one place on the server that reads it — the mail that goes to somebody who
 * cannot sign in to change it.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import { schema } from '@duckoj/db';
import { MeResponse } from '@duckoj/contracts';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin } from './submissions.fixtures.js';
import { MAILER, type LogMailer } from '../src/mail/mailer.js';
import { emailVerificationMail, passwordResetMail, resolveMailLocale } from '../src/mail/templates.js';

function mailerOf(app: INestApplication): LogMailer {
  return app.get<LogMailer>(MAILER);
}

describe('a preference nobody has set', () => {
  it('is null on a fresh account, and a set one round-trips and clears', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'settings-user');

        // NOT 'vi', and not the server's zone: a fresh account has chosen
        // nothing, and the web must be free to keep resolving the locale
        // from `navigator.language` (D18).
        const fresh = MeResponse.parse((await agent.get('/api/v1/auth/me')).body);
        expect([fresh.locale, fresh.timezone]).toEqual([null, null]);

        expect((await agent.patch('/api/v1/users/me').send({ locale: 'en', timezone: 'Europe/Paris' })).status).toBe(200);
        const set = MeResponse.parse((await agent.get('/api/v1/auth/me')).body);
        expect([set.locale, set.timezone]).toEqual(['en', 'Europe/Paris']);

        // `null` is a real value and a different one from absent: it CLEARS.
        expect((await agent.patch('/api/v1/users/me').send({ locale: null })).status).toBe(200);
        const cleared = MeResponse.parse((await agent.get('/api/v1/auth/me')).body);
        expect([cleared.locale, cleared.timezone]).toEqual([null, 'Europe/Paris']);

        // …and absent still means keep, which is the property the whole
        // PATCH shape rests on.
        expect((await agent.patch('/api/v1/users/me').send({ displayName: 'Renamed' })).status).toBe(200);
        expect(MeResponse.parse((await agent.get('/api/v1/auth/me')).body).timezone).toBe('Europe/Paris');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('still refuses a value neither Intl can resolve', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'settings-bad');
        expect((await agent.patch('/api/v1/users/me').send({ timezone: 'Mars/Olympus' })).status).toBe(422);
        expect((await agent.patch('/api/v1/users/me').send({ locale: '!!' })).status).toBe(422);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('the language a mail is written in', () => {
  it('resolves from the stored tag, by prefix, with null meaning Vietnamese', () => {
    expect([
      resolveMailLocale(null),
      resolveMailLocale('vi'),
      resolveMailLocale('en'),
      resolveMailLocale('en-GB'),
      resolveMailLocale('EN'),
      // A tag this build has no words for is Vietnamese, not a half
      // translated message: `vi` is the default of a Vietnamese judge (D18).
      resolveMailLocale('fr'),
    ]).toEqual(['vi', 'vi', 'en', 'en', 'en', 'vi']);
  });

  it('says the same thing in both, and carries the link and the expiry in each', () => {
    for (const build of [
      (l: 'vi' | 'en') => passwordResetMail(l, { url: 'https://oj/x?token=T', ttlMinutes: 60 }),
      (l: 'vi' | 'en') => emailVerificationMail(l, { url: 'https://oj/x?token=T', ttlHours: 24 }),
    ]) {
      const vi = build('vi');
      const en = build('en');
      expect(vi.subject).not.toBe(en.subject);
      for (const mail of [vi, en]) {
        expect(mail.text).toContain('https://oj/x?token=T');
        expect(mail.text).toMatch(/\b(60|24)\b/);
      }
    }
  });

  it('sends the reset in the reader’s own language, and Vietnamese to somebody who never chose', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const viAgent = request.agent(app.getHttpServer());
        await registerAndLogin(viAgent, 'mail-vi');
        const enAgent = request.agent(app.getHttpServer());
        await registerAndLogin(enAgent, 'mail-en');
        await db
          .update(schema.users)
          .set({ locale: 'en-GB' })
          .where(eq(schema.users.username, 'mail-en'));

        await request(app.getHttpServer())
          .post('/api/v1/auth/password/forgot')
          .send({ email: 'mail-vi@example.com' });
        expect(mailerOf(app).sent.at(-1)!.subject).toBe('Đặt lại mật khẩu DuckOJ của bạn');

        await request(app.getHttpServer())
          .post('/api/v1/auth/password/forgot')
          .send({ email: 'mail-en@example.com' });
        expect(mailerOf(app).sent.at(-1)!.subject).toBe('Reset your DuckOJ password');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
