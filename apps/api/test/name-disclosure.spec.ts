/**
 * D197 — how much of a child this deployment publishes.
 *
 * The measured "before", taken by B-35 against the live host with no cookie
 * and no token:
 *
 * ```
 * GET /api/v1/contests?limit=100        -> 159 contests in 2 requests
 * a scoreboard for each of them         -> 142 DISTINCT usernames, 249 rows
 * GET /api/v1/users/{username} for each -> 263 of 264 resolved, displayName on all
 *                                          264 of 481 accounts — 54.9% — named
 * ```
 *
 * Neither end of that chain is a bug. A scoreboard names its competitors
 * because that is what a scoreboard is for (D46, D192, D195); a profile linked
 * from one opens for a stranger. What was missing is a policy: an adult on a
 * public judge and a twelve-year-old in a provincial school are not the same
 * population, and until now the software treated them identically.
 *
 * So `NAME_DISCLOSURE` is a deployment policy with three rungs and a
 * PROTECTIVE default, and this file pins six properties of it:
 *
 *   1. the default an operator gets by doing nothing (`affiliated`);
 *   2. that `public` restores the pre-D197 behaviour exactly;
 *   3. that you always see your OWN name, at every rung;
 *   4. that the export paths print real names — a certificate bearing a handle
 *      is not a certificate — and reach that answer by ASKING the predicate;
 *   5. that the search box cannot be used to recover a withheld name one
 *      prefix at a time, which is the hole that would make the whole rung
 *      theatre;
 *   6. that the switch actually reaches the process (F-40's lesson).
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import {
  contestParticipations,
  contestProblems,
  contests,
  orgMembers,
  organizations,
  problems,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { loadConfig, type NameDisclosure } from '../src/config/config.schema.js';
import { buildApp, TEST_ENV } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { insertUser, registerAndLogin, userIdOf } from './submissions.fixtures.js';

type Agent = ReturnType<typeof request.agent>;

/**
 * A username out of D61's bulk import — a column of `hs000123`, which is
 * exactly why D185 taught the search box to match the display name in the
 * first place. It deliberately shares NO word with the real name below: a
 * handle that already contained "nguyen" would make the oracle tests below
 * pass for the wrong reason.
 */
const PUPIL = 'hs000123';
const PUPIL_NAME = 'Nguyễn Văn An';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The pupil whose real name is the thing at stake, plus their school. */
async function seedPupil(db: Db): Promise<{ pupilId: number; orgId: number }> {
  const pupil = await insertUser(db, PUPIL);
  await db
    .update(schema.users)
    .set({
      displayName: PUPIL_NAME,
      country: 'VN',
      // Free text a twelve-year-old typed about themselves. This is the field
      // the display-name policy would otherwise leave holding the school, the
      // class and the birthday it was meant to protect.
      about: 'Lớp 9A2, THPT Chuyên Hạ Long. Sinh ngày 3/4.',
    })
    .where(eq(schema.users.id, pupil.id));
  const [org] = await db
    .insert(organizations)
    .values({ slug: 'thpt-ha-long', name: 'THPT Chuyên Hạ Long', visibility: 'public' })
    .returning({ id: organizations.id });
  await db.insert(orgMembers).values({ orgId: org!.id, userId: pupil.id, role: 'member' });
  return { pupilId: pupil.id, orgId: org!.id };
}

async function signIn(app: INestApplication, name: string): Promise<Agent> {
  const agent = request.agent(app.getHttpServer());
  await registerAndLogin(agent, name);
  return agent;
}

/** Gives an account standing at the `affiliated` rung: a role in ANY school. */
async function affiliate(db: Db, orgId: number, username: string): Promise<void> {
  await db
    .insert(orgMembers)
    .values({ orgId, userId: await userIdOf(db, username), role: 'member' });
}

