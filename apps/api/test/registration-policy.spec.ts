/**
 * D200 — a school judge decides who may sign up, and the default is that
 * nobody may.
 *
 * The finding this closes was measured against the live edge while F-56 ran:
 *
 * ```
 * POST /api/v1/auth/register     (no cookie, no token, no invitation)
 * → 201
 * ```
 *
 * There was no registration policy in this system at all — no setting in
 * `apps/api/src/config`, nothing in `.env.example`. Anyone on the internet
 * could hold an account on a province's school judge, submit, consume judge
 * time on a fleet sized for a province, and appear wherever accounts appear.
 * D197 made sure they could not read children's names; it did not, and could
 * not, stop them being there.
 *
 * Six claims, in the order they matter:
 *
 *   1. the default rung is `closed`, and an operator reaches it by doing
 *      nothing — including the "set but empty" way a compose stack arrives;
 *   2. `closed` refuses **before the meter and before the address is looked
 *      at**, which is what makes the refusal say nothing about any account —
 *      the property D26 has been paying a fake 201 for since 29 August;
 *   3. a global admin still may, because a province must be able to seat a
 *      late arrival, and a setter and an ordinary account may not;
 *   4. a trusted registrar is told the truth about a taken address, and an
 *      anonymous caller on the `open` rung still is not (D26, unchanged);
 *   5. `open` is the pre-D200 behaviour, byte for byte;
 *   6. the switch reaches the process, and an operator can read the rung off
 *      the dashboard (F-40's lesson).
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { schema, type Db } from '@duckoj/db';
import { AppError } from '../src/common/app.error.js';
import { AuthService } from '../src/authn/auth.service.js';
import {
  assertRegistrationOpen,
  isTrustedRegistrar,
  mayRegister,
  registrationOf,
} from '../src/authz/registration.policy.js';
import { loadConfig, type Registration } from '../src/config/config.schema.js';
import type { Actor } from '../src/authz/actor.js';
import type { PasswordService } from '../src/authn/password.service.js';
import type { RateLimiter } from '../src/common/rate-limiter.js';
import { buildApp, TEST_ENV } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin } from './submissions.fixtures.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const PASSWORD = 'correct horse battery';
/** `submissions.fixtures.ts`'s own password — the one `registerAndLogin` sets. */
const FIXTURE_PASSWORD = 'a-long-enough-password';

function actor(globalRole: Actor['globalRole'], userId = 1): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

/** A registration body, in the shape the contract wants. */
function signup(username: string, email = `${username}@example.com`) {
  return { username, email, password: PASSWORD, displayName: username };
}

describe('the rung an operator gets by doing nothing (D200)', () => {
  it('is `closed`, and it is what an unset and an EMPTY variable both mean', () => {
    // The two ways a compose stack arrives without an opinion. `REGISTRATION=`
    // is what `docker-compose.yml` hands the process on a deployment whose
    // `.env` says nothing — F-40's exact failure, so `unsetWhenBlank` covers
    // this variable and this test is what says so. The live `.env` sets
    // nothing, so this is the rung production runs.
    const { REGISTRATION: _unused, ...withoutIt } = { ...TEST_ENV, REGISTRATION: 'x' };
    expect(loadConfig(withoutIt).registration).toBe('closed');
    expect(loadConfig({ ...TEST_ENV, REGISTRATION: '' }).registration).toBe('closed');
    expect(loadConfig({ ...TEST_ENV, REGISTRATION: '   ' }).registration).toBe('closed');
  });

  it('refuses a rung it does not have, rather than falling back to one', () => {
    expect(() => loadConfig({ ...TEST_ENV, REGISTRATION: 'invite' })).toThrow(/REGISTRATION/);
  });

  it('reads a config it was never given as `closed`, never as `open`', () => {
    // D80's precedent: a service assembled by hand in a spec or a script must
    // get the protective rung, which is the same direction the deployment
    // default leans.
    expect(registrationOf(undefined)).toBe('closed');
    expect(registrationOf(null)).toBe('closed');
  });

  it('admits a global admin and nobody else below `open`', () => {
    expect(mayRegister('closed', null)).toBe(false);
    expect(mayRegister('closed', actor('user'))).toBe(false);
    // A setter authors problems. D197 admits them to `authority` because a
    // fresh province has no organizations yet; who may create PEOPLE is a
    // different question, and D61 answers it with owner-or-global-admin.
    expect(mayRegister('closed', actor('setter'))).toBe(false);
    expect(mayRegister('closed', actor('admin'))).toBe(true);
    expect(isTrustedRegistrar(actor('setter'))).toBe(false);
    expect(isTrustedRegistrar(actor('admin'))).toBe(true);
    // On `open` the rung answers for everyone, including nobody.
    expect(mayRegister('open', null)).toBe(true);
  });
});

