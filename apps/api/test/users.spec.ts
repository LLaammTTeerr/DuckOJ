/**
 * Phase 3d — user profiles.
 *
 * Two properties carry this suite: what the profile never says (§3), and that
 * its statistics mean the same thing to every reader (§4). Both are the kind
 * of rule that passes by accident in a fixture where everything is public,
 * which is why the corpus below deliberately is not.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import { UserPage, UserProfile } from '@duckoj/contracts';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import {
  insertGradedSubmission,
  registerAndLogin,
  seedProblemAndLanguage,
  seedProblemWithSourceAccess,
  userIdOf,
} from './submissions.fixtures.js';

/** Fields that must never reach any user-facing response. */
const NEVER_PUBLIC = ['email', 'status', 'passwordHash', 'password_hash', 'timezone', 'locale'];

function assertNothingLeaked(body: unknown, what: string): void {
  const serialised = JSON.stringify(body);
  for (const field of NEVER_PUBLIC) {
    expect(serialised, `${what} must not contain ${field}`).not.toContain(`"${field}"`);
  }
}

/**
 * A user with one AC on a public problem, one AC on a *private* one, and a
 * partial score they later beat.
 *
 * The private solve is the whole fixture: with every problem public, a query
 * that forgot the visibility filter returns the same numbers (§7).
 */
async function seedCorpus(db: Db) {
  await seedProblemAndLanguage(db);
  const pub = await seedProblemWithSourceAccess(db, { code: 'pub-p', visibility: 'public' });
  const priv = await seedProblemWithSourceAccess(db, { code: 'priv-p', visibility: 'private' });
  const other = await seedProblemWithSourceAccess(db, { code: 'pub-q', visibility: 'public' });
  return { pub, priv, other };
}