describe('the default an operator gets by doing nothing (D197)', () => {
  it('is `affiliated`, and it is what an unset and an EMPTY variable both mean', () => {
    // The two ways a compose stack arrives without an opinion. `NAME_DISCLOSURE=`
    // is what `docker-compose.yml` hands the process on a deployment whose
    // `.env` says nothing — F-40's exact failure, so `unsetWhenBlank` covers
    // this variable and this test is what says so.
    const { NAME_DISCLOSURE: _unused, ...withoutIt } = { ...TEST_ENV, NAME_DISCLOSURE: 'x' };
    expect(loadConfig(withoutIt).nameDisclosure).toBe('affiliated');
    expect(loadConfig({ ...TEST_ENV, NAME_DISCLOSURE: '' }).nameDisclosure).toBe('affiliated');
    expect(loadConfig({ ...TEST_ENV, NAME_DISCLOSURE: '   ' }).nameDisclosure).toBe('affiliated');
  });

  it('refuses a rung it does not have, rather than falling back to one', () => {
    expect(() => loadConfig({ ...TEST_ENV, NAME_DISCLOSURE: 'everyone' })).toThrow(
      /NAME_DISCLOSURE/,
    );
  });

  it('shows an anonymous stranger the USERNAME, and says on the page that it did', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedPupil(db);
        // The dereference B-35 measured, 264 times over.
        const res = await request(app.getHttpServer()).get(`/api/v1/users/${PUPIL}`);
        expect(res.status).toBe(200);
        expect(res.body.username).toBe(PUPIL);
        // Substituted, not omitted: the field keeps its shape and its value is
        // the handle a scoreboard already published.
        expect(res.body.displayName).toBe(PUPIL);
        expect(res.body.displayName).not.toContain('Nguyễn');
        // D187 — a reader shown less has to be able to see that they are.
        expect(res.body.identityRedacted).toBe(true);
        // The other half of identity: free text the pupil typed about
        // themselves, which has no substitute that keeps a page usable.
        expect(res.body.about).toBeNull();
        // NOT withheld, and argued rather than overlooked: a coarse
        // self-declared country, the join date, the badge and the numbers a
        // judge exists to publish (D46, D188).
        expect(res.body.country).toBe('VN');
        expect(res.body.rating).not.toBeUndefined();
        expect(res.body.createdAt).not.toBeUndefined();
      } finally {
        await app.close();
      }
    });
  });

  it('shows an account that registered thirty seconds ago the same handle', async () => {
    // This is the rung's whole reason for existing. `authenticated` would hand
    // this caller 482 real names: D26 METERS registration, it does not gate it,
    // and B-35 measured the sweep at 576 requests and 1.5 seconds.
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedPupil(db);
        const stranger = await signIn(app, 'stranger');
        const res = await stranger.get(`/api/v1/users/${PUPIL}`);
        expect(res.status).toBe(200);
        expect(res.body.displayName).toBe(PUPIL);
        expect(res.body.identityRedacted).toBe(true);
      } finally {
        await app.close();
      }
    });
  });

  it('shows the real name to a reader with standing in ANY school', async () => {
    // Not "a school shared with the pupil". A provincial round's organiser
    // belongs to none of the thirty schools whose pupils are in it, and a
    // teacher reading a provincial scoreboard is a legitimate reader.
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const { orgId } = await seedPupil(db);
        const teacher = await signIn(app, 'co-giao');
        const before = await teacher.get(`/api/v1/users/${PUPIL}`);
        expect(before.body.displayName).toBe(PUPIL);

        await affiliate(db, orgId, 'co-giao');
        const after = await teacher.get(`/api/v1/users/${PUPIL}`);
        expect(after.body.displayName).toBe(PUPIL_NAME);
        expect(after.body.identityRedacted).toBe(false);
        expect(after.body.about).toContain('Lớp 9A2');
      } finally {
        await app.close();
      }
    });
  });

  it('shows you your OWN name even when you belong to nothing', async () => {
    // Without this a pupil at a province whose school has not been created yet
    // opens their own profile, is told their display name is their username,
    // and saves it.
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const me = await signIn(app, 'toi');
        await db
          .update(schema.users)
          .set({ displayName: 'Trần Thị Mai' })
          .where(eq(schema.users.username, 'toi'));
        const res = await me.get('/api/v1/users/toi');
        expect(res.body.displayName).toBe('Trần Thị Mai');
        expect(res.body.identityRedacted).toBe(false);
        // `GET /auth/me` is the reader's own row by construction and is
        // untouched by the policy — the settings form has to be able to show
        // you what you are editing.
        const mine = await me.get('/api/v1/auth/me');
        expect(mine.body.displayName).toBe('Trần Thị Mai');
      } finally {
        await app.close();
      }
    });
  });

  it('redacts the public ROSTER page D191 kept open, not only the profile', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedPupil(db);
        const res = await request(app.getHttpServer()).get(
          '/api/v1/orgs/thpt-ha-long/members?limit=100',
        );
        expect(res.status).toBe(200);
        expect(res.body.items).toHaveLength(1);
        expect(res.body.items[0].username).toBe(PUPIL);
        expect(res.body.items[0].displayName).toBe(PUPIL);
      } finally {
        await app.close();
      }
    });
  });
});

