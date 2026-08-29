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
        expect(confirm.status).toBe(200);

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

/** The 30-second TOTP step, so a test can avoid straddling a boundary. */
const STEP_MS = 30_000;

/**
 * Waits, if necessary, until there is a comfortable margin left in the
 * current step. Without this, a code generated for step N can be presented
 * after the clock has rolled to N+1 and the assertions below would be about
 * a different thing than they claim — and would fail perhaps one run in a
 * few hundred, which is worse than a slow test.
 */
async function settleInsideAStep(): Promise<void> {
  const remaining = STEP_MS - (Date.now() % STEP_MS);
  if (remaining > 8_000) return;
  await new Promise((resolve) => setTimeout(resolve, remaining + 250));
}

describe('a TOTP code is single-use (D34)', () => {
  it('accepts a code once and refuses the replay, while a different code still works', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await agent.post('/auth/register').send({
          username: 'seren',
          email: 'seren@example.com',
          password: 'a-long-enough-password',
          displayName: 'Seren',
        });
        await agent
          .post('/auth/login')
          .send({ usernameOrEmail: 'seren', password: 'a-long-enough-password' });
        const secret = (await agent.post('/auth/totp/begin')).body.secret as string;
        await agent.post('/auth/totp/confirm').send({ code: authenticator.generate(secret) });

        await settleInsideAStep();
        // Two codes that are both valid right now: the current step and the
        // one before it, which `window: [1, 0]` accepts. Using the previous
        // step first means the replay and the follow-up sign-in can be
        // asserted without waiting thirty seconds for a fresh code.
        const previous = authenticator.clone({ epoch: Date.now() - STEP_MS }).generate(secret);
        const current = authenticator.generate(secret);
        // A collision is ~1 in 10^6 and would make the last assertion a lie.
        expect(previous).not.toEqual(current);

        const login = (totpCode: string) =>
          request(app.getHttpServer())
            .post('/auth/login')
            .send({ usernameOrEmail: 'seren', password: 'a-long-enough-password', totpCode });

        expect((await login(previous)).status).toBe(200);

        // RFC 6238 §5.2: the verifier must not accept the same OTP twice.
        // Anyone who reads a code over the victim's shoulder, off a phishing
        // relay, or out of a proxied form has the rest of the step to use it
        // — a full second sign-in from one interception.
        const replay = await login(previous);
        expect(replay.status).toBe(401);
        expect(replay.body.code).toBe('invalid_totp_code');

        // …and the guard is per code, not "one sign-in per minute": the
        // account is not locked out of its own second factor.
        expect((await login(current)).status).toBe(200);
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