/**
 * The property is "nothing else ran", and the cleanest proof of that is a
 * database handle and a rate limiter that throw if they are touched at all —
 * `mail-unavailable.spec.ts`'s shape, for D155's identical reason.
 */
const forbiddenDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`the database was touched (.${String(property)}) before the refusal`);
    },
  },
) as unknown as Db;

const forbiddenPasswords = {
  hash: () => {
    throw new Error('a password was hashed before the refusal');
  },
} as unknown as PasswordService;

const forbiddenLimiter = {
  record: () => {
    throw new Error('the rate limiter was consulted before the refusal');
  },
  retryAfterSeconds: () => {
    throw new Error('the rate limiter was consulted before the refusal');
  },
} as unknown as RateLimiter;

async function refusalOf(work: Promise<unknown>): Promise<AppError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('the call succeeded; no refusal to inspect');
}

describe('a closed judge refuses before it knows anything about the caller (D200, D26)', () => {
  it('is a pure predicate: no address, no meter, no hash', () => {
    // `assertRegistrationOpen` takes the rung and the actor and nothing else.
    // It literally cannot vary with the request body, which is the structural
    // half of the argument — D155's, said again on the other endpoint.
    const error = (() => {
      try {
        assertRegistrationOpen('closed', null);
      } catch (e) {
        return e as AppError;
      }
      throw new Error('a closed judge accepted a stranger');
    })();
    expect(error.status).toBe(403);
    expect(error.code).toBe('registration_closed');
  });

  it('refuses in the service too, before the database is touched', async () => {
    const service = new AuthService(forbiddenDb, forbiddenPasswords, forbiddenLimiter);
    // Reaching this expectation at all proves the refusal came first: any
    // property access on `forbiddenDb` throws a plain Error, which
    // `refusalOf` re-raises rather than returning.
    const known = await refusalOf(
      service.register(signup('anh'), { policy: 'closed', actor: null }),
    );
    const unknown = await refusalOf(
      service.register(signup('nobody', 'nobody@nowhere.invalid'), {
        policy: 'closed',
        actor: null,
      }),
    );
    expect(known.status).toBe(403);
    expect(known.code).toBe('registration_closed');
    // Byte for byte the same refusal for an address that exists on a real
    // stack and one that never could. This is what D26 has been buying with a
    // fake 201 since 29 August, and on this rung it costs nothing.
    expect(unknown.status).toBe(known.status);
    expect(unknown.code).toBe(known.code);
    expect(unknown.detail).toBe(known.detail);
  });

  it('answers 403 over HTTP and creates nothing', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, { configOverrides: { registration: 'closed' } });
      try {
        const res = await request(app.getHttpServer())
          .post('/api/v1/auth/register')
          .send(signup('nguoi-la'));
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('registration_closed');
        const rows = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.username, 'nguoi-la'));
        expect(rows).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  });

  it('never consumes D26\u2019s meter, so a refused stranger cannot lock a school out', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, { configOverrides: { registration: 'closed' } });
      try {
        // Thirty-five attempts from one address — five more than
        // `REGISTER_LIMIT_PER_IP`. If the refusal ran after the meter, the
        // last of these would be a 429 and a whole computer room behind one
        // NAT address would be locked out by one stranger knocking.
        for (let attempt = 0; attempt < 35; attempt += 1) {
          const res = await request(app.getHttpServer())
            .post('/api/v1/auth/register')
            .set('X-Forwarded-For', '203.0.113.9')
            .send(signup(`nguoi-la-${String(attempt)}`));
          expect(res.status).toBe(403);
        }
        const events = await db
          .select({ id: schema.rateEvents.id })
          .from(schema.rateEvents)
          .where(eq(schema.rateEvents.key, 'ip:203.0.113.9'));
        expect(events).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  });

  it('tells a visitor the rung, anonymously, so a form need not 403 to find out', async () => {
    await withTestDb(async (db) => {
      for (const rung of ['open', 'closed'] as Registration[]) {
        const app = await buildApp(db, { configOverrides: { registration: rung } });
        try {
          const res = await request(app.getHttpServer()).get('/api/v1/auth/registration');
          expect(res.status).toBe(200);
          expect(res.body).toEqual({ registration: rung });
        } finally {
          await app.close();
        }
      }
    });
  });
});

