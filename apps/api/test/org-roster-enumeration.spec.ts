/**
 * D191 — a public school's roster is a page, not a download.
 *
 * The measured "before", taken against the live host with no cookie and no
 * token on the day this was written:
 *
 * ```
 * GET /api/v1/orgs?limit=100                    -> 27 orgs, all public, 1 request
 * GET /api/v1/orgs/<slug>/members?limit=100     -> 200, username + displayName
 * the walk over all of them                     -> 80 distinct pupils, 28 requests
 * ```
 *
 * D188 answered the same disclosure on `GET /users` by requiring an actor.
 * That answer does NOT transfer here, and the fact it turns on was checked
 * rather than assumed: `/orgs/$slug` has no route guard in the web app, so a
 * public school's page — roster included — renders for a stranger, and an
 * organization marked `public` was marked that way on purpose (D56). So the
 * ruling is narrower and the tests below pin its two halves:
 *
 *   1. **An anonymous caller keeps page one and loses the sweep.** No
 *      `nextCursor`, and `cursor` and `q` both refused with 401. `q` is not
 *      belt-and-braces: D185's search matches a WORD prefix, so a caller who
 *      cannot advance could still reconstitute a roster by iterating them.
 *   2. **A signed-in caller's walk spends D188's budget — the same one, not a
 *      second — and the school's own people are exempt from it**, because a
 *      teacher paging a five-thousand-pupil roster is the reader this list
 *      exists for and metering them would be D16's self-lockout on a real
 *      screen.
 */
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { orgMembers, organizations } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { USER_WALK_LIMIT, USER_WALK_PURPOSE } from '../src/authz/walk.meter.js';
import { REFUSAL_PREFIX } from '../src/common/rate-limiter.js';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin, userIdOf } from './submissions.fixtures.js';

type Agent = ReturnType<typeof request.agent>;

async function signIn(app: INestApplication, db: Db, name: string, admin = false): Promise<Agent> {
  const agent = request.agent(app.getHttpServer());
  await registerAndLogin(agent, name);
  if (admin) {
    await db.update(schema.users).set({ globalRole: 'admin' }).where(eq(schema.users.username, name));
  }
  return agent;
}

/**
 * A school with `n` pupils on its roster, seeded through the database rather
 * than through `POST /orgs/{slug}/members`: the ruling is about reading a
 * roster, and 200 write requests to build one would make the spec about
 * something else (and cost a minute).
 */
async function seedSchool(
  db: Db,
  owner: Agent,
  slug: string,
  n: number,
  visibility: 'public' | 'private' = 'public',
): Promise<void> {
  const created = await owner
    .post('/api/v1/orgs')
    .send({ slug, name: slug, visibility, joinPolicy: 'invite' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug));
  if (n === 0) return;
  const pupils = await db
    .insert(schema.users)
    .values(
      Array.from({ length: n }, (_, i) => ({
        username: `${slug}-hs${String(i).padStart(4, '0')}`,
        email: `${slug}-hs${String(i).padStart(4, '0')}@truong.test`,
        passwordHash: 'x',
        displayName: `Nguyễn Văn ${String(i)}`,
      })),
    )
    .returning({ id: schema.users.id });
  await db
    .insert(orgMembers)
    .values(pupils.map((p) => ({ orgId: org!.id, userId: p.id, role: 'member' as const })));
}

/** Every metered walk event this account has, under `purpose`. */
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

