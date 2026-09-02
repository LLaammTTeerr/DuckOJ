/**
 * D188 — the pupil directory is not a public download.
 *
 * `GET /users` was `@Public()` and fully enumerable by anyone: five requests
 * at `limit=100` took every account on the live judge, with no credential and
 * no meter. On a rehearsal host that is generated data; on a province's host
 * it is every pupil's real name, most of them children.
 *
 * Two properties are pinned here, and they are the pair the ruling stands on:
 *
 *   1. **An anonymous caller cannot walk the roster at all.** The list now
 *      requires an actor — a session, or a token carrying `users:read`. The
 *      refusal is 401 `authentication_required`, the same one `GET
 *      /submissions` has always answered, not a 403 and not an empty page.
 *   2. **A legitimate caller still works, and the meter cannot bite them.**
 *      The only caller in the product is the admin account lookup, which is
 *      signed in and sends `q` and never a cursor — so the meter counts
 *      CURSOR-BEARING requests only, and a search box is structurally
 *      incapable of spending the budget.
 *
 * The window is exercised by counting real requests rather than by backdating,
 * because the budget is small enough to reach honestly; `submission-rate-
 * limit.spec.ts` backdates because ten seconds cannot be waited out.
 */
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { orgMembers, organizations } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { USER_WALK_LIMIT, USER_WALK_PURPOSE } from '../src/authz/user.access.js';
import { REFUSAL_PREFIX } from '../src/common/rate-limiter.js';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { insertUser, registerAndLogin, userIdOf } from './submissions.fixtures.js';

/** A roster big enough that one page is not the whole thing. */
async function seedRoster(db: Db, n: number): Promise<void> {
  await db.insert(schema.users).values(
    Array.from({ length: n }, (_, i) => ({
      username: `hs${String(i).padStart(6, '0')}`,
      email: `hs${String(i).padStart(6, '0')}@truong.test`,
      passwordHash: 'x',
      displayName: `Học Sinh ${String(i)}`,
    })),
  );
}

/**
 * A role in a school — what D197's default rung asks for before a display name
 * is in the reader's haystack. A bare organization, not one of the pupils'
 * own: standing is "a role in ANY organization", never "one shared with the
 * person you are looking at" (D197 argues that alternative and why it lost).
 */
async function giveStanding(db: Db, username: string): Promise<void> {
  const [org] = await db
    .insert(organizations)
    .values({ slug: `phong-gd-${username}`, name: 'Phòng Giáo dục', visibility: 'private' })
    .returning({ id: organizations.id });
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username));
  await db.insert(orgMembers).values({ orgId: org!.id, userId: user!.id, role: 'member' });
}

/** Every metered walk event this user has. */
async function walkRows(db: Db, userId: number, purpose = USER_WALK_PURPOSE) {
  return db
    .select({ id: schema.rateEvents.id })
    .from(schema.rateEvents)
    .where(
      and(
        eq(schema.rateEvents.purpose, purpose),
        eq(schema.rateEvents.key, `user:${String(userId)}`),
      ),
    );
}