describe('the paths a province cannot lose keep working (D200)', () => {
  it('lets a global admin create an account on a closed judge', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, { configOverrides: { registration: 'closed' } });
      try {
        const agent = request.agent(app.getHttpServer());
        // The admin themselves needs an account, and on a closed judge that
        // comes from D19's CLI. Seeded directly, which is what
        // `bootstrap:admin` does against `DATABASE_URL`.
        const cookie = await adminSession(db, agent, 'quan-tri');
        const res = await agent
          .post('/api/v1/auth/register')
          .set('Cookie', cookie)
          .send(signup('co-giao-lan'));
        expect(res.status).toBe(201);
        expect(res.body.username).toBe('co-giao-lan');
      } finally {
        await app.close();
      }
    });
  });

  it('does not meter the admin: their IP is the classroom’s', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, { configOverrides: { registration: 'closed' } });
      try {
        const agent = request.agent(app.getHttpServer());
        const cookie = await adminSession(db, agent, 'quan-tri-2');
        await agent
          .post('/api/v1/auth/register')
          .set('Cookie', cookie)
          .set('X-Forwarded-For', '203.0.113.10')
          .send(signup('hoc-sinh-moi'));
        const events = await db
          .select({ id: schema.rateEvents.id })
          .from(schema.rateEvents)
          .where(eq(schema.rateEvents.key, 'ip:203.0.113.10'));
        expect(events).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  });

  it('refuses a setter and an ordinary account, session and all', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, { configOverrides: { registration: 'closed' } });
      try {
        for (const role of ['user', 'setter'] as const) {
          const agent = request.agent(app.getHttpServer());
          const name = `nguoi-${role}`;
          // Registered while the app is still reachable to them? No — the
          // rung is closed. Seeded, then signed in, which is the state a
          // province's pupils are actually in.
          const cookie = await sessionFor(db, agent, name, role);
          const res = await agent
            .post('/api/v1/auth/register')
            .set('Cookie', cookie)
            .send(signup(`nguoi-moi-${role}`));
          expect(res.status).toBe(403);
          expect(res.body.code).toBe('registration_closed');
        }
      } finally {
        await app.close();
      }
    });
  });

  it('tells a trusted registrar the truth about a taken address (D200 narrows D26)', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, { configOverrides: { registration: 'closed' } });
      try {
        const agent = request.agent(app.getHttpServer());
        const cookie = await adminSession(db, agent, 'quan-tri-3');
        await agent
          .post('/api/v1/auth/register')
          .set('Cookie', cookie)
          .send(signup('hs-mot', 'lan@school.example'));
        // Same address, different username: D26's fake 201 would report
        // success and create nothing, handing an operator a phantom account
        // they have no way to find out about.
        const res = await agent
          .post('/api/v1/auth/register')
          .set('Cookie', cookie)
          .send(signup('hs-hai', 'lan@school.example'));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('email_taken');
        const rows = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.username, 'hs-hai'));
        expect(rows).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  });
});

