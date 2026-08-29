/**
 * D39 — TOTP recovery codes, end to end over HTTP.
 *
 * Everything here runs against a real Postgres (`withTestDb`) and the real
 * module graph (`buildApp`), because the whole feature is about what is in
 * the `totp_recovery_codes` table and what the login route does with it —
 * neither of which a mocked service can be wrong about in the same way.
 */
import { authenticator } from '@otplib/preset-default';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { schema, type Db } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';

const PASSWORD = 'a-long-enough-password';

/** `xxxxx-xxxxx` over the Crockford-ish alphabet the service generates from. */
const CODE_SHAPE = /^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/;

/** Registers, signs in, enrols in 2FA, and answers with the codes it was handed. */
async function enrol(
  app: INestApplication,
  username: string,
): Promise<{ agent: ReturnType<typeof request.agent>; secret: string; codes: string[] }> {
  const agent = request.agent(app.getHttpServer());
  await agent
    .post('/auth/register')
    .send({ username, email: `${username}@example.com`, password: PASSWORD, displayName: username });
  await agent.post('/auth/login').send({ usernameOrEmail: username, password: PASSWORD });
  const secret = (await agent.post('/auth/totp/begin')).body.secret as string;
  const confirm = await agent
    .post('/auth/totp/confirm')
    .send({ code: authenticator.generate(secret) });
  expect(confirm.status).toBe(200);
  return { agent, secret, codes: confirm.body.recoveryCodes as string[] };
}

function login(app: INestApplication, username: string, body: Record<string, unknown>) {
  return request(app.getHttpServer())
    .post('/auth/login')
    .send({ usernameOrEmail: username, password: PASSWORD, ...body });
}

async function userIdOf(db: Db, username: string): Promise<number> {
  const [row] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username));
  return row!.id;
}

