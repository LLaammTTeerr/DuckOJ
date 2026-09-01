/**
 * Three lookup defects from the 2026-08 sweep, pinned. The recovery one is
 * the cruel one: anyone who registered with a capital letter in their email
 * could log in forever and never receive a password-reset mail.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { insertUser, registerAndLogin } from './submissions.fixtures.js';
import { MAILER, type LogMailer } from '../src/mail/mailer.js';
import { passwordResetMail } from '../src/mail/templates.js';

/**
 * The reset mail, in whichever language it went out in (D57). Matched on the
 * subject built by `passwordResetMail` rather than on the English word
 * "Reset", which stopped identifying it the moment the default became
 * Vietnamese.
 */
function resetMailsOf(app: INestApplication) {
  const subjects = new Set(
    (['vi', 'en'] as const).map(
      (locale) => passwordResetMail(locale, { url: '', ttlMinutes: 0 }).subject,
    ),
  );
  return app.get<LogMailer>(MAILER).sent.filter((m) => subjects.has(m.subject));
}

describe('password reset finds mixed-case emails', () => {
  it('a user registered as MixedCase@e.com gets a reset mail for mixedcase@e.com', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await request(app.getHttpServer()).post('/api/v1/auth/register').send({
          username: 'mixed',
          email: 'MixedCase@Example.com',
          password: 'a-long-enough-password',
          displayName: 'Mixed',
        });
        await request(app.getHttpServer())
          .post('/api/v1/auth/password/forgot')
          .send({ email: 'mixedcase@example.com' })
          .expect(202);
        expect(resetMailsOf(app)).toHaveLength(1);
        expect(resetMailsOf(app)[0]!.to).toBe('MixedCase@Example.com');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

/**
 * Signed in, since D188: `GET /users` is no longer `@Public()`. The input
 * handling under test is the same, and asking it as an actor is what a real
 * caller does — the ONE thing that had to be kept is the order of the two
 * refusals, since a malformed cursor must still be a 422 rather than being
 * swallowed by the walk meter's 429.
 */
describe('user list input handling', () => {
  it('rejects garbage and negative cursors with the sibling 422 invalid_cursor', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'nguoi-tra-cuu');
        for (const cursor of ['12abc', '-5', 'abc']) {
          const res = await agent.get(`/api/v1/users?cursor=${cursor}`);
          expect(res.status, `cursor=${cursor}`).toBe(422);
          expect(res.body.code, `cursor=${cursor}`).toBe('invalid_cursor');
        }
        await agent.get('/api/v1/users?cursor=0').expect(200);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('treats % and _ in the search as literals, not wildcards', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'nguoi-go-phan-tram');
        await insertUser(db, 'abc');
        await insertUser(db, 'axc');
        const all = await agent.get('/api/v1/users?q=%25').expect(200);
        expect(all.body.items).toEqual([]);
        const underscore = await agent.get('/api/v1/users?q=a_c').expect(200);
        expect(underscore.body.items).toEqual([]);
        const literal = await agent.get('/api/v1/users?q=ab').expect(200);
        expect(literal.body.items.map((u: { username: string }) => u.username)).toEqual(['abc']);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
