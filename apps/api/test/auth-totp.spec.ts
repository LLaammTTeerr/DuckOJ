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

describe('POST /auth/totp/begin against an already-confirmed credential (D33)', () => {
  it('refuses rather than silently un-enrolling the account', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await agent.post('/auth/register').send({
          username: 'rhea',
          email: 'rhea@example.com',
          password: 'a-long-enough-password',
          displayName: 'Rhea',
        });
        await agent
          .post('/auth/login')
          .send({ usernameOrEmail: 'rhea', password: 'a-long-enough-password' });
        const secret = (await agent.post('/auth/totp/begin')).body.secret as string;
        await agent.post('/auth/totp/confirm').send({ code: authenticator.generate(secret) });
        expect((await agent.get('/auth/me')).body.totpEnabled).toBe(true);

        // The upsert used to replace the secret and null `confirmedAt`, so
        // one unauthenticated-by-code POST turned the second factor off.
        const again = await agent.post('/auth/totp/begin');
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('totp_already_enabled');

        // Still on, and still the SAME secret: a refusal that had already
        // overwritten the credential would pass the assertion above and
        // still have locked the user's authenticator out.
        expect((await agent.get('/auth/me')).body.totpEnabled).toBe(true);
        const passwordOnly = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ usernameOrEmail: 'rhea', password: 'a-long-enough-password' });
        expect(passwordOnly.status).toBe(401);
        expect(passwordOnly.body.code).toBe('totp_required');
        expect(
          (
            await request(app.getHttpServer()).post('/auth/login').send({
              usernameOrEmail: 'rhea',
              password: 'a-long-enough-password',
              totpCode: authenticator.generate(secret),
            })
          ).status,
        ).toBe(200);

        // Re-enrolling is still possible; it just has to say so out loud.
        expect((await agent.delete('/auth/totp')).status).toBe(204);
        expect((await agent.post('/auth/totp/begin')).status).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