describe('recovery codes are issued once, by confirm (D39)', () => {
  it('returns eight formatted codes and stores only their hashes', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const { codes } = await enrol(app, 'rcalpha');
        expect(codes).toHaveLength(8);
        for (const code of codes) expect(code).toMatch(CODE_SHAPE);
        expect(new Set(codes).size).toBe(8);

        const userId = await userIdOf(db, 'rcalpha');
        const rows = await db
          .select()
          .from(schema.totpRecoveryCodes)
          .where(eq(schema.totpRecoveryCodes.userId, userId));
        expect(rows).toHaveLength(8);
        expect(rows.every((r) => r.usedAt === null)).toBe(true);
        // The plaintext must not survive anywhere in the row: a database leak
        // that handed over eight working second factors would make the whole
        // hashing exercise decorative.
        const stored = rows.map((r) => r.codeHash);
        for (const code of codes) {
          expect(stored).not.toContain(code);
          expect(stored).not.toContain(code.replace('-', ''));
        }
        expect(stored.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('reports the remaining count on GET /auth/me, and decrements it as codes are spent', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const { agent, codes } = await enrol(app, 'rcbeta');
        expect((await agent.get('/auth/me')).body.recoveryCodesRemaining).toBe(8);

        const used = await login(app, 'rcbeta', { recoveryCode: codes[0] });
        expect(used.status).toBe(200);
        expect(used.body.user.recoveryCodesRemaining).toBe(7);
        expect((await agent.get('/auth/me')).body.recoveryCodesRemaining).toBe(7);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('a recovery code signs in exactly once (D39)', () => {
  it('is accepted, then refused as invalid_totp_code on the replay', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const { codes } = await enrol(app, 'rcgamma');

        // No second factor at all is still `totp_required` — the recovery
        // code is an alternative to the TOTP code, not a way around needing
        // one.
        expect((await login(app, 'rcgamma', {})).body.code).toBe('totp_required');

        const first = await login(app, 'rcgamma', { recoveryCode: codes[0] });
        expect(first.status).toBe(200);

        // Single use. A printout photographed on someone's desk is worth one
        // sign-in, not one per code per lifetime.
        const replay = await login(app, 'rcgamma', { recoveryCode: codes[0] });
        expect(replay.status).toBe(401);
        expect(replay.body.code).toBe('invalid_totp_code');

        // A different code from the same set still works.
        expect((await login(app, 'rcgamma', { recoveryCode: codes[1] })).status).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('accepts a code typed without its dash, in lowercase, with stray spaces', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const { codes } = await enrol(app, 'rcdelta');
        const messy = ` ${codes[0]!.replace('-', '').toLowerCase()} `;
        expect((await login(app, 'rcdelta', { recoveryCode: messy })).status).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses an unknown code, and the attempt counts toward D16\'s window', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await enrol(app, 'rcepsilon');
        const before = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.rateEvents)
          .where(
            and(eq(schema.rateEvents.purpose, 'login'), eq(schema.rateEvents.key, 'user:rcepsilon')),
          );

        const bad = await login(app, 'rcepsilon', { recoveryCode: 'ZZZZZ-ZZZZZ' });
        expect(bad.status).toBe(401);
        expect(bad.body.code).toBe('invalid_totp_code');

        const after = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.rateEvents)
          .where(
            and(eq(schema.rateEvents.purpose, 'login'), eq(schema.rateEvents.key, 'user:rcepsilon')),
          );
        // Otherwise the eight-code surface is an unmetered guessing target
        // sitting beside a metered one.
        expect(after[0]!.n).toBe(before[0]!.n + 1);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('spends exactly one code when the same one arrives twice at once', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const { codes } = await enrol(app, 'rczeta');
        // The defining case: a relay forwards the victim's code at the
        // instant the victim submits it. Exactly one of the two may win.
        const [a, b] = await Promise.all([
          login(app, 'rczeta', { recoveryCode: codes[0] }),
          login(app, 'rczeta', { recoveryCode: codes[0] }),
        ]);
        expect([a.status, b.status].sort()).toEqual([200, 401]);

        const userId = await userIdOf(db, 'rczeta');
        const live = await db
          .select()
          .from(schema.totpRecoveryCodes)
          .where(
            and(
              eq(schema.totpRecoveryCodes.userId, userId),
              isNull(schema.totpRecoveryCodes.usedAt),
            ),
          );
        expect(live).toHaveLength(7);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('notifies the holder when the last code goes', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const { agent, codes } = await enrol(app, 'rceta');
        for (const code of codes.slice(0, 7)) {
          expect((await login(app, 'rceta', { recoveryCode: code })).status).toBe(200);
        }
        // Seven spent, one left: nothing to say yet.
        expect((await agent.get('/notifications')).body.items).toHaveLength(0);

        expect((await login(app, 'rceta', { recoveryCode: codes[7] })).status).toBe(200);
        const feed = await agent.get('/notifications');
        expect(feed.body.items[0].kind).toBe('totp_recovery_codes_exhausted');
        expect((await agent.get('/auth/me')).body.recoveryCodesRemaining).toBe(0);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('regenerating the set (D39)', () => {
  it('replaces every code and kills the old ones', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const { agent, secret, codes } = await enrol(app, 'rctheta');
        const again = await agent
          .post('/auth/totp/recovery/regenerate')
          .send({ code: authenticator.generate(secret) });
        expect(again.status).toBe(200);
        const fresh = again.body.recoveryCodes as string[];
        expect(fresh).toHaveLength(8);
        expect(fresh.filter((c) => codes.includes(c))).toEqual([]);
        expect((await agent.get('/auth/me')).body.recoveryCodesRemaining).toBe(8);

        // A printout the user regenerated *because* they thought it was
        // compromised must stop working the moment they do it.
        const old = await login(app, 'rctheta', { recoveryCode: codes[0] });
        expect(old.status).toBe(401);
        expect((await login(app, 'rctheta', { recoveryCode: fresh[0] })).status).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses a wrong code, and refuses outright when 2FA is off', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const { agent } = await enrol(app, 'rciota');
        const wrong = await agent.post('/auth/totp/recovery/regenerate').send({ code: '000000' });
        expect(wrong.status).toBe(422);
        expect(wrong.body.code).toBe('invalid_totp_enrolment_code');

        const plain = request.agent(app.getHttpServer());
        await plain.post('/auth/register').send({
          username: 'rckappa',
          email: 'rckappa@example.com',
          password: PASSWORD,
          displayName: 'rckappa',
        });
        await plain.post('/auth/login').send({ usernameOrEmail: 'rckappa', password: PASSWORD });
        // `TotpService.verify` fails OPEN for an unenrolled account, so
        // without the `isEnabled` gate any session could mint eight standing
        // sign-in credentials by posting six arbitrary digits.
        const none = await plain.post('/auth/totp/recovery/regenerate').send({ code: '000000' });
        expect(none.status).toBe(409);
        expect(none.body.code).toBe('totp_not_enabled');
        const userId = await userIdOf(db, 'rckappa');
        const rows = await db
          .select()
          .from(schema.totpRecoveryCodes)
          .where(eq(schema.totpRecoveryCodes.userId, userId));
        expect(rows).toEqual([]);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('turning 2FA off takes the codes with it (D39)', () => {
  it('leaves no rows behind, so a re-enrolment cannot inherit a stale printout', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const { agent, codes } = await enrol(app, 'rclambda');
        expect((await agent.delete('/auth/totp')).status).toBe(204);

        const userId = await userIdOf(db, 'rclambda');
        const rows = await db
          .select()
          .from(schema.totpRecoveryCodes)
          .where(eq(schema.totpRecoveryCodes.userId, userId));
        expect(rows).toEqual([]);
        expect((await agent.get('/auth/me')).body.recoveryCodesRemaining).toBe(0);

        // With 2FA off the password alone signs in, and the old code buys
        // nothing extra — but the row it would have matched is gone, which is
        // what matters once the account re-enrols.
        const secret = (await agent.post('/auth/totp/begin')).body.secret as string;
        await agent.post('/auth/totp/confirm').send({ code: authenticator.generate(secret) });
        expect((await login(app, 'rclambda', { recoveryCode: codes[0] })).status).toBe(401);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
