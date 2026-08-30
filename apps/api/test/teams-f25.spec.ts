/**
 * Teams, second pass — the four gaps F-24 named and D99 recorded as open.
 *
 *  1. `GET /users/me/teams`: one request for every school, and — with
 *     `?contest=` — the server's own verdict on whether each may enter, so a
 *     picker greys a choice out with the code the join would refuse with.
 *  2. The team's own page: the contests it has entered, and whether one of
 *     them is running right now.
 *  3. A roster is READ-ONLY while a contest the team has entered is running
 *     (409 `team_locked_during_contest`) — unless the caller runs it. This
 *     reverses D99's "rosters stay live", so the test that matters is the one
 *     that shows an ordinary school admin refused and the organiser allowed.
 *  4. Two teams called the same thing, joining in the same instant, are
 *     serialised: D99's stated residual, closed by a per-(contest, name)
 *     advisory lock.
 *  5. An organiser may enter a team themselves.
 *
 * Everything goes over HTTP against the real controllers, for
 * `contest-teams.spec.ts`'s reason: most of what this feature IS lives in the
 * refusals. The race block needs two COMMITTED transactions on two
 * connections and so runs on `testDbUrl()` rather than `withTestDb`'s
 * rollback.
 */
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import {
  contestOrgs,
  contestParticipations,
  contestProblems,
  contests,
  organizations,
  problems,
  teams,
} from '@duckoj/db/guarded';
import { createDb, schema, type Db } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { testDbUrl, withTestDb } from './db.harness.js';
import { insertUser, registerAndLogin, seedProblemAndLanguage } from './submissions.fixtures.js';

type Agent = ReturnType<typeof request.agent>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

async function signIn(app: INestApplication, db: Db, name: string, admin = false): Promise<Agent> {
  const agent = request.agent(app.getHttpServer());
  await registerAndLogin(agent, name);
  if (admin) {
    await db
      .update(schema.users)
      .set({ globalRole: 'admin' })
      .where(eq(schema.users.username, name));
  }
  return agent;
}

interface School {
  admin: Agent;
  teacher: Agent;
  pupils: Map<string, Agent>;
}

/** A school with `teacher` as a plain (non-global-admin) owner. */
async function makeSchool(
  app: INestApplication,
  db: Db,
  slug: string,
  pupils: string[],
): Promise<School> {
  const admin = await signIn(app, db, `${slug}-root`, true);
  const created = await admin
    .post('/api/v1/orgs')
    .send({ slug, name: slug, visibility: 'public', joinPolicy: 'invite' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);

  const teacher = await signIn(app, db, `${slug}-teacher`);
  const owner = await admin
    .post(`/api/v1/orgs/${slug}/members`)
    .send({ username: `${slug}-teacher`, role: 'owner' });
  expect(owner.status, JSON.stringify(owner.body)).toBe(201);

  const agents = new Map<string, Agent>();
  for (const name of pupils) {
    agents.set(name, await signIn(app, db, name));
    const added = await admin
      .post(`/api/v1/orgs/${slug}/members`)
      .send({ username: name, role: 'member' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
  }
  return { admin, teacher, pupils: agents };
}

/** A contest whose window is relative to now, attached to every named school. */
async function seedContest(
  db: Db,
  opts: {
    key: string;
    problemId: number;
    orgSlugs: string[];
    startsInMs?: number;
    endsInMs?: number;
    mode?: 'individual' | 'team';
    maxTeamSize?: number;
    /** Whose contest it is — the actor `canRunContest` lets through. */
    createdBy?: number;
  },
): Promise<number> {
  const now = Date.now();
  const owner =
    opts.createdBy ?? (await insertUser(db, `${opts.key}-owner`, 'admin')).id;
  const [contest] = await db
    .insert(contests)
    .values({
      key: opts.key,
      name: opts.key,
      startTime: new Date(now + (opts.startsInMs ?? -MINUTE)),
      endTime: new Date(now + (opts.endsInMs ?? 5 * HOUR)),
      format: 'icpc',
      visibility: 'public',
      participationMode: opts.mode ?? 'team',
      maxTeamSize: opts.maxTeamSize ?? 3,
      frozenLastMinutes: 0,
      createdBy: owner,
    })
    .returning({ id: contests.id });
  for (const slug of opts.orgSlugs) {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug));
    await db.insert(contestOrgs).values({ contestId: contest!.id, orgId: org!.id });
  }
  await db
    .insert(contestProblems)
    .values({ contestId: contest!.id, problemId: opts.problemId, label: 'A', points: 100, order: 0 });
  return contest!.id;
}

async function problemId(db: Db): Promise<number> {
  const [row] = await db.select({ id: problems.id }).from(problems).limit(1);
  return row!.id;
}

async function userIdOfName(db: Db, username: string): Promise<number> {
  const [row] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username));
  return row!.id;
}