describe('a public roster is a page, not a walk, for an anonymous reader (D191)', () => {
  it('serves page one to a stranger and never hands them a cursor', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const head = await signIn(app, db, 'hieu-truong', true);
        await seedSchool(db, head, 'thpt-cong-khai', 40);

        // The public page still works signed out — that is the legitimate
        // choice D56 makes deliberate, and gating it would break it.
        const page = await request(app.getHttpServer()).get(
          '/api/v1/orgs/thpt-cong-khai/members?limit=10',
        );
        expect(page.status).toBe(200);
        expect(page.body.items).toHaveLength(10);
        expect(page.body.items[0].displayName).toBeTypeOf('string');

        // …and it ends there. A signed-in reader on the same page IS handed
        // one, which is what makes this a trim rather than a missing row.
        expect(page.body.nextCursor).toBeNull();
        const signedIn = await head.get('/api/v1/orgs/thpt-cong-khai/members?limit=10');
        expect(signedIn.body.nextCursor).not.toBeNull();
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses an anonymous cursor and an anonymous search with 401, never 403', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const head = await signIn(app, db, 'hieu-truong-2', true);
        await seedSchool(db, head, 'thpt-hai', 40);

        // A cursor a stranger already holds — from a bookmark, a log, or a
        // signed-in session they have since lost — is worth nothing.
        const walked = await request(app.getHttpServer()).get(
          '/api/v1/orgs/thpt-hai/members?limit=10&cursor=thpt-hai-hs0005',
        );
        expect(walked.status).toBe(401);
        expect(walked.body.code).toBe('authentication_required');
        // A read a caller may not do answers 401 or 404, never 403.
        expect(walked.status).not.toBe(403);

        // And `q` goes with it. Closing the cursor alone would be theatre:
        // `nameSearchWhere` matches a WORD prefix, so twenty-six of these
        // would rebuild the roster with no cursor anywhere in sight.
        const searched = await request(app.getHttpServer()).get(
          '/api/v1/orgs/thpt-hai/members?q=nguyen',
        );
        expect(searched.status).toBe(401);
        expect(searched.body.code).toBe('authentication_required');
        expect(searched.body.items).toBeUndefined();
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('a private school is still a 404 to a stranger, and the ruling did not touch that', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const head = await signIn(app, db, 'hieu-truong-3', true);
        await seedSchool(db, head, 'thpt-rieng', 5, 'private');
        const res = await request(app.getHttpServer()).get('/api/v1/orgs/thpt-rieng/members');
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('organization_not_found');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('the roster walk spends D188s budget, and the school is exempt (D191)', () => {
  it('refuses a signed-in stranger past the budget, with Retry-After and a D47 marker', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const head = await signIn(app, db, 'hieu-truong-4', true);
        await seedSchool(db, head, 'thpt-quet', USER_WALK_LIMIT + 5);
        const stranger = await signIn(app, db, 'nguoi-la');

        // Page one carries no cursor and costs nothing: it is the same rows
        // however often it is asked for. Only advancing is enumeration.
        const first = await stranger.get('/api/v1/orgs/thpt-quet/members?limit=1');
        expect(first.status).toBe(200);
        let cursor = String(first.body.nextCursor);

        for (let i = 0; i < USER_WALK_LIMIT; i += 1) {
          const res = await stranger.get(
            `/api/v1/orgs/thpt-quet/members?limit=1&cursor=${cursor}`,
          );
          expect(res.status, `page ${String(i + 2)}`).toBe(200);
          cursor = String(res.body.nextCursor);
        }

        const refused = await stranger.get(
          `/api/v1/orgs/thpt-quet/members?limit=1&cursor=${cursor}`,
        );
        expect(refused.status).toBe(429);
        expect(refused.body.code).toBe('user_walk_rate_limited');
        expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);

        const id = await userIdOf(db, 'nguoi-la');
        expect(await walkRows(db, id, `${REFUSAL_PREFIX}${USER_WALK_PURPOSE}`)).toHaveLength(1);
        // D16's split: the refusal recorded no ATTEMPT, so the window drains
        // rather than the caller pinning themselves against it.
        expect(await walkRows(db, id)).toHaveLength(USER_WALK_LIMIT);
      } finally {
        await app.close();
      }
    });
  }, 240_000);

  it('is ONE budget with GET /users, not two', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const head = await signIn(app, db, 'hieu-truong-5', true);
        await seedSchool(db, head, 'thpt-chung', 30);
        const stranger = await signIn(app, db, 'nguoi-la-2');

        // Spend the whole budget on the directory…
        const users = await stranger.get('/api/v1/users?limit=1');
        let cursor = String(users.body.nextCursor);
        for (let i = 0; i < USER_WALK_LIMIT; i += 1) {
          const res = await stranger.get(`/api/v1/users?limit=1&cursor=${cursor}`);
          expect(res.status).toBe(200);
          cursor = String(res.body.nextCursor);
        }

        // …and the roster has none left. Two meters would have handed this
        // caller twenty more pages of every school in the province, which is
        // the same sweep with one extra step in it.
        const roster = await stranger.get('/api/v1/orgs/thpt-chung/members?limit=1');
        const refused = await stranger.get(
          `/api/v1/orgs/thpt-chung/members?limit=1&cursor=${String(roster.body.nextCursor)}`,
        );
        expect(refused.status).toBe(429);
        expect(refused.body.code).toBe('user_walk_rate_limited');
      } finally {
        await app.close();
      }
    });
  }, 240_000);

  it('the school pages its own roster past the budget, because that is the reader it is for', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const head = await signIn(app, db, 'hieu-truong-6', true);
        await seedSchool(db, head, 'thpt-cua-toi', USER_WALK_LIMIT + 10);
        const teacher = await signIn(app, db, 'giao-vien');
        // A plain member, not staff: the exemption is membership, not power.
        const [org] = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.slug, 'thpt-cua-toi'));
        await db
          .insert(orgMembers)
          .values({ orgId: org!.id, userId: await userIdOf(db, 'giao-vien'), role: 'member' });

        const first = await teacher.get('/api/v1/orgs/thpt-cua-toi/members?limit=1');
        let cursor = String(first.body.nextCursor);
        // Two hundred presses of "load more" is what a 5 000-pupil school
        // costs; well past the budget here, and not one of them is metered.
        for (let i = 0; i < USER_WALK_LIMIT + 5; i += 1) {
          const res = await teacher.get(
            `/api/v1/orgs/thpt-cua-toi/members?limit=1&cursor=${cursor}`,
          );
          expect(res.status, `page ${String(i + 2)}`).toBe(200);
          cursor = String(res.body.nextCursor);
        }
        expect(await walkRows(db, await userIdOf(db, 'giao-vien'))).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  }, 240_000);

  it('a roster search box can never spend the budget — no cursor, no meter', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const head = await signIn(app, db, 'hieu-truong-7', true);
        await seedSchool(db, head, 'thpt-tim', 20);
        const stranger = await signIn(app, db, 'nguoi-tim-2');

        // The roster search is keystroke-driven with no debounce, exactly as
        // the admin lookup is. Forty requests must leave the meter untouched.
        for (const q of Array.from({ length: 40 }, (_, i) => `nguyen${String(i)}`)) {
          const res = await stranger.get(`/api/v1/orgs/thpt-tim/members?limit=25&q=${q}`);
          expect(res.status, q).toBe(200);
        }
        expect(await walkRows(db, await userIdOf(db, 'nguoi-tim-2'))).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  }, 240_000);

  it('one class behind one address is many windows — the meter never sees an IP', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const head = await signIn(app, db, 'hieu-truong-8', true);
        await seedSchool(db, head, 'thpt-nat', USER_WALK_LIMIT + 5);

        // Thirty pupils in a computer room share one public address. An
        // IP-keyed meter hands the room ONE budget between them and locks the
        // last arrivals out mid-contest — D16's self-lockout generalised to a
        // whole classroom. D188 forbids keying on an address; this is that
        // property, restated on the roster.
        const room = '203.0.113.7';
        const a = await signIn(app, db, 'hocsinh-x');
        const b = await signIn(app, db, 'hocsinh-y');

        const spend = async (agent: Agent) => {
          const first = await agent
            .get('/api/v1/orgs/thpt-nat/members?limit=1')
            .set('X-Forwarded-For', room);
          let cursor = String(first.body.nextCursor);
          for (let i = 0; i < USER_WALK_LIMIT; i += 1) {
            const res = await agent
              .get(`/api/v1/orgs/thpt-nat/members?limit=1&cursor=${cursor}`)
              .set('X-Forwarded-For', room);
            expect(res.status).toBe(200);
            cursor = String(res.body.nextCursor);
          }
        };

        await spend(a);
        await spend(b);
        expect(await walkRows(db, await userIdOf(db, 'hocsinh-x'))).toHaveLength(USER_WALK_LIMIT);
        expect(await walkRows(db, await userIdOf(db, 'hocsinh-y'))).toHaveLength(USER_WALK_LIMIT);
      } finally {
        await app.close();
      }
    });
  }, 240_000);
});
