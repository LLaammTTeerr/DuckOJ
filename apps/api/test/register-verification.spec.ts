/**
 * Registration must kick off email verification on its own: the machinery
 * (token mint, mail, redeem route) predates this suite, but nothing invoked
 * it at signup, so `emailVerifiedAt` stayed null unless the user found the
 * resend endpoint by hand.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { MAILER, type LogMailer, type Mailer, type OutboundEmail } from '../src/mail/mailer.js';

const REGISTRATION = {
  username: 'newbie',
  email: 'newbie@example.com',
  password: 'a-long-enough-password',
  displayName: 'Newbie',
};

function mailerOf(app: INestApplication): LogMailer {
  return app.get<LogMailer>(MAILER);
}

describe('POST /auth/register sends the verification mail', () => {
  it('sends exactly one mail, to the registered address, with a /verify-email link', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const res = await request(app.getHttpServer()).post('/auth/register').send(REGISTRATION);
        expect(res.status).toBe(201);

        const sent = mailerOf(app).sent;
        expect(sent).toHaveLength(1);
        expect(sent[0]!.to).toBe('newbie@example.com');
        expect(sent[0]!.text).toMatch(/\/verify-email\?token=[A-Za-z0-9_-]+/);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('redeeming the mailed token over HTTP flips emailVerified on /auth/me', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await agent.post('/auth/register').send(REGISTRATION).expect(201);
        await agent
          .post('/auth/login')
          .send({ usernameOrEmail: 'newbie', password: REGISTRATION.password })
          .expect(200);
        expect((await agent.get('/auth/me')).body.emailVerified).toBe(false);

        const mail = mailerOf(app).sent.at(0);
        if (!mail) throw new Error('registration sent no mail');
        const token = /token=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1];
        if (!token) throw new Error(`no token in mail: ${mail.text}`);

        await request(app.getHttpServer()).post('/auth/email/verify').send({ token }).expect(200);
        expect((await agent.get('/auth/me')).body.emailVerified).toBe(true);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('still answers 201 when the mailer is down — mail is best-effort', async () => {
    const brokenMailer: Mailer = {
      kind: 'log',
      send(_message: OutboundEmail): Promise<void> {
        return Promise.reject(new Error('smtp connection refused'));
      },
    };
    await withTestDb(async (db) => {
      const app = await buildApp(db, {
        overrides: [{ provide: MAILER, useValue: brokenMailer }],
      });
      try {
        const res = await request(app.getHttpServer()).post('/auth/register').send(REGISTRATION);
        expect(res.status).toBe(201);
        expect(res.body.username).toBe('newbie');
        // …and the account is genuinely usable, not half-created.
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ usernameOrEmail: 'newbie', password: REGISTRATION.password })
          .expect(200);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