describe('GET /users is not an anonymous download (D188)', () => {
  it('refuses an anonymous caller, page one and every page after it', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedRoster(db, 30);

        // The measured "before": no cookie, no token, a page and a cursor.
        const first = await request(app.getHttpServer()).get('/api/v1/users?limit=10');
        expect(first.status).toBe(401);
        expect(first.body.code).toBe('authentication_required');

        // Not a 403, and not an empty page that a scraper would read as "the
        // roster is empty" — the endpoint says what is wrong and what to do.
        expect(first.status).not.toBe(403);
        expect(first.body.items).toBeUndefined();

        // A cursor a stranger already holds — from a bookmark, a log, or the
        // walk they ran yesterday — is worth nothing either.
        const withCursor = await request(app.getHttpServer()).get('/api/v1/users?limit=10&cursor=5');
        expect(withCursor.status).toBe(401);

        // And neither is a search: `q` is not a way in.
        const searched = await request(app.getHttpServer()).get('/api/v1/users?q=hoc');
        expect(searched.status).toBe(401);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('an anonymous caller can still read ONE person, which is what a judge is for', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await insertUser(db, 'hs000001');
        // Individual visibility is not what this ruling touches: a profile,
        // its progress and its rating stay public, because that is how a
        // competitive-programming judge works (D46's public rank ramp hangs
        // off exactly these). Bulk enumeration is the thing being closed.
        for (const path of [
          '/api/v1/users/hs000001',
          '/api/v1/users/hs000001/progress',
          '/api/v1/users/hs000001/rating',
        ]) {
          const res = await request(app.getHttpServer()).get(path);
          expect(res.status, path).toBe(200);
        }
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('a signed-in teacher still searches, and still pages', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedRoster(db, 30);
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'giao-vien');
        // A teacher, which since **D197** means a reader with STANDING — a
        // role in some school. D188's property is unchanged and is what this
        // test is about ("a signed-in caller may still ask"); what D197 added
        // is which haystack the answer comes from. The seeded pupils are
        // `hs000000` with display names `Học Sinh N`, so `q=hoc` matches the
        // NAME and nothing else — which is exactly the search a reader with no
        // standing is refused, and `name-disclosure.spec.ts` owns that case.
        await giveStanding(db, 'giao-vien');

        const found = await agent.get('/api/v1/users?limit=50&q=hoc');
        expect(found.status).toBe(200);
        expect(found.body.items.length).toBeGreaterThan(0);

        // The paging half needs no standing at all, and still does not: D188
        // gated WHO may walk, and the walk is over rows this endpoint serves
        // to every signed-in caller alike.

        const page = await agent.get('/api/v1/users?limit=10');
        expect(page.status).toBe(200);
        expect(page.body.nextCursor).not.toBeNull();
        const next = await agent.get(`/api/v1/users?limit=10&cursor=${String(page.body.nextCursor)}`);
        expect(next.status).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('a token carrying users:read still reaches it — this is an API, not only a website', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedRoster(db, 5);
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'nguoi-dung-token');
        const minted = await agent
          .post('/api/v1/auth/tokens')
          .send({ name: 'ci', scopes: ['users:read'] });
        expect(minted.status).toBe(201);

        const res = await request(app.getHttpServer())
          .get('/api/v1/users?limit=5')
          .set('Authorization', `Bearer ${String(minted.body.token)}`);
        expect(res.status).toBe(200);

        // And a token WITHOUT the scope does not, which is what the marker is
        // for: 403 `scope_required`, distinct from the anonymous 401.
        const narrow = await agent
          .post('/api/v1/auth/tokens')
          .send({ name: 'narrow', scopes: ['problems:read'] });
        const refused = await request(app.getHttpServer())
          .get('/api/v1/users?limit=5')
          .set('Authorization', `Bearer ${String(narrow.body.token)}`);
        expect(refused.status).toBe(403);
        expect(refused.body.code).toBe('scope_required');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('the walk is metered per ACCOUNT, and the search is not (D188)', () => {
  it('refuses the walk past its budget, with a Retry-After', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedRoster(db, 200);
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'nguoi-quet');

        // Page one costs nothing: it carries no cursor, and it is the same
        // rows however often it is asked for. Only advancing is enumeration.
        const first = await agent.get('/api/v1/users?limit=1');
        expect(first.status).toBe(200);
        let cursor = String(first.body.nextCursor);

        for (let i = 0; i < USER_WALK_LIMIT; i += 1) {
          const res = await agent.get(`/api/v1/users?limit=1&cursor=${cursor}`);
          expect(res.status, `page ${String(i + 2)}`).toBe(200);
          cursor = String(res.body.nextCursor);
        }

        const refused = await agent.get(`/api/v1/users?limit=1&cursor=${cursor}`);
        expect(refused.status).toBe(429);
        expect(refused.body.code).toBe('user_walk_rate_limited');
        // The header, per RFC 9110, exactly as D16's refusal carries it — and
        // never `0`, which would invite an immediate retry.
        expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);

        // D47: the refusal is countable by an operator.
        const walker = await userIdOf(db, 'nguoi-quet');
        expect(await walkRows(db, walker, `${REFUSAL_PREFIX}${USER_WALK_PURPOSE}`)).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('a search box can never spend the budget — no cursor, no meter', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedRoster(db, 30);
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'nguoi-tim');
        const searcher = await userIdOf(db, 'nguoi-tim');

        // An admin typing `hoc sinh` with no debounce issues one request per
        // keystroke. Forty of them — far more than a name — must leave the
        // meter untouched, or the ruling has reinvented D16's self-lockout on
        // the one screen that uses this endpoint.
        for (const q of Array.from({ length: 40 }, (_, i) => `hoc${String(i)}`)) {
          const res = await agent.get(`/api/v1/users?limit=25&q=${q}`);
          expect(res.status, q).toBe(200);
        }
        expect(await walkRows(db, searcher)).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('one class behind one address is many windows, not one — the meter never sees an IP', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedRoster(db, 60);

        // Thirty pupils in a computer room share one NAT address. An
        // IP-keyed meter would give the room ONE budget between them and lock
        // the last arrivals out mid-contest — worse than the problem it
        // solves. The gate is what makes a per-account key possible, and this
        // is that property, stated as a test: two accounts off the SAME
        // address each get a whole budget.
        const room = '203.0.113.7';
        const a = request.agent(app.getHttpServer());
        const b = request.agent(app.getHttpServer());
        await registerAndLogin(a, 'hocsinh-a');
        await registerAndLogin(b, 'hocsinh-b');

        const spend = async (agent: ReturnType<typeof request.agent>) => {
          const first = await agent.get('/api/v1/users?limit=1').set('X-Forwarded-For', room);
          let cursor = String(first.body.nextCursor);
          for (let i = 0; i < USER_WALK_LIMIT; i += 1) {
            const res = await agent
              .get(`/api/v1/users?limit=1&cursor=${cursor}`)
              .set('X-Forwarded-For', room);
            expect(res.status).toBe(200);
            cursor = String(res.body.nextCursor);
          }
        };

        await spend(a);
        // B has spent nothing, from the same address, and is unaffected by A.
        await spend(b);

        expect(await walkRows(db, await userIdOf(db, 'hocsinh-a'))).toHaveLength(USER_WALK_LIMIT);
        expect(await walkRows(db, await userIdOf(db, 'hocsinh-b'))).toHaveLength(USER_WALK_LIMIT);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});