describe('the search box is not a name-recovery oracle (D197)', () => {
  /**
   * The hole that would make the rung theatre.
   *
   * D185's `q` matches a WORD prefix of the folded `username || ' ' ||
   * display_name`. A reader who is shown handles but may still search the
   * display names can confirm a withheld name one prefix at a time — `q=ng`,
   * `q=ngu`, `q=nguye` — over exactly the names the projection took away, and
   * D191 closed the same prefix-iteration hole for an anonymous roster reader
   * for exactly this reason.
   */
  it('will not match a withheld display name for a reader without standing', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const { orgId } = await seedPupil(db);
        const stranger = await signIn(app, 'stranger');

        const byName = await stranger.get('/api/v1/users?q=nguyen');
        expect(byName.status).toBe(200);
        expect(byName.body.items.map((i: { username: string }) => i.username)).not.toContain(PUPIL);

        // The box still works — it searches the handle, which is public on
        // every scoreboard anyway, and D185's word-prefix rule still applies
        // to the username's own words (`search_fold` turns `-`, `_` and `.`
        // into spaces, so `an` would still find `hs-nguyen-van-an`).
        const byHandle = await stranger.get('/api/v1/users?q=hs');
        expect(byHandle.body.items.map((i: { username: string }) => i.username)).toContain(PUPIL);

        // And a reader with standing gets D185 back, whole.
        await affiliate(db, orgId, 'stranger');
        const affiliated = await stranger.get('/api/v1/users?q=nguyen');
        expect(affiliated.body.items.map((i: { username: string }) => i.username)).toContain(PUPIL);
      } finally {
        await app.close();
      }
    });
  });

  it('closes the same hole on the org roster, where D191 already closed the anonymous half', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedPupil(db);
        const stranger = await signIn(app, 'stranger');
        const res = await stranger.get('/api/v1/orgs/thpt-ha-long/members?q=nguyen');
        expect(res.status).toBe(200);
        expect(res.body.items).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  });
});

describe('`public` is the pre-D197 behaviour, byte for byte (D197)', () => {
  it('hands an anonymous stranger the real name again', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, { configOverrides: { nameDisclosure: 'public' } });
      try {
        await seedPupil(db);
        const res = await request(app.getHttpServer()).get(`/api/v1/users/${PUPIL}`);
        expect(res.body.displayName).toBe(PUPIL_NAME);
        expect(res.body.identityRedacted).toBe(false);
        expect(res.body.about).toContain('Lớp 9A2');
        const roster = await request(app.getHttpServer()).get(
          '/api/v1/orgs/thpt-ha-long/members?limit=100',
        );
        expect(roster.body.items[0].displayName).toBe(PUPIL_NAME);
      } finally {
        await app.close();
      }
    });
  });
});

describe('`authenticated` is the middle rung, for the parent with an account (D197)', () => {
  it('names the pupil to any signed-in caller and to no anonymous one', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, { configOverrides: { nameDisclosure: 'authenticated' } });
      try {
        await seedPupil(db);
        const anon = await request(app.getHttpServer()).get(`/api/v1/users/${PUPIL}`);
        expect(anon.body.displayName).toBe(PUPIL);
        expect(anon.body.identityRedacted).toBe(true);

        // A parent, who belongs to no school and never will.
        const parent = await signIn(app, 'phu-huynh');
        const res = await parent.get(`/api/v1/users/${PUPIL}`);
        expect(res.body.displayName).toBe(PUPIL_NAME);
        expect(res.body.identityRedacted).toBe(false);
        expect(res.body.about).toContain('Lớp 9A2');
      } finally {
        await app.close();
      }
    });
  });
});