describe('GET /users/:username', () => {
  it('never returns email, status, timezone or locale', async () => {
    await withTestDb(async (db) => {
      await seedCorpus(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'profiled');

        const res = await request(app.getHttpServer()).get('/api/v1/users/profiled');
        expect(res.status).toBe(200);
        // Asserted over the whole serialised body, not field by field, so a
        // column added to the query later is caught without editing this test.
        assertNothingLeaked(res.body, 'the profile');
        expect(UserProfile.safeParse(res.body).success).toBe(true);
        // Even when the caller IS the user — `GET /auth/me` is where your own
        // private fields live, not here.
        assertNothingLeaked((await agent.get('/api/v1/users/profiled')).body, 'your own profile');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('counts public problems only, and reports the same numbers to everyone', async () => {
    await withTestDb(async (db) => {
      const { pub, priv } = await seedCorpus(db);
      const app = await buildApp(db);
      try {
        const owner = request.agent(app.getHttpServer());
        await registerAndLogin(owner, 'solver');
        const solverId = await userIdOf(db, 'solver');
        const admin = request.agent(app.getHttpServer());
        await registerAndLogin(admin, 'nosy');
        await db
          .update(schema.users)
          .set({ globalRole: 'admin' })
          .where(eq(schema.users.username, 'nosy'));

        await insertGradedSubmission(db, {
          userId: solverId,
          problemId: pub.id,
          verdict: 'AC',
          points: 100,
          maxPoints: 100,
        });
        await insertGradedSubmission(db, {
          userId: solverId,
          problemId: priv.id,
          verdict: 'AC',
          points: 100,
          maxPoints: 100,
        });

        const anon = await request(app.getHttpServer()).get('/api/v1/users/solver');
        const mine = await owner.get('/api/v1/users/solver');
        const asAdmin = await admin.get('/api/v1/users/solver');

        // One, not two: the private solve does not count for anyone — not even
        // for the solver, and not even for an admin who may see the problem.
        // Equality across the three readers is what "viewer-independent" means,
        // and it is the assertion, not a coincidence of the fixture.
        for (const [who, res] of [['anon', anon], ['owner', mine], ['admin', asAdmin]] as const) {
          expect(res.status, who).toBe(200);
          expect(res.body.stats.solvedCount, `${who}: solvedCount`).toBe(1);
          expect(res.body.stats.points, `${who}: points`).toBe(100);
          expect(res.body.stats.submissionCount, `${who}: submissionCount`).toBe(1);
        }
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('scores the best submission per problem, not the sum of every attempt', async () => {
    await withTestDb(async (db) => {
      const { pub, other } = await seedCorpus(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'improver');
        const id = await userIdOf(db, 'improver');

        // Three attempts on one problem: 30, then 80, then 50. A sum would be
        // 160 and would reward resubmitting; the answer is 80.
        for (const points of [30, 80, 50]) {
          await insertGradedSubmission(db, {
            userId: id,
            problemId: pub.id,
            verdict: 'WA',
            points,
            maxPoints: 100,
          });
        }
        await insertGradedSubmission(db, {
          userId: id,
          problemId: other.id,
          verdict: 'AC',
          points: 100,
          maxPoints: 100,
        });

        const res = await request(app.getHttpServer()).get('/api/v1/users/improver');
        expect(res.body.stats.points).toBe(180);
        expect(res.body.stats.submissionCount).toBe(4);
        // Only the AC counts as solved — scoring 80 is not solving.
        expect(res.body.stats.solvedCount).toBe(1);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('still resolves a suspended account, without saying it is suspended', async () => {
    await withTestDb(async (db) => {
      await seedCorpus(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'banned');
        await db
          .update(schema.users)
          .set({ status: 'suspended' })
          .where(eq(schema.users.username, 'banned'));

        // A 404 here would turn this route into an oracle for who has been
        // suspended — exactly what keeping `status` private is meant to stop.
        const res = await request(app.getHttpServer()).get('/api/v1/users/banned');
        expect(res.status).toBe(200);
        assertNothingLeaked(res.body, 'a suspended profile');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('404s an unknown username and matches case-insensitively', async () => {
    await withTestDb(async (db) => {
      await seedCorpus(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'mixedcase');
        expect((await request(app.getHttpServer()).get('/api/v1/users/MiXeDcAsE')).status).toBe(200);
        expect((await request(app.getHttpServer()).get('/api/v1/users/nobody')).status).toBe(404);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('GET /users', () => {
  it('matches a prefix, not a substring, and paginates', async () => {
    await withTestDb(async (db) => {
      await seedCorpus(db);
      const app = await buildApp(db);
      try {
        for (const name of ['alpha1', 'alpha2', 'alpha3', 'beta1']) {
          await registerAndLogin(request.agent(app.getHttpServer()), name);
        }

        const hit = await request(app.getHttpServer()).get('/api/v1/users').query({ q: 'alpha' });
        expect(hit.status).toBe(200);
        expect(UserPage.safeParse(hit.body).success).toBe(true);
        expect((hit.body.items as { username: string }[]).map((u) => u.username).sort()).toEqual([
          'alpha1',
          'alpha2',
          'alpha3',
        ]);
        assertNothingLeaked(hit.body, 'the user list');

        // `lpha` is a substring of every alpha* name and must match none of
        // them: a substring search cannot use the username index.
        const substring = await request(app.getHttpServer()).get('/api/v1/users').query({ q: 'lpha' });
        expect(substring.body.items).toHaveLength(0);

        const paged = await request(app.getHttpServer()).get('/api/v1/users').query({ q: 'alpha', limit: 2 });
        expect(paged.body.items).toHaveLength(2);
        expect(paged.body.nextCursor).not.toBeNull();
        const next = await request(app.getHttpServer())
          .get('/api/v1/users')
          .query({ q: 'alpha', limit: 2, cursor: paged.body.nextCursor });
        expect(next.body.items).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('PATCH /users/me', () => {
  it('updates what you own and refuses what you do not', async () => {
    await withTestDb(async (db) => {
      await seedCorpus(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'editor');

        const ok = await agent.patch('/api/v1/users/me').send({ displayName: 'Renamed', about: 'hi' });
        expect(ok.status).toBe(200);
        expect(ok.body.displayName).toBe('Renamed');
        expect(ok.body.about).toBe('hi');

        // `.strict()` — rejected, not silently dropped. A request that looks
        // like it worked and did not is worse than a 422.
        for (const forbidden of [
          { username: 'someoneelse' },
          { email: 'new@example.com' },
          { globalRole: 'admin' },
          { rating: 3000 },
        ]) {
          const res = await agent.patch('/api/v1/users/me').send(forbidden);
          expect(res.status, JSON.stringify(forbidden)).toBe(422);
        }
        // …and nothing changed as a side effect of those attempts.
        const after = await request(app.getHttpServer()).get('/api/v1/users/editor');
        expect(after.body.username).toBe('editor');
        expect(after.body.globalRole).toBe('user');
        expect(after.body.rating).toBeNull();
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses a timezone or locale the platform cannot resolve', async () => {
    await withTestDb(async (db) => {
      await seedCorpus(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'settler');

        // Both columns are preferences the server will one day format times
        // and messages with. Stored unchecked, the first thing that hands
        // `timezone` to `Intl.DateTimeFormat` throws a RangeError on a row
        // its owner typed months earlier — a 500 with no path back to the
        // request that caused it. Refused at the boundary instead.
        for (const junk of [
          { timezone: 'Not/AZone' },
          { timezone: 'definitely not a zone' },
          { locale: 'not a locale' },
          { locale: 'e n' },
        ]) {
          const res = await agent.patch('/api/v1/users/me').send(junk);
          expect(res.status, JSON.stringify(junk)).toBe(422);
          expect(res.body.code).toBe('validation_failed');
        }

        // Real values still work, so this is not passing by refusing
        // everything — including a zone that is not the Vietnamese default.
        expect((await agent.patch('/api/v1/users/me').send({ timezone: 'Europe/Paris' })).status).toBe(200);
        expect((await agent.patch('/api/v1/users/me').send({ locale: 'en' })).status).toBe(200);
        const [row] = await db
          .select({ tz: schema.users.timezone, locale: schema.users.locale })
          .from(schema.users)
          .where(eq(schema.users.username, 'settler'));
        expect(row).toEqual({ tz: 'Europe/Paris', locale: 'en' });
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('requires a signed-in caller', async () => {
    await withTestDb(async (db) => {
      await seedCorpus(db);
      const app = await buildApp(db);
      try {
        const res = await request(app.getHttpServer())
          .patch('/api/v1/users/me')
          .send({ displayName: 'anon' });
        expect(res.status).toBe(401);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

/**
 * Probed against the live stack: `PATCH /users/me {"displayName":"   "}`
 * answered 200 and `GET /users/bh7-uni1` came back with
 * `"displayName":"   "` — a name that renders as nothing at all wherever it
 * is rendered. `z.string().min(1)` is satisfied by three spaces.
 */
describe('PATCH /users/me — a display name is a name', () => {
  it('refuses a whitespace-only display name, and trims the one it accepts', async () => {
    await withTestDb(async (db) => {
      await seedCorpus(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'namer');

        for (const blank of ['   ', '\t', '\n\n']) {
          const res = await agent.patch('/api/v1/users/me').send({ displayName: blank });
          expect(res.status, JSON.stringify(blank)).toBe(422);
          expect(res.body.code).toBe('validation_failed');
        }

        const ok = await agent.patch('/api/v1/users/me').send({ displayName: '  Đặng Thị Ánh  ' });
        expect(ok.status).toBe(200);
        // Trimmed, not merely accepted: the padding is invisible where the
        // name is shown, and it is what lets two accounts wear one name.
        expect(ok.body.displayName).toBe('Đặng Thị Ánh');
        const [row] = await db
          .select({ displayName: schema.users.displayName })
          .from(schema.users)
          .where(eq(schema.users.username, 'namer'));
        expect(row?.displayName).toBe('Đặng Thị Ánh');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses the same blank name at registration, where the rule used to differ', async () => {
    await withTestDb(async (db) => {
      await seedCorpus(db);
      const app = await buildApp(db);
      try {
        const res = await request(app.getHttpServer()).post('/api/v1/auth/register').send({
          username: 'blankname',
          email: 'blankname@example.com',
          password: 'Str0ngPassw0rd!x',
          displayName: '   ',
        });
        expect(res.status).toBe(422);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