/* ------------------------------------------------------ GET /users/me/teams */

describe('GET /users/me/teams', () => {
  it('answers with every team across every school in ONE request', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const alpha = await makeSchool(app, db, 'mt-alpha', ['mt-an']);
        const beta = await makeSchool(app, db, 'mt-beta', ['mt-an']);
        await alpha.teacher
          .post('/api/v1/orgs/mt-alpha/teams')
          .send({ slug: 'doi-a', name: 'Đội A', members: ['mt-an'] });
        await beta.teacher
          .post('/api/v1/orgs/mt-beta/teams')
          .send({ slug: 'doi-b', name: 'Đội B', members: ['mt-an'] });
        // A team the pupil is NOT on, in a school they belong to: the list is
        // "teams I am on", not "teams near me".
        await alpha.teacher
          .post('/api/v1/orgs/mt-alpha/teams')
          .send({ slug: 'doi-x', name: 'Đội X', members: [] });

        const res = await alpha.pupils.get('mt-an')!.get('/api/v1/users/me/teams');
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.items.map((t: { slug: string }) => t.slug).sort()).toEqual([
          'doi-a',
          'doi-b',
        ]);
        expect(res.body.truncated).toBe(false);
        // No `?contest=`: both null, never `true`. A picker that forgot the
        // parameter must not look like it worked.
        expect(res.body.items[0].eligible).toBeNull();
        expect(res.body.items[0].ineligibleReason).toBeNull();
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('says, per team, whether it may enter the contest named — with the code the join would use', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'el-school', ['el-an', 'el-binh', 'el-cuong']);
        const outside = await makeSchool(app, db, 'el-outside', ['el-an']);
        await school.teacher
          .post('/api/v1/orgs/el-school/teams')
          .send({ slug: 'ok', name: 'Đội OK', members: ['el-an'] });
        await school.teacher
          .post('/api/v1/orgs/el-school/teams')
          .send({ slug: 'big', name: 'Đội To', members: ['el-an', 'el-binh', 'el-cuong'] });
        await outside.teacher
          .post('/api/v1/orgs/el-outside/teams')
          .send({ slug: 'away', name: 'Đội Xa', members: ['el-an'] });

        await seedContest(db, {
          key: 'el-c',
          problemId: await problemId(db),
          orgSlugs: ['el-school'],
          maxTeamSize: 2,
        });

        const res = await school.pupils
          .get('el-an')!
          .get('/api/v1/users/me/teams?contest=el-c');
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const byslug = new Map(
          (res.body.items as { slug: string; eligible: boolean; ineligibleReason: string }[]).map(
            (t) => [t.slug, t],
          ),
        );
        expect(byslug.get('ok')).toMatchObject({ eligible: true, ineligibleReason: null });
        expect(byslug.get('big')).toMatchObject({
          eligible: false,
          ineligibleReason: 'contest_team_too_large',
        });
        expect(byslug.get('away')).toMatchObject({
          eligible: false,
          ineligibleReason: 'contest_team_org_not_named',
        });

        // Once that team is in, it is no longer a choice — and neither is any
        // other team of the same person's.
        const joined = await school.pupils
          .get('el-an')!
          .post('/api/v1/contests/el-c/join')
          .send({ teamSlug: 'ok' });
        expect(joined.status, JSON.stringify(joined.body)).toBe(201);

        const after = await school.pupils
          .get('el-an')!
          .get('/api/v1/users/me/teams?contest=el-c');
        const afterBySlug = new Map(
          (after.body.items as { slug: string; ineligibleReason: string }[]).map((t) => [
            t.slug,
            t,
          ]),
        );
        expect(afterBySlug.get('ok')!.ineligibleReason).toBe('contest_team_joined');
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('refuses to annotate against a contest the caller may not see', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'hid-school', ['hid-an']);
        await school.teacher
          .post('/api/v1/orgs/hid-school/teams')
          .send({ slug: 'doi', name: 'Đội', members: ['hid-an'] });
        const contestId = await seedContest(db, {
          key: 'hid-c',
          problemId: await problemId(db),
          orgSlugs: ['hid-school'],
        });
        await db.update(contests).set({ visibility: 'private' }).where(eq(contests.id, contestId));

        const res = await school.pupils
          .get('hid-an')!
          .get('/api/v1/users/me/teams?contest=hid-c');
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('contest_not_found');
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

/* ------------------------------------------------------- the team's record */

describe('a team’s own page', () => {
  it('lists the contests it entered and says when one is running', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'rec-school', ['rec-an']);
        await school.teacher
          .post('/api/v1/orgs/rec-school/teams')
          .send({ slug: 'doi', name: 'Đội', members: ['rec-an'] });

        const quiet = await school.teacher.get('/api/v1/orgs/rec-school/teams/doi');
        expect(quiet.body.contests).toEqual([]);
        expect(quiet.body.inRunningContest).toBe(false);

        await seedContest(db, {
          key: 'rec-c',
          problemId: await problemId(db),
          orgSlugs: ['rec-school'],
        });
        const joined = await school.pupils
          .get('rec-an')!
          .post('/api/v1/contests/rec-c/join')
          .send({ teamSlug: 'doi' });
        expect(joined.status, JSON.stringify(joined.body)).toBe(201);

        const busy = await school.teacher.get('/api/v1/orgs/rec-school/teams/doi');
        expect(busy.body.contests).toHaveLength(1);
        expect(busy.body.contests[0]).toMatchObject({
          key: 'rec-c',
          running: true,
          isDisqualified: false,
          captain: 'rec-an',
        });
        expect(busy.body.inRunningContest).toBe(true);

        // And the org list carries the same flag, which is what the web's
        // warning banner is drawn from — one query, not one per row.
        const list = await school.teacher.get('/api/v1/orgs/rec-school/teams');
        expect(list.body.items[0].inRunningContest).toBe(true);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

/* ----------------------------------------------------- the roster lock (D99) */

describe('a roster while the team is competing', () => {
  it('refuses a school admin’s membership change, and lets the organiser make it', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'lock-school', ['lk-an', 'lk-binh', 'lk-cuong']);
        // A school ADMIN who is not a global admin and does not run the
        // contest — the actor the rule is actually about. `school.admin` is a
        // global admin and would pass the exemption for the wrong reason.
        const staff = await signIn(app, db, 'lk-staff');
        const promoted = await school.admin
          .post('/api/v1/orgs/lock-school/members')
          .send({ username: 'lk-staff', role: 'admin' });
        expect(promoted.status, JSON.stringify(promoted.body)).toBe(201);
        await school.teacher
          .post('/api/v1/orgs/lock-school/teams')
          .send({ slug: 'doi', name: 'Đội', members: ['lk-an'] });

        // The contest belongs to the SCHOOL'S OWN teacher, so the exemption
        // is about running the contest rather than about being staff
        // somewhere: the admin below is an owner of the same school and is
        // still refused.
        const organiserId = await userIdOfName(db, 'lock-school-teacher');
        await seedContest(db, {
          key: 'lock-c',
          problemId: await problemId(db),
          orgSlugs: ['lock-school'],
          createdBy: organiserId,
        });

        // Before the team enters, an ordinary edit is free.
        const early = await staff
          .patch('/api/v1/orgs/lock-school/teams/doi')
          .send({ members: ['lk-an', 'lk-binh'] });
        expect(early.status, JSON.stringify(early.body)).toBe(200);

        const joined = await school.pupils
          .get('lk-an')!
          .post('/api/v1/contests/lock-c/join')
          .send({ teamSlug: 'doi' });
        expect(joined.status, JSON.stringify(joined.body)).toBe(201);

        // A school owner who does NOT run the contest: refused. This is the
        // sentence D99 used to say the other way round.
        const swapped = await staff
          .patch('/api/v1/orgs/lock-school/teams/doi')
          .send({ members: ['lk-cuong'] });
        expect(swapped.status, JSON.stringify(swapped.body)).toBe(409);
        expect(swapped.body.code).toBe('team_locked_during_contest');

        // A RENAME is not a roster change and is still allowed: it has its
        // own rule, about the board being unambiguous.
        const renamed = await staff
          .patch('/api/v1/orgs/lock-school/teams/doi')
          .send({ name: 'Đội Một' });
        expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);

        // The organiser — the one person who legitimately edits a roster
        // mid-round, for the pupil who did not turn up.
        const byOrganiser = await school.teacher
          .patch('/api/v1/orgs/lock-school/teams/doi')
          .send({ members: ['lk-an'] });
        expect(byOrganiser.status, JSON.stringify(byOrganiser.body)).toBe(200);
        expect(byOrganiser.body.members).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  /**
   * The exemption is **all** the running contests, not any — and that is a
   * rule with teeth only when a team is in two at once.
   *
   * An organiser of round A has no standing to reshuffle a roster that is
   * mid-round in B: the swap would land on B's board as surely as on A's, and
   * B's organiser would never see it happen. "Any" would make the whole rule
   * evaporate the moment a team entered a second contest, which is the
   * ordinary state of a good team during a season.
   */
  it('refuses the organiser of ONE of two running contests, and admits a global admin', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'two-school', ['tw-an', 'tw-binh']);
        await school.teacher
          .post('/api/v1/orgs/two-school/teams')
          .send({ slug: 'doi', name: 'Đội', members: ['tw-an'] });

        // Two rounds running at once, with two different organisers: the
        // school's own teacher runs the first, a stranger the second.
        const organiserId = await userIdOfName(db, 'two-school-teacher');
        const outsider = await insertUser(db, 'two-outsider');
        await seedContest(db, {
          key: 'two-a',
          problemId: await problemId(db),
          orgSlugs: ['two-school'],
          createdBy: organiserId,
        });
        await seedContest(db, {
          key: 'two-b',
          problemId: await problemId(db),
          orgSlugs: ['two-school'],
          createdBy: outsider.id,
        });
        for (const key of ['two-a', 'two-b']) {
          const joined = await school.pupils
            .get('tw-an')!
            .post(`/api/v1/contests/${key}/join`)
            .send({ teamSlug: 'doi' });
          expect(joined.status, JSON.stringify(joined.body)).toBe(201);
        }

        // Runs `two-a`, does NOT run `two-b`: refused. Under an `any` rule
        // this is a 200, and `two-b`'s board silently gains a stranger.
        const partial = await school.teacher
          .patch('/api/v1/orgs/two-school/teams/doi')
          .send({ members: ['tw-binh'] });
        expect(partial.status, JSON.stringify(partial.body)).toBe(409);
        expect(partial.body.code).toBe('team_locked_during_contest');

        // A global admin answers for the deployment and passes both.
        const byAdmin = await school.admin
          .patch('/api/v1/orgs/two-school/teams/doi')
          .send({ members: ['tw-binh'] });
        expect(byAdmin.status, JSON.stringify(byAdmin.body)).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('is free again once the contest has ended', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'done-school', ['dn-an', 'dn-binh']);
        const staff = await signIn(app, db, 'dn-staff');
        await school.admin
          .post('/api/v1/orgs/done-school/members')
          .send({ username: 'dn-staff', role: 'admin' });
        await school.teacher
          .post('/api/v1/orgs/done-school/teams')
          .send({ slug: 'doi', name: 'Đội', members: ['dn-an'] });
        const contestId = await seedContest(db, {
          key: 'done-c',
          problemId: await problemId(db),
          orgSlugs: ['done-school'],
        });
        const joined = await school.pupils
          .get('dn-an')!
          .post('/api/v1/contests/done-c/join')
          .send({ teamSlug: 'doi' });
        expect(joined.status).toBe(201);

        await db
          .update(contests)
          .set({ endTime: new Date(Date.now() - MINUTE) })
          .where(eq(contests.id, contestId));

        const edited = await staff
          .patch('/api/v1/orgs/done-school/teams/doi')
          .send({ members: ['dn-binh'] });
        expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

/* ------------------------------------------------- the organiser seeds a team */

describe('POST /contests/{key}/participants', () => {
  it('enters a team, picking the lowest user id as its captain, and refuses a stranger', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'seed-school', ['sd-an', 'sd-binh']);
        await school.teacher
          .post('/api/v1/orgs/seed-school/teams')
          .send({ slug: 'doi', name: 'Đội', members: ['sd-an', 'sd-binh'] });
        const organiserId = await userIdOfName(db, 'seed-school-teacher');
        // Deliberately BEFORE the gun: preparing the room is the ordinary
        // case, and `join` refuses that with `contest_not_started`.
        const contestId = await seedContest(db, {
          key: 'seed-c',
          problemId: await problemId(db),
          orgSlugs: ['seed-school'],
          startsInMs: HOUR,
          endsInMs: 5 * HOUR,
          createdBy: organiserId,
        });

        const stranger = await school.pupils
          .get('sd-binh')!
          .post('/api/v1/contests/seed-c/participants')
          .send({ teamSlug: 'doi' });
        expect(stranger.status).toBe(403);
        expect(stranger.body.code).toBe('contest_forbidden');

        const seeded = await school.teacher
          .post('/api/v1/contests/seed-c/participants')
          .send({ teamSlug: 'doi' });
        expect(seeded.status, JSON.stringify(seeded.body)).toBe(201);
        expect(seeded.body.team.slug).toBe('doi');

        const [row] = await db
          .select({
            userId: contestParticipations.userId,
            startTime: contestParticipations.startTime,
          })
          .from(contestParticipations)
          .where(eq(contestParticipations.contestId, contestId));
        const anId = await userIdOfName(db, 'sd-an');
        const binhId = await userIdOfName(db, 'sd-binh');
        expect(row!.userId).toBe(Math.min(anId, binhId));
        // Never before the contest: the row starts when the round does.
        const [contest] = await db
          .select({ startTime: contests.startTime })
          .from(contests)
          .where(eq(contests.id, contestId));
        expect(row!.startTime.getTime()).toBe(contest!.startTime.getTime());

        // Idempotent in the way that matters: a second seed reads the row
        // back rather than minting a second one.
        const again = await school.teacher
          .post('/api/v1/contests/seed-c/participants')
          .send({ teamSlug: 'doi' });
        expect(again.status).toBe(201);
        const all = await db
          .select({ id: contestParticipations.id })
          .from(contestParticipations)
          .where(eq(contestParticipations.contestId, contestId));
        expect(all).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('refuses a team with nobody on it, and one this contest’s schools do not name', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'empty-school', ['ep-an']);
        await school.teacher
          .post('/api/v1/orgs/empty-school/teams')
          .send({ slug: 'trong', name: 'Đội Trống', members: [] });
        const organiserId = await userIdOfName(db, 'empty-school-teacher');
        await seedContest(db, {
          key: 'empty-c',
          problemId: await problemId(db),
          orgSlugs: ['empty-school'],
          createdBy: organiserId,
        });

        const empty = await school.teacher
          .post('/api/v1/contests/empty-c/participants')
          .send({ teamSlug: 'trong' });
        expect(empty.status, JSON.stringify(empty.body)).toBe(422);
        expect(empty.body.code).toBe('contest_team_empty');

        const unknown = await school.teacher
          .post('/api/v1/contests/empty-c/participants')
          .send({ teamSlug: 'khong-co' });
        expect(unknown.status).toBe(422);
        expect(unknown.body.code).toBe('contest_team_unknown');
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

/* ------------------------------------------------------ the same-name race */

describe('two DIFFERENT teams of the same name joining in the same instant', () => {
  const opened: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const close of opened) await close();
  });

  /**
   * D99's stated residual, and the reason a per-team-ID lock would not close
   * it: the two rows racing here belong to two different teams, so nothing
   * they hold in common exists to lock — except the NAME, which is exactly
   * what makes them a collision. `pg_advisory_xact_lock(contest,
   * hashtext(lower(name)))` is that thing.
   *
   * Two committed transactions on two connections, so `testDbUrl()` rather
   * than `withTestDb`'s rollback: a savepoint of one transaction always sees
   * its own sibling's writes, which is the opposite of the situation under
   * test.
   */
  it('lets exactly one onto the board and refuses the other by name', async () => {
    const url = await testDbUrl();
    const { db, close } = createDb(url);
    opened.push(close);

    const app = await buildApp(db);
    try {
      await seedProblemAndLanguage(db);
      const alpha = await makeSchool(app, db, 'nm-alpha', ['nm-an']);
      const beta = await makeSchool(app, db, 'nm-beta', ['nm-binh']);
      // Same NAME, different schools, different slugs, different people.
      await alpha.teacher
        .post('/api/v1/orgs/nm-alpha/teams')
        .send({ slug: 'doi-a', name: 'Đội Trùng', members: ['nm-an'] });
      await beta.teacher
        .post('/api/v1/orgs/nm-beta/teams')
        .send({ slug: 'doi-b', name: 'ĐỘI TRÙNG', members: ['nm-binh'] });
      const contestId = await seedContest(db, {
        key: 'nm-c',
        problemId: await problemId(db),
        orgSlugs: ['nm-alpha', 'nm-beta'],
      });

      const [a, b] = await Promise.all([
        alpha.pupils.get('nm-an')!.post('/api/v1/contests/nm-c/join').send({ teamSlug: 'doi-a' }),
        beta.pupils.get('nm-binh')!.post('/api/v1/contests/nm-c/join').send({ teamSlug: 'doi-b' }),
      ]);
      const statuses = [a.status, b.status].sort((x, y) => x - y);
      expect(statuses, JSON.stringify([a.body, b.body])).toEqual([201, 409]);
      const refused = a.status === 409 ? a.body : b.body;
      expect(refused.code).toBe('contest_team_name_taken');

      // One row on the board, not two sharing a name — which is what would
      // make the disqualify control move the wrong team and one exported
      // results sheet print the wrong roster.
      const rows = await db
        .select({ id: contestParticipations.id })
        .from(contestParticipations)
        .innerJoin(teams, eq(teams.id, contestParticipations.teamId))
        .where(and(eq(contestParticipations.contestId, contestId), eq(teams.name, 'Đội Trùng')));
      expect(rows.length).toBeLessThanOrEqual(1);
      const all = await db
        .select({ id: contestParticipations.id })
        .from(contestParticipations)
        .where(eq(contestParticipations.contestId, contestId));
      expect(all).toHaveLength(1);
    } finally {
      await app.close();
    }
  }, 180_000);
});