describe('`open` is the behaviour before D200, byte for byte', () => {
  it('takes an anonymous sign-up', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, { configOverrides: { registration: 'open' } });
      try {
        const res = await request(app.getHttpServer())
          .post('/api/v1/auth/register')
          .set('X-Forwarded-For', '203.0.113.20')
          .send(signup('nguoi-moi'));
        expect(res.status).toBe(201);
      } finally {
        await app.close();
      }
    });
  });

  it('still answers a taken address with D26’s fake 201 for a stranger', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, { configOverrides: { registration: 'open' } });
      try {
        const server = app.getHttpServer();
        await request(server)
          .post('/api/v1/auth/register')
          .set('X-Forwarded-For', '203.0.113.21')
          .send(signup('hs-ba', 'an@school.example'));
        const res = await request(server)
          .post('/api/v1/auth/register')
          .set('X-Forwarded-For', '203.0.113.22')
          .send(signup('hs-bon', 'an@school.example'));
        // The whole of D26: indistinguishable from a success, and nothing
        // written. D200 changes this for a global admin and for nobody else.
        expect(res.status).toBe(201);
        expect(res.body.username).toBe('hs-bon');
        const rows = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.username, 'hs-bon'));
        expect(rows).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  });
});

describe('the switch reaches the process (F-40, D200)', () => {
  const composeSource = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');
  const envExample = readFileSync(join(repoRoot, '.env.example'), 'utf8');

  it('is passed to the api service by docker-compose.yml', () => {
    const api = composeSource.slice(composeSource.indexOf('\n  api:'));
    const nextService = api.slice(4).search(/\n {2}[a-z]/);
    expect(api.slice(0, nextService)).toContain('REGISTRATION: ${REGISTRATION:-}');
  });

  it('is documented in .env.example, with the default named', () => {
    expect(envExample).toMatch(/^REGISTRATION=$/m);
    expect(envExample).toContain('closed');
  });

  it('is reported on the admin dashboard, so an operator can SEE which rung is live', async () => {
    await withTestDb(async (db) => {
      for (const rung of ['open', 'closed'] as Registration[]) {
        const app = await buildApp(db, { configOverrides: { registration: rung } });
        const agent = request.agent(app.getHttpServer());
        try {
          const cookie = await adminSession(db, agent, `quan-tri-bang-${rung}`);
          const res = await agent.get('/api/v1/admin/dashboard').set('Cookie', cookie);
          expect(res.status).toBe(200);
          expect(res.body.runtime.registration).toBe(rung);
        } finally {
          await app.close();
        }
      }
    });
  });
});

/* ── fixtures ────────────────────────────────────────────────────────── */

/**
 * A signed-in session for an account this spec seeds DIRECTLY.
 *
 * It cannot go through `registerAndLogin`: half these tests run on the rung
 * that refuses registration, which is the point. Seeding then signing in is
 * also the truer fixture — it is the state D61's imported pupils and D19's
 * bootstrapped admin are actually in.
 */
async function sessionFor(
  db: Db,
  agent: ReturnType<typeof request.agent>,
  username: string,
  globalRole: 'user' | 'setter' | 'admin',
): Promise<string> {
  // Registered against a throwaway OPEN app on the same database, rather than
  // inserted by hand: `registerAndLogin` is the one place this suite knows the
  // argon2 encoding of its fixture password, and a second copy of that
  // knowledge here would be a fixture that silently stops matching.
  const opener = await buildApp(db, { configOverrides: { registration: 'open' } });
  try {
    await registerAndLogin(request.agent(opener.getHttpServer()), username);
  } finally {
    await opener.close();
  }
  await db.update(schema.users).set({ globalRole }).where(eq(schema.users.username, username));
  const res = await agent
    .post('/api/v1/auth/login')
    .send({ usernameOrEmail: username, password: FIXTURE_PASSWORD });
  const setCookie: unknown = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie)
    ? (setCookie[0] as string | undefined)
    : (setCookie as string | undefined);
  if (raw === undefined) throw new Error(`login for ${username} did not set a session cookie`);
  return raw.split(';')[0]!;
}

async function adminSession(
  db: Db,
  agent: ReturnType<typeof request.agent>,
  username: string,
): Promise<string> {
  return sessionFor(db, agent, username, 'admin');
}
