import { authenticator } from '@otplib/preset-default';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';

describe('login gate: totp', () => {
  it('requires, rejects a wrong code for, and accepts a correct code against a confirmed credential', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const setupAgent = request.agent(app.getHttpServer());
        await setupAgent.post('/auth/register').send({
          username: 'quinn',
          email: 'quinn@example.com',
          password: 'a-long-enough-password',
          displayName: 'Quinn',
        });
        await setupAgent
          .post('/auth/login')
          .send({ usernameOrEmail: 'quinn', password: 'a-long-enough-password' });

        const begin = await setupAgent.post('/auth/totp/begin');
        expect(begin.status).toBe(200);
        const secret = begin.body.secret as string;

        const confirm = await setupAgent
          .post('/auth/totp/confirm')
          .send({ code: authenticator.generate(secret) });
        expect(confirm.status).toBe(204);

        const noCode = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ usernameOrEmail: 'quinn', password: 'a-long-enough-password' });
        expect(noCode.status).toBe(401);
        expect(noCode.body.code).toBe('totp_required');

        const wrongCode = await request(app.getHttpServer())
          .post('/auth/login')
          .send({
            usernameOrEmail: 'quinn',
            password: 'a-long-enough-password',
            totpCode: '000000',
          });
        expect(wrongCode.status).toBe(401);
        expect(wrongCode.body.code).toBe('invalid_totp_code');

        const rightCode = await request(app.getHttpServer())
          .post('/auth/login')
          .send({
            usernameOrEmail: 'quinn',
            password: 'a-long-enough-password',
            totpCode: authenticator.generate(secret),
          });
        expect(rightCode.status).toBe(200);
        expect(rightCode.body.user.totpEnabled).toBe(true);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