describe('the export paths, which are the artefacts that leave the building (D197)', () => {
  /**
   * A finished round with one named competitor, seeded through the database:
   * this is about what the sheet PRINTS, not about how a contest is run.
   */
  async function seedFinishedContest(db: Db, key: string, ownerId: number): Promise<void> {
    const now = Date.now();
    const [problem] = await db
      .insert(problems)
      .values({
        code: `${key}-a`,
        name: 'Tổng hai số',
        statement: 'Cho $a+b$.',
        visibility: 'public',
        createdBy: ownerId,
      })
      .returning({ id: problems.id });
    const [contest] = await db
      .insert(contests)
      .values({
        key,
        name: 'Thi thử tỉnh',
        startTime: new Date(now - 120 * 60_000),
        endTime: new Date(now - 60 * 60_000),
        format: 'icpc',
        visibility: 'public',
        createdBy: ownerId,
      })
      .returning({ id: contests.id });
    await db
      .insert(contestProblems)
      .values({ contestId: contest!.id, problemId: problem!.id, label: 'A', points: 100, order: 0 });
    await db.insert(contestParticipations).values({
      contestId: contest!.id,
      userId: await userIdOf(db, PUPIL),
      virtual: 0,
      startTime: new Date(now - 110 * 60_000),
    });
  }

  it('prints the real name at the PROTECTIVE default, because the caller is authority', async () => {
    // The organiser here belongs to no school and is not an admin — under the
    // default rung they see handles everywhere else in the product. What makes
    // the sheet name the pupil is `canRunContest`, which the export path passes
    // INTO the predicate as `authority` rather than around it.
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const organiser = request.agent(app.getHttpServer());
      try {
        await seedPupil(db);
        const cookie = await registerAndLogin(organiser, 'to-chuc');
        await seedFinishedContest(db, 'thi-tinh', await userIdOf(db, 'to-chuc'));

        // Everywhere else, this caller sees a handle.
        const profile = await organiser.get(`/api/v1/users/${PUPIL}`).set('Cookie', cookie);
        expect(profile.body.displayName).toBe(PUPIL);

        // On the sheet they are running, they see the child they have to
        // hand a certificate to.
        const csv = await organiser.get('/api/v1/contests/thi-tinh/results.csv').set('Cookie', cookie);
        expect(csv.status).toBe(200);
        expect(csv.text).toContain(PUPIL_NAME);
      } finally {
        await app.close();
      }
    });
  });

  it('leaves the SCOREBOARD alone, because it never carried a name to begin with', async () => {
    // The finding that makes D197 tractable: the scoreboard is the route B-35
    // measured, and it publishes `ranking[].participant` — a username — and
    // nothing else. It is compliant with the policy without a line of code,
    // and its 2 s cache (D25) is safe because the payload does not vary by
    // reader. This pins that, so a future row carrying a display name fails
    // here rather than on a province's host.
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const organiser = request.agent(app.getHttpServer());
      try {
        await seedPupil(db);
        const cookie = await registerAndLogin(organiser, 'to-chuc');
        await seedFinishedContest(db, 'thi-tinh', await userIdOf(db, 'to-chuc'));
        void cookie;

        const board = await request(app.getHttpServer()).get(
          '/api/v1/contests/thi-tinh/scoreboard',
        );
        expect(board.status).toBe(200);
        expect(JSON.stringify(board.body)).not.toContain('Nguyễn');
        expect(board.body.ranking.map((r: { participant: string }) => r.participant)).toContain(
          PUPIL,
        );
      } finally {
        await app.close();
      }
    });
  });
});

describe('the switch reaches the process (F-40, D197)', () => {
  /**
   * F-40 exists because the config module read a full `SMTP_*` set that
   * `docker-compose.yml` never passed to the `api` service: an operator could
   * fill in every line of `.env` and get a silent no-op. This is the one
   * setting whose whole job is to decide what a stranger learns about a child,
   * so the same three checks `mail-wiring.spec.ts` makes are made here.
   */
  const composeSource = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');
  const envExample = readFileSync(join(repoRoot, '.env.example'), 'utf8');

  it('is passed to the api service by docker-compose.yml', () => {
    const api = composeSource.slice(composeSource.indexOf('\n  api:'));
    const nextService = api.slice(4).search(/\n {2}[a-z]/);
    expect(api.slice(0, nextService)).toContain('NAME_DISCLOSURE: ${NAME_DISCLOSURE:-}');
  });

  it('is documented in .env.example, with the default named', () => {
    expect(envExample).toMatch(/^NAME_DISCLOSURE=$/m);
    expect(envExample).toContain('affiliated');
  });

  it('is reported on the admin dashboard, so an operator can SEE which rung is live', async () => {
    // "I set it and I believe it took" is not good enough for this setting.
    await withTestDb(async (db) => {
      const rungs: NameDisclosure[] = ['public', 'authenticated', 'affiliated'];
      for (const rung of rungs) {
        const app = await buildApp(db, { configOverrides: { nameDisclosure: rung } });
        const admin = request.agent(app.getHttpServer());
        try {
          const cookie = await registerAndLogin(admin, `quan-tri-${rung}`);
          await db
            .update(schema.users)
            .set({ globalRole: 'admin' })
            .where(eq(schema.users.username, `quan-tri-${rung}`));
          const res = await admin.get('/api/v1/admin/dashboard').set('Cookie', cookie);
          expect(res.status).toBe(200);
          expect(res.body.runtime.nameDisclosure).toBe(rung);
        } finally {
          await app.close();
        }
      }
    });
  });
});
