/**
 * Team contests — "thi đồng đội", the ICPC shape (D99).
 *
 * Everything here goes over HTTP against the real controllers, because most
 * of what this feature IS lives in the refusals: who may enter as a team,
 * what a teammate's second Join answers, and what the board calls the row
 * three people share.
 *
 * The contests themselves are seeded straight into the tables rather than
 * created through `POST /contests`: that route needs a `setter` or an admin,
 * and every actor in this file is deliberately an ordinary pupil or a
 * school's own owner — a global admin passes every gate here for the wrong
 * reason. The two blocks that ARE about the write path sign in an admin and
 * say so.
 *
 * The last block needs two committed transactions on two connections and so
 * runs on `testDbUrl()` rather than `withTestDb`'s rollback — the same split
 * `problem-sets.spec.ts` makes, for its reason.
 */
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq, sql } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import {
  contestOrgs,
  contestParticipations,
  contestProblems,
  contestSeats,
  contestSubmissions,
  contests,
  organizations,
  problems,
  teamMembers,
  teams,
} from '@duckoj/db/guarded';
import { createDb, schema, type Db } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { testDbUrl, withTestDb } from './db.harness.js';
import {
  clearSubmissionMeter,
  insertUser,
  registerAndLogin,
  seedPrivateProblem,
  seedProblemAndLanguage,
  userIdOf,
} from './submissions.fixtures.js';

type Agent = ReturnType<typeof request.agent>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

async function signIn(app: INestApplication, db: Db, name: string, admin = false): Promise<Agent> {
  const agent = request.agent(app.getHttpServer());
  await registerAndLogin(agent, name);
  if (admin) {
    await db.update(schema.users).set({ globalRole: 'admin' }).where(eq(schema.users.username, name));
  }
  return agent;
}

interface School {
  admin: Agent;
  /** A NON-admin owner: the actor every write in this file is judged as. */
  teacher: Agent;
  pupils: Map<string, Agent>;
}

/** A school with `teacher` as a plain owner and each pupil a plain member. */
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
    const added = await admin.post(`/api/v1/orgs/${slug}/members`).send({ username: name, role: 'member' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
  }
  return { admin, teacher, pupils: agents };
}

/** A contest whose window is relative to now, attached to `orgSlug`. */
async function seedContest(
  db: Db,
  opts: {
    key: string;
    problemId: number;
    orgSlug: string;
    startsInMs?: number;
    endsInMs?: number;
    mode?: 'individual' | 'team';
    maxTeamSize?: number;
    frozenLastMinutes?: number;
  },
): Promise<{ contestId: number; contestProblemId: number }> {
  const now = Date.now();
  const owner = await insertUser(db, `${opts.key}-owner`, 'admin');
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, opts.orgSlug));
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
      frozenLastMinutes: opts.frozenLastMinutes ?? 0,
      createdBy: owner.id,
    })
    .returning({ id: contests.id });
  await db.insert(contestOrgs).values({ contestId: contest!.id, orgId: org!.id });
  const [contestProblem] = await db
    .insert(contestProblems)
    .values({ contestId: contest!.id, problemId: opts.problemId, label: 'A', points: 100, order: 0 })
    .returning({ id: contestProblems.id });
  return { contestId: contest!.id, contestProblemId: contestProblem!.id };
}

async function problemId(db: Db): Promise<number> {
  const [row] = await db.select({ id: problems.id }).from(problems).limit(1);
  return row!.id;
}

/* ------------------------------------------------------------ the roster */

describe('a school assembles a team', () => {
  it('creates it, serves it to its members, and hides it from everyone else', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const school = await makeSchool(app, db, 'school', ['anh', 'binh', 'stranger']);
        const created = await school.teacher.post('/api/v1/orgs/school/teams').send({
          slug: 'doi-1',
          name: 'Đội 1',
          members: ['anh', 'binh'],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        expect(created.body.name).toBe('Đội 1');
        expect(created.body.orgSlug).toBe('school');
        expect(created.body.members.map((m: { username: string }) => m.username)).toEqual(['anh', 'binh']);
        expect(created.body.memberCount).toBe(2);

        const mine = await school.pupils.get('anh')!.get('/api/v1/orgs/school/teams/doi-1');
        expect(mine.status).toBe(200);
        expect(mine.body.canEdit).toBe(false);

        // 404, never 403: a squad list read off the API the morning of the
        // round is reconnaissance, and existence is what the rule protects.
        const outsider = await school.pupils.get('stranger')!.get('/api/v1/orgs/school/teams/doi-1');
        expect(outsider.status).toBe(404);
        expect(outsider.body.code).toBe('team_not_found');

        // The list is the teams you are ON, and empty is the answer for
        // somebody on none (D66's shape).
        const listedByMember = await school.pupils.get('anh')!.get('/api/v1/orgs/school/teams');
        expect(listedByMember.body.items).toHaveLength(1);
        const listedByStranger = await school.pupils.get('stranger')!.get('/api/v1/orgs/school/teams');
        expect(listedByStranger.body.items).toEqual([]);
        const listedByOwner = await school.teacher.get('/api/v1/orgs/school/teams');
        expect(listedByOwner.body.items).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('refuses a member who is not on the school’s roster', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const school = await makeSchool(app, db, 'school', ['anh']);
        await signIn(app, db, 'outsider');
        const refused = await school.teacher.post('/api/v1/orgs/school/teams').send({
          slug: 'doi-1',
          name: 'Đội 1',
          members: ['anh', 'outsider'],
        });
        expect(refused.status, JSON.stringify(refused.body)).toBe(422);
        expect(refused.body.code).toBe('team_members_invalid');
        expect(refused.body.fields['members.1']).toEqual(['team_member_not_in_org']);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('refuses to disband a team that has competed', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'school', ['anh']);
        await school.teacher
          .post('/api/v1/orgs/school/teams')
          .send({ slug: 'doi-1', name: 'Đội 1', members: ['anh'] });
        await seedContest(db, { key: 'team-c', problemId: await problemId(db), orgSlug: 'school' });
        const joined = await school.pupils
          .get('anh')!
          .post('/api/v1/contests/team-c/join')
          .send({ teamSlug: 'doi-1' });
        expect(joined.status, JSON.stringify(joined.body)).toBe(201);

        const refused = await school.teacher.delete('/api/v1/orgs/school/teams/doi-1');
        expect(refused.status, JSON.stringify(refused.body)).toBe(409);
        expect(refused.body.code).toBe('team_has_participations');
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

/* -------------------------------------------------------------- the join */

describe('entering a team contest', () => {
  /** A school with a two-person team `doi-1` and a running team contest. */
  async function ready(
    app: INestApplication,
    db: Db,
    over: Partial<Parameters<typeof seedContest>[1]> = {},
  ): Promise<School> {
    await seedProblemAndLanguage(db);
    const school = await makeSchool(app, db, 'school', ['anh', 'binh', 'cuong']);
    const made = await school.teacher
      .post('/api/v1/orgs/school/teams')
      .send({ slug: 'doi-1', name: 'Đội 1', members: ['anh', 'binh'] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    await seedContest(db, {
      key: 'team-c',
      problemId: await problemId(db),
      orgSlug: 'school',
      ...over,
    });
    return school;
  }

  it('enters the whole team on one row, and tells the second member so', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const school = await ready(app, db);
        const first = await school.pupils
          .get('anh')!
          .post('/api/v1/contests/team-c/join')
          .send({ teamSlug: 'doi-1' });
        expect(first.status, JSON.stringify(first.body)).toBe(201);
        expect(first.body.team).toMatchObject({ slug: 'doi-1', name: 'Đội 1', orgSlug: 'school' });
        expect(first.body.team.members).toEqual(['anh', 'binh']);

        // Idempotent for the account that made it — `join`'s existing
        // contract, unchanged.
        const again = await school.pupils
          .get('anh')!
          .post('/api/v1/contests/team-c/join')
          .send({ teamSlug: 'doi-1' });
        expect(again.status).toBe(201);
        expect(again.body.id).toBe(first.body.id);

        // A teammate is already competing, on that row.
        const second = await school.pupils
          .get('binh')!
          .post('/api/v1/contests/team-c/join')
          .send({ teamSlug: 'doi-1' });
        expect(second.status, JSON.stringify(second.body)).toBe(409);
        expect(second.body.code).toBe('contest_team_joined');

        // ...and `/me` says so, which is what the contest page reads to
        // decide whether to offer a Join button at all.
        const mine = await school.pupils.get('binh')!.get('/api/v1/contests/team-c/me');
        expect(mine.status, JSON.stringify(mine.body)).toBe(200);
        expect(mine.body.id).toBe(first.body.id);
        expect(mine.body.team.name).toBe('Đội 1');

        // Exactly one row, whatever anybody pressed.
        const rows = await db
          .select({ id: contestParticipations.id })
          .from(contestParticipations)
          .where(eq(contestParticipations.contestId, await contestIdOf(db, 'team-c')));
        expect(rows).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  // A slug is unique only per organization (D99), and a team contest can name
  // several schools — so two of them each holding a `doi-1` is a real state.
  // `resolveContestTeam`'s own contract is that the collision is "resolved by
  // the caller's own membership": a pupil on only the SECOND school's `doi-1`
  // must enter on THAT team, not be refused because the lowest-id `doi-1`
  // (another school's, which they are not on) was chosen first.
  it('resolves a cross-org slug collision to the team the caller is actually on (D99)', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        // schoolx is created first, so its `doi-1` gets the lower team id —
        // the one the buggy resolver would pick regardless of membership.
        const schoolX = await makeSchool(app, db, 'schoolx', ['anh']);
        const madeX = await schoolX.teacher
          .post('/api/v1/orgs/schoolx/teams')
          .send({ slug: 'doi-1', name: 'X-1', members: ['anh'] });
        expect(madeX.status, JSON.stringify(madeX.body)).toBe(201);

        // schooly is created second; zed is on schooly's `doi-1` and no other.
        const schoolY = await makeSchool(app, db, 'schooly', ['zed']);
        const madeY = await schoolY.teacher
          .post('/api/v1/orgs/schooly/teams')
          .send({ slug: 'doi-1', name: 'Y-1', members: ['zed'] });
        expect(madeY.status, JSON.stringify(madeY.body)).toBe(201);

        // A team contest naming BOTH schools, so both `doi-1` teams are
        // candidates when a join names the slug.
        const { contestId } = await seedContest(db, {
          key: 'team-x',
          problemId: await problemId(db),
          orgSlug: 'schoolx',
        });
        const [orgY] = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.slug, 'schooly'));
        await db.insert(contestOrgs).values({ contestId, orgId: orgY!.id });

        // zed is on schooly's `doi-1` (the higher id) and no other team.
        // Joining with slug `doi-1` must enter zed on THEIR team, not 422.
        const joined = await schoolY.pupils
          .get('zed')!
          .post('/api/v1/contests/team-x/join')
          .send({ teamSlug: 'doi-1' });
        expect(joined.status, JSON.stringify(joined.body)).toBe(201);
        expect(joined.body.team).toMatchObject({ slug: 'doi-1', name: 'Y-1', orgSlug: 'schooly' });
        expect(joined.body.team.members).toEqual(['zed']);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('requires a team in team mode and refuses one in individual mode', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const school = await ready(app, db);
        await seedContest(db, {
          key: 'solo-c',
          problemId: await problemId(db),
          orgSlug: 'school',
          mode: 'individual',
        });

        const bare = await school.pupils.get('anh')!.post('/api/v1/contests/team-c/join').send({});
        expect(bare.status, JSON.stringify(bare.body)).toBe(422);
        expect(bare.body.code).toBe('contest_team_required');

        // REFUSED, not ignored: a competitor who named a team and was
        // quietly entered alone would find out on the scoreboard.
        const unwanted = await school.pupils
          .get('anh')!
          .post('/api/v1/contests/solo-c/join')
          .send({ teamSlug: 'doi-1' });
        expect(unwanted.status, JSON.stringify(unwanted.body)).toBe(422);
        expect(unwanted.body.code).toBe('contest_team_unexpected');

        // An individual contest still joins with no body at all — what every
        // client written before D99 sends.
        const solo = await school.pupils.get('anh')!.post('/api/v1/contests/solo-c/join');
        expect(solo.status, JSON.stringify(solo.body)).toBe(201);
        expect(solo.body.team).toBeNull();
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('refuses a non-member, an unknown slug, and an oversized team', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const school = await ready(app, db, { maxTeamSize: 1 });
        const notMine = await school.pupils
          .get('cuong')!
          .post('/api/v1/contests/team-c/join')
          .send({ teamSlug: 'doi-1' });
        expect(notMine.status, JSON.stringify(notMine.body)).toBe(422);
        expect(notMine.body.code).toBe('contest_team_not_member');

        const unknown = await school.pupils
          .get('anh')!
          .post('/api/v1/contests/team-c/join')
          .send({ teamSlug: 'doi-9' });
        expect(unknown.status).toBe(422);
        expect(unknown.body.code).toBe('contest_team_unknown');

        const tooBig = await school.pupils
          .get('anh')!
          .post('/api/v1/contests/team-c/join')
          .send({ teamSlug: 'doi-1' });
        expect(tooBig.status, JSON.stringify(tooBig.body)).toBe(409);
        expect(tooBig.body.code).toBe('contest_team_too_large');
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('refuses a second team that shares a member, or a name, with one already competing', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const school = await ready(app, db);
        await school.teacher
          .post('/api/v1/orgs/school/teams')
          .send({ slug: 'doi-2', name: 'Đội 2', members: ['binh', 'cuong'] });
        await school.teacher
          .post('/api/v1/orgs/school/teams')
          .send({ slug: 'doi-3', name: 'ĐỘI 1', members: ['cuong'] });

        const entered = await school.pupils
          .get('anh')!
          .post('/api/v1/contests/team-c/join')
          .send({ teamSlug: 'doi-1' });
        expect(entered.status, JSON.stringify(entered.body)).toBe(201);

        // `binh` is on both, and one person may hold at most one
        // participation in a contest — `setDisqualified` and
        // `actingParticipations` both depend on it.
        const shared = await school.pupils
          .get('binh')!
          .post('/api/v1/contests/team-c/join')
          .send({ teamSlug: 'doi-2' });
        expect(shared.status, JSON.stringify(shared.body)).toBe(409);
        expect(shared.body.code).toBe('contest_already_joined');

        // Case-folded: two names that differ only in case are one name on a
        // printed standings sheet, and every consumer keys on that name.
        const sameName = await school.pupils
          .get('cuong')!
          .post('/api/v1/contests/team-c/join')
          .send({ teamSlug: 'doi-3' });
        expect(sameName.status, JSON.stringify(sameName.body)).toBe(409);
        expect(sameName.body.code).toBe('contest_team_name_taken');
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('refuses a RENAME that would put two same-named teams on one board', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const school = await ready(app, db);
        await school.teacher
          .post('/api/v1/orgs/school/teams')
          .send({ slug: 'doi-2', name: 'Đội 2', members: ['cuong'] });
        await school.pupils.get('anh')!.post('/api/v1/contests/team-c/join').send({ teamSlug: 'doi-1' });
        await school.pupils.get('cuong')!.post('/api/v1/contests/team-c/join').send({ teamSlug: 'doi-2' });

        // The join gate is not enough on its own: a rename is the same
        // collision by the back door, and it is not cosmetic — the board's
        // sidecar is keyed by the NAME, so two rows sharing one would make
        // the disqualify button move the wrong team.
        const collide = await school.teacher
          .patch('/api/v1/orgs/school/teams/doi-2')
          .send({ name: 'đội 1' });
        expect(collide.status, JSON.stringify(collide.body)).toBe(409);
        expect(collide.body.code).toBe('contest_team_name_taken');

        // A name nobody on that board holds is still free, and so is any
        // rename of a team that has entered nothing.
        const fine = await school.teacher
          .patch('/api/v1/orgs/school/teams/doi-2')
          .send({ name: 'Đội 3' });
        expect(fine.status, JSON.stringify(fine.body)).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('refuses a ROSTER EDIT that would put one pupil on two rows of one board', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'school', ['anh', 'binh', 'cuong']);
        await school.teacher
          .post('/api/v1/orgs/school/teams')
          .send({ slug: 'doi-1', name: 'Đội 1', members: ['anh'] });
        await school.teacher
          .post('/api/v1/orgs/school/teams')
          .send({ slug: 'doi-2', name: 'Đội 2', members: ['binh'] });
        await seedContest(db, { key: 'team-c', problemId: await problemId(db), orgSlug: 'school' });

        for (const [pupil, team] of [
          ['anh', 'doi-1'],
          ['binh', 'doi-2'],
        ] as const) {
          const joined = await school.pupils
            .get(pupil)!
            .post('/api/v1/contests/team-c/join')
            .send({ teamSlug: team });
          expect(joined.status, JSON.stringify(joined.body)).toBe(201);
        }

        // `join` refuses the second team that shares a member — but a PATCH
        // is the same collision arriving by the back door, exactly as a
        // rename was.
        //
        // The editor is the ADMIN, not the school's owner: B-18 wrote this
        // test when any admin of any of the contest's schools could edit a
        // roster mid-round, and F-25 landed `assertRosterUnlocked` after it,
        // which refuses that with `team_locked_during_contest` BEFORE the
        // double-seat check is ever reached. Both are right and they merged
        // without meeting; keeping the owner here would leave the check this
        // test exists for untested behind a 409 about something else.
        const clash = await school.admin
          .patch('/api/v1/orgs/school/teams/doi-2')
          .send({ members: ['binh', 'anh'] });
        expect(clash.status, JSON.stringify(clash.body)).toBe(409);
        expect(clash.body.code).toBe('contest_already_joined');
        expect(clash.body.detail).toContain('anh');

        // A pupil competing in nothing is added freely…
        const fine = await school.admin
          .patch('/api/v1/orgs/school/teams/doi-1')
          .send({ members: ['anh', 'cuong'] });
        expect(fine.status, JSON.stringify(fine.body)).toBe(200);

        // …and so is somebody who competes only on THIS team's own row: the
        // captain taken off by mistake has to be able to come back.
        const off = await school.admin
          .patch('/api/v1/orgs/school/teams/doi-1')
          .send({ members: ['cuong'] });
        expect(off.status, JSON.stringify(off.body)).toBe(200);
        const back = await school.admin
          .patch('/api/v1/orgs/school/teams/doi-1')
          .send({ members: ['cuong', 'anh'] });
        expect(back.status, JSON.stringify(back.body)).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('has no virtual replay: a team that never entered is refused after the end', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const school = await ready(app, db, { startsInMs: -2 * HOUR, endsInMs: -HOUR });
        const late = await school.pupils
          .get('anh')!
          .post('/api/v1/contests/team-c/join')
          .send({ teamSlug: 'doi-1' });
        expect(late.status, JSON.stringify(late.body)).toBe(409);
        expect(late.body.code).toBe('contest_team_no_virtual');
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

/* ------------------------------------------------- submitting as a team */

describe('a member submits, and the team is what scores', () => {
  it('routes every member’s submission onto the one participation, and names the row after the team', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'school', ['anh', 'binh']);
        await school.teacher
          .post('/api/v1/orgs/school/teams')
          .send({ slug: 'doi-1', name: 'Đội 1', members: ['anh', 'binh'] });
        await seedContest(db, { key: 'team-c', problemId: await problemId(db), orgSlug: 'school' });

        // `an` enters; `binh` never presses Join at all.
        const joined = await school.pupils
          .get('anh')!
          .post('/api/v1/contests/team-c/join')
          .send({ teamSlug: 'doi-1' });
        expect(joined.status, JSON.stringify(joined.body)).toBe(201);

        await clearSubmissionMeter(db);
        const theirs = await school.pupils
          .get('binh')!
          .post('/api/v1/submissions')
          .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'int main(){}', contestKey: 'team-c' });
        expect(theirs.status, JSON.stringify(theirs.body)).toBe(201);

        const [row] = await db
          .select({ participationId: contestSubmissions.participationId })
          .from(contestSubmissions)
          .where(eq(contestSubmissions.submissionId, theirs.body.id));
        expect(row!.participationId).toBe(joined.body.id);

        // The board prints the TEAM, and says who it is beside it.
        const board = await school.pupils.get('anh')!.get('/api/v1/contests/team-c/scoreboard');
        expect(board.status, JSON.stringify(board.body)).toBe(200);
        expect(board.body.ranking).toHaveLength(1);
        expect(board.body.ranking[0].participant).toBe('Đội 1');
        expect(board.body.teams['Đội 1']).toMatchObject({
          slug: 'doi-1',
          orgSlug: 'school',
          captain: 'anh',
        });
        expect(board.body.teams['Đội 1'].members).toEqual(['anh', 'binh']);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('stops a member removed mid-round from submitting for the team — the captain included', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'school', ['anh', 'binh']);
        await school.teacher
          .post('/api/v1/orgs/school/teams')
          .send({ slug: 'doi-1', name: 'Đội 1', members: ['anh', 'binh'] });
        await seedContest(db, { key: 'team-c', problemId: await problemId(db), orgSlug: 'school' });

        // `anh` presses Join, so the team's ONE participation is on `anh`'s
        // account — which is exactly the case a `user_id = ?` predicate
        // cannot tell apart from an individual entry.
        const joined = await school.pupils
          .get('anh')!
          .post('/api/v1/contests/team-c/join')
          .send({ teamSlug: 'doi-1' });
        expect(joined.status, JSON.stringify(joined.body)).toBe(201);

        // The pupil who did not turn up is taken off the roster mid-round —
        // the one edit an organiser actually makes on contest day (D99). By
        // the ADMIN: F-25's roster lock landed after this test and makes
        // this edit the organiser's alone, which is the rule it meant to
        // state. The school's own owner now gets
        // `team_locked_during_contest` here, correctly.
        const edited = await school.admin
          .patch('/api/v1/orgs/school/teams/doi-1')
          .send({ members: ['binh'] });
        expect(edited.status, JSON.stringify(edited.body)).toBe(200);

        await clearSubmissionMeter(db);
        const removed = await school.pupils
          .get('anh')!
          .post('/api/v1/submissions')
          .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'int main(){}', contestKey: 'team-c' });
        expect(removed.status, JSON.stringify(removed.body)).toBe(403);
        expect(removed.body.code).toBe('contest_not_joined');

        // …and the team goes on competing on the row they left behind.
        await clearSubmissionMeter(db);
        const theirs = await school.pupils
          .get('binh')!
          .post('/api/v1/submissions')
          .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'int main(){}', contestKey: 'team-c' });
        expect(theirs.status, JSON.stringify(theirs.body)).toBe(201);

        const [row] = await db
          .select({ participationId: contestSubmissions.participationId })
          .from(contestSubmissions)
          .where(eq(contestSubmissions.submissionId, theirs.body.id));
        expect(row!.participationId).toBe(joined.body.id);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('lets any member of a team ask a clarification, not only the one who joined', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'school', ['anh', 'binh']);
        await school.teacher
          .post('/api/v1/orgs/school/teams')
          .send({ slug: 'doi-1', name: 'Đội 1', members: ['anh', 'binh'] });
        await seedContest(db, { key: 'team-c', problemId: await problemId(db), orgSlug: 'school' });
        await school.pupils.get('anh')!.post('/api/v1/contests/team-c/join').send({ teamSlug: 'doi-1' });

        // `binh` never pressed Join — the team's participation is `anh`'s
        // row, and D99 says the question belongs to the team.
        const asked = await school.pupils
          .get('binh')!
          .post('/api/v1/contests/team-c/clarifications')
          .send({ question: 'Bài A có cho phép số âm không?' });
        expect(asked.status, JSON.stringify(asked.body)).toBe(201);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('serves no `teams` sidecar at all for an individual contest', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'school', ['anh']);
        await seedContest(db, {
          key: 'solo-c',
          problemId: await problemId(db),
          orgSlug: 'school',
          mode: 'individual',
        });
        await school.pupils.get('anh')!.post('/api/v1/contests/solo-c/join');
        const board = await school.pupils.get('anh')!.get('/api/v1/contests/solo-c/scoreboard');
        expect(board.status).toBe(200);
        expect(board.body.ranking[0].participant).toBe('anh');
        // Absent, not `{}`: an always-present field would put a DuckOJ key on
        // every board the goldens describe.
        expect('teams' in board.body).toBe(false);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

/* ------------------------------------------ disqualifying, freezing, rating */

describe('the team row is what an organiser acts on', () => {
  it('disqualifies the team through the captain’s username, and refuses the whole team’s submissions', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'school', ['anh', 'binh']);
        await school.teacher
          .post('/api/v1/orgs/school/teams')
          .send({ slug: 'doi-1', name: 'Đội 1', members: ['anh', 'binh'] });
        await seedContest(db, { key: 'team-c', problemId: await problemId(db), orgSlug: 'school' });
        await school.pupils.get('anh')!.post('/api/v1/contests/team-c/join').send({ teamSlug: 'doi-1' });

        // The contest's creator is a global admin here on purpose: this is
        // the one gate in the file that IS `canRunContest`.
        const organiser = request.agent(app.getHttpServer());
        await registerAndLogin(organiser, 'organiser');
        await db
          .update(contests)
          .set({ createdBy: await userIdOf(db, 'organiser') })
          .where(eq(contests.key, 'team-c'));

        const dq = await organiser
          .patch('/api/v1/contests/team-c/participants/anh')
          .send({ disqualified: true });
        expect(dq.status, JSON.stringify(dq.body)).toBe(200);
        expect(dq.body.isDisqualified).toBe(true);

        await clearSubmissionMeter(db);
        // The OTHER member is refused too: the disqualification is the
        // team's, because the row is.
        const refused = await school.pupils
          .get('binh')!
          .post('/api/v1/submissions')
          .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'int main(){}', contestKey: 'team-c' });
        expect(refused.status, JSON.stringify(refused.body)).toBe(403);
        expect(refused.body.code).toBe('contest_disqualified');

        const board = await school.pupils.get('anh')!.get('/api/v1/contests/team-c/scoreboard');
        expect(board.body.ranking[0].is_disqualified).toBe(true);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('refuses to rate a team contest', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'school', ['anh']);
        await seedContest(db, { key: 'team-c', problemId: await problemId(db), orgSlug: 'school' });
        const refused = await school.admin.post('/api/v1/admin/contests/team-c/rate');
        expect(refused.status, JSON.stringify(refused.body)).toBe(409);
        expect(refused.body.code).toBe('contest_team_unrateable');
        const [row] = await db
          .select({ isRated: contests.isRated })
          .from(contests)
          .where(eq(contests.key, 'team-c'));
        expect(row!.isRated).toBe(false);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('exports the team as one row, with its school and its people', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'school', ['anh', 'binh']);
        await school.teacher
          .post('/api/v1/orgs/school/teams')
          .send({ slug: 'doi-1', name: 'Đội 1', members: ['anh', 'binh'] });
        await seedContest(db, { key: 'team-c', problemId: await problemId(db), orgSlug: 'school' });
        await school.pupils.get('anh')!.post('/api/v1/contests/team-c/join').send({ teamSlug: 'doi-1' });

        const organiser = request.agent(app.getHttpServer());
        await registerAndLogin(organiser, 'organiser');
        await db
          .update(contests)
          .set({ createdBy: await userIdOf(db, 'organiser') })
          .where(eq(contests.key, 'team-c'));

        const csv = await organiser.get('/api/v1/contests/team-c/results.csv');
        expect(csv.status, csv.text).toBe(200);
        const [header, first] = csv.text.replace(/^\ufeff/, '').trimEnd().split('\r\n');
        // The `members` column exists only for a team contest: the header row
        // is the file's contract with whatever reads it next (D71).
        expect(header!.split(',').slice(0, 5)).toEqual([
          'rank',
          'username',
          'display_name',
          'orgs',
          'members',
        ]);
        expect(first).toContain('Đội 1');
        expect(first).toContain('anh; binh');
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

/* ------------------------------------------------------ the write path */

describe('creating and editing a team contest', () => {
  it('refuses a team contest with no organization, and freezes the mode once it starts', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const admin = await signIn(app, db, 'root', true);
        const created = await admin.post('/api/v1/orgs').send({
          slug: 'school',
          name: 'school',
          visibility: 'public',
          joinPolicy: 'invite',
        });
        expect(created.status).toBe(201);

        const orphan = await admin.post('/api/v1/contests').send({
          key: 'orphan',
          name: 'Orphan',
          startTime: new Date(Date.now() + HOUR).toISOString(),
          endTime: new Date(Date.now() + 2 * HOUR).toISOString(),
          format: 'icpc',
          participationMode: 'team',
        });
        expect(orphan.status, JSON.stringify(orphan.body)).toBe(422);
        expect(orphan.body.code).toBe('contest_team_orgs_required');

        const ok = await admin.post('/api/v1/contests').send({
          key: 'round',
          name: 'Round',
          startTime: new Date(Date.now() + HOUR).toISOString(),
          endTime: new Date(Date.now() + 2 * HOUR).toISOString(),
          format: 'icpc',
          participationMode: 'team',
          maxTeamSize: 2,
          orgSlugs: ['school'],
        });
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);
        expect(ok.body.participationMode).toBe('team');
        expect(ok.body.maxTeamSize).toBe(2);

        // Before the start both are editable — nothing can have joined yet.
        const early = await admin.patch('/api/v1/contests/round').send({ maxTeamSize: 3 });
        expect(early.status, JSON.stringify(early.body)).toBe(200);
        expect(early.body.maxTeamSize).toBe(3);

        await db
          .update(contests)
          .set({ startTime: new Date(Date.now() - MINUTE) })
          .where(eq(contests.key, 'round'));

        // Re-sending the stored value is a no-op (D38's rule: compared by
        // value, not by presence), so an edit form that PATCHes the whole
        // body back still saves.
        const noop = await admin
          .patch('/api/v1/contests/round')
          .send({ participationMode: 'team', maxTeamSize: 3, name: 'Round 2' });
        expect(noop.status, JSON.stringify(noop.body)).toBe(200);

        const swapped = await admin
          .patch('/api/v1/contests/round')
          .send({ participationMode: 'individual' });
        expect(swapped.status, JSON.stringify(swapped.body)).toBe(409);
        expect(swapped.body.code).toBe('contest_started');

        const resized = await admin.patch('/api/v1/contests/round').send({ maxTeamSize: 2 });
        expect(resized.status).toBe(409);
        expect(resized.body.code).toBe('contest_started');
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

/* ------------------------------- the problems a teammate may actually read */

/**
 * A contest's problems are PRIVATE until the round is over — that is the
 * ordinary shape, and it is what `ProblemViewContext.inJoinedContest` exists
 * for: joining a contest grants access to the problems in it, whatever their
 * own visibility says.
 *
 * A team holds ONE participation (D99), on the account of whichever member
 * pressed Join. So "do you hold a participation in a contest containing this
 * problem" — asked as `contest_participations.user_id = you` — is false for
 * every other member of every team in the province, and the two of three who
 * did not press the button can neither open the statement nor submit.
 */
describe('every member of a team may read the contest’s problems', () => {
  it('serves a private contest problem to a teammate who never pressed Join', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        await seedPrivateProblem(db);
        const school = await makeSchool(app, db, 'school', ['anh', 'binh', 'stranger']);
        await school.teacher
          .post('/api/v1/orgs/school/teams')
          .send({ slug: 'doi-1', name: 'Đội 1', members: ['anh', 'binh'] });
        await seedContest(db, {
          key: 'team-c',
          problemId: await problemIdOf(db, 'hidden'),
          orgSlug: 'school',
        });

        // `anh` enters; `binh` never presses Join at all.
        const joined = await school.pupils
          .get('anh')!
          .post('/api/v1/contests/team-c/join')
          .send({ teamSlug: 'doi-1' });
        expect(joined.status, JSON.stringify(joined.body)).toBe(201);

        const captain = await school.pupils.get('anh')!.get('/api/v1/problems/hidden');
        expect(captain.status, JSON.stringify(captain.body)).toBe(200);

        const teammate = await school.pupils.get('binh')!.get('/api/v1/problems/hidden');
        expect(teammate.status, JSON.stringify(teammate.body)).toBe(200);

        // The list form of the same predicate has to agree with the row form.
        const listed = await school.pupils.get('binh')!.get('/api/v1/problems');
        expect((listed.body.items as { code: string }[]).map((row) => row.code)).toContain('hidden');

        // And the round’s own statements stay shut to everybody else.
        const outsider = await school.pupils.get('stranger')!.get('/api/v1/problems/hidden');
        expect(outsider.status).toBe(404);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('accepts a teammate’s submission to a private contest problem', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        await seedPrivateProblem(db);
        const school = await makeSchool(app, db, 'school', ['anh', 'binh']);
        await school.teacher
          .post('/api/v1/orgs/school/teams')
          .send({ slug: 'doi-1', name: 'Đội 1', members: ['anh', 'binh'] });
        await seedContest(db, {
          key: 'team-c',
          problemId: await problemIdOf(db, 'hidden'),
          orgSlug: 'school',
        });
        const joined = await school.pupils
          .get('anh')!
          .post('/api/v1/contests/team-c/join')
          .send({ teamSlug: 'doi-1' });
        expect(joined.status, JSON.stringify(joined.body)).toBe(201);

        await clearSubmissionMeter(db);
        const theirs = await school.pupils
          .get('binh')!
          .post('/api/v1/submissions')
          .send({
            problemCode: 'hidden',
            languageKey: 'cpp17',
            source: 'int main(){}',
            contestKey: 'team-c',
          });
        expect(theirs.status, JSON.stringify(theirs.body)).toBe(201);

        const [row] = await db
          .select({ participationId: contestSubmissions.participationId })
          .from(contestSubmissions)
          .where(eq(contestSubmissions.submissionId, theirs.body.id));
        expect(row!.participationId).toBe(joined.body.id);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

/* ------------------------------------------------------ the monitor feed */

/**
 * Who the contest-day feed names when a team submits (D105).
 *
 * D95's feed is the invigilator's "what is happening right now", and the one
 * thing it is FOR is deciding whether to walk over to a machine. D99 landed
 * after it and made a team one participation held by whoever pressed Join, so
 * the feed's `join users on participation.user_id` started naming the captain
 * for every teammate's submission — a person who may not have touched a
 * keyboard, on the screen an invigilator uses to find the one who did.
 */
describe('the monitor feed in a team round (D105)', () => {
  it('names the pupil who submitted, and the team the row scores for', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'feed-school', ['faa', 'fbb']);
        await school.teacher
          .post('/api/v1/orgs/feed-school/teams')
          .send({ slug: 'doi-f', name: 'Đội F', members: ['faa', 'fbb'] });
        await seedContest(db, {
          key: 'feed-c',
          problemId: await problemId(db),
          orgSlug: 'feed-school',
        });

        // `faa` presses Join, so the team's one row is on `fa`'s account…
        const joined = await school.pupils
          .get('faa')!
          .post('/api/v1/contests/feed-c/join')
          .send({ teamSlug: 'doi-f' });
        expect(joined.status, JSON.stringify(joined.body)).toBe(201);

        // …and `fbb` is the one who actually submits.
        await clearSubmissionMeter(db);
        const sent = await school.pupils
          .get('fbb')!
          .post('/api/v1/submissions')
          .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'int main(){}', contestKey: 'feed-c' });
        expect(sent.status, JSON.stringify(sent.body)).toBe(201);

        const monitor = await school.admin.get('/api/v1/contests/feed-c/monitor');
        expect(monitor.status, JSON.stringify(monitor.body)).toBe(200);
        expect(monitor.body.feed).toHaveLength(1);
        expect(monitor.body.feed[0].username).toBe('fbb');
        // The team is carried beside the name rather than instead of it: the
        // board is keyed by team (D99), so without it the invigilator cannot
        // tell which row a submission scored on.
        expect(monitor.body.feed[0].team).toBe('Đội F');
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('leaves `team` null for an individual round', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'feed-solo', ['fss']);
        await seedContest(db, {
          key: 'feed-s',
          problemId: await problemId(db),
          orgSlug: 'feed-solo',
          mode: 'individual',
        });
        await school.pupils.get('fss')!.post('/api/v1/contests/feed-s/join').send({});
        await clearSubmissionMeter(db);
        await school.pupils
          .get('fss')!
          .post('/api/v1/submissions')
          .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'int main(){}', contestKey: 'feed-s' });

        const monitor = await school.admin.get('/api/v1/contests/feed-s/monitor');
        expect(monitor.body.feed[0].username).toBe('fss');
        expect(monitor.body.feed[0].team).toBeNull();
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

/* ------------------------------------------------------- the seat (D104) */

/**
 * One pupil, one seat per contest — enforced by the DATABASE (D104).
 *
 * B-18 finding 3 closed the roster PATCH's back door with a check, and said
 * what it could not close: a PATCH and a `join` run in two transactions that
 * do not serialise, so both can read a clean world and both can write. The
 * cost is D99's own list — `actingParticipations` picking between two rows by
 * id, `setDisqualified` moving both, one pupil's work counted twice on one
 * board — and no ordering of app-level reads and writes can prevent it,
 * because the fact being made unique spans two tables.
 *
 * `contest_seats` is that fact, materialised: one row per (contest, person)
 * for every LIVE participation, written by every path that seats anybody, and
 * unique.
 */
describe('one pupil holds one seat per contest (D104)', () => {
  async function seatsOf(db: Db, contestId: number): Promise<{ userId: number; participationId: number }[]> {
    return db
      .select({ userId: contestSeats.userId, participationId: contestSeats.participationId })
      .from(contestSeats)
      .where(eq(contestSeats.contestId, contestId))
      .orderBy(contestSeats.userId);
  }

  it('seats every member of a team that joins, on the team\u2019s one row', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'seat-a', ['sa1', 'sa2', 'sa3']);
        await school.teacher
          .post('/api/v1/orgs/seat-a/teams')
          .send({ slug: 'doi-a', name: 'Đội A', members: ['sa1', 'sa2'] });
        const { contestId } = await seedContest(db, {
          key: 'seat-ca',
          problemId: await problemId(db),
          orgSlug: 'seat-a',
          mode: 'team',
        });

        const joined = await school.pupils
          .get('sa1')!
          .post('/api/v1/contests/seat-ca/join')
          .send({ teamSlug: 'doi-a' });
        expect(joined.status, JSON.stringify(joined.body)).toBe(201);

        const seats = await seatsOf(db, contestId);
        // Both members, not just the one who pressed the button: the seat is
        // "this person is competing here", and D99 makes every member of the
        // team competing on its single row.
        expect(seats).toHaveLength(2);
        expect(seats.map((seat) => seat.participationId)).toEqual([
          seats[0]!.participationId,
          seats[0]!.participationId,
        ]);
        // The pupil who is on no team is seated by nothing.
        const [outsider] = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.username, 'sa3'));
        expect(seats.some((seat) => seat.userId === outsider!.id)).toBe(false);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('seats an individual join, and unseats nobody else', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'seat-b', ['sb1']);
        const { contestId } = await seedContest(db, {
          key: 'seat-cb',
          problemId: await problemId(db),
          orgSlug: 'seat-b',
          mode: 'individual',
        });

        const joined = await school.pupils.get('sb1')!.post('/api/v1/contests/seat-cb/join').send({});
        expect(joined.status, JSON.stringify(joined.body)).toBe(201);

        const seats = await seatsOf(db, contestId);
        expect(seats).toHaveLength(1);
        expect(seats[0]!.userId).toBe(await userIdOf(db, 'sb1'));
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('moves the seat with the roster: added members gain one, removed members lose theirs', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'seat-c', ['sc1', 'sc2', 'sc3']);
        await school.teacher
          .post('/api/v1/orgs/seat-c/teams')
          .send({ slug: 'doi-c', name: 'Đội C', members: ['sc1', 'sc2'] });
        // Not started yet, so the roster is still editable (F-25's lock).
        const { contestId } = await seedContest(db, {
          key: 'seat-cc',
          problemId: await problemId(db),
          orgSlug: 'seat-c',
          mode: 'team',
          startsInMs: HOUR,
          endsInMs: 2 * HOUR,
        });
        const seeded = await school.admin
          .post('/api/v1/contests/seat-cc/participants')
          .send({ teamSlug: 'doi-c' });
        expect(seeded.status, JSON.stringify(seeded.body)).toBe(201);
        expect(await seatsOf(db, contestId)).toHaveLength(2);

        const patched = await school.teacher
          .patch('/api/v1/orgs/seat-c/teams/doi-c')
          .send({ members: ['sc1', 'sc3'] });
        expect(patched.status, JSON.stringify(patched.body)).toBe(200);

        const seats = await seatsOf(db, contestId);
        const ids = new Set(seats.map((seat) => seat.userId));
        expect(ids.has(await userIdOf(db, 'sc1'))).toBe(true);
        expect(ids.has(await userIdOf(db, 'sc3'))).toBe(true);
        // A pupil taken off the roster stops competing on that row (D99), so
        // their seat goes with them — otherwise they could never be seated
        // anywhere else in this contest again.
        expect(ids.has(await userIdOf(db, 'sc2'))).toBe(false);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('answers 409, never 500, when the seat is already taken', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const school = await makeSchool(app, db, 'seat-d', ['sd1', 'sd2']);
        const { contestId } = await seedContest(db, {
          key: 'seat-cd',
          problemId: await problemId(db),
          orgSlug: 'seat-d',
          mode: 'individual',
        });
        const other = await school.pupils.get('sd2')!.post('/api/v1/contests/seat-cd/join').send({});
        expect(other.status).toBe(201);

        // The state a racing transaction leaves behind: a seat for sd1 that
        // no `contest_participations` row of theirs explains, so every
        // app-level check passes and only the index refuses.
        await db.insert(contestSeats).values({
          contestId,
          userId: await userIdOf(db, 'sd1'),
          participationId: (await db
            .select({ id: contestParticipations.id })
            .from(contestParticipations)
            .where(eq(contestParticipations.contestId, contestId)))[0]!.id,
        });

        const joined = await school.pupils.get('sd1')!.post('/api/v1/contests/seat-cd/join').send({});
        expect(joined.status, JSON.stringify(joined.body)).toBe(409);
        expect(joined.body.code).toBe('contest_already_joined');
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

/* ------------------------------------------------------------- the race */

describe('two teammates pressing Join at the same instant', () => {
  const opened: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const close of opened) await close();
  });

  it('mints one participation and answers the loser 409', async () => {
    const url = await testDbUrl();
    const { db, close } = createDb(url);
    opened.push(close);

    const app = await buildApp(db);
    try {
      await seedProblemAndLanguage(db);
      const school = await makeSchool(app, db, 'race-school', ['ran', 'rbn']);
      await school.teacher
        .post('/api/v1/orgs/race-school/teams')
        .send({ slug: 'doi-r', name: 'Đội R', members: ['ran', 'rbn'] });
      await seedContest(db, {
        key: 'race-c',
        problemId: await problemId(db),
        orgSlug: 'race-school',
      });

      const [a, b] = await Promise.all([
        school.pupils.get('ran')!.post('/api/v1/contests/race-c/join').send({ teamSlug: 'doi-r' }),
        school.pupils.get('rbn')!.post('/api/v1/contests/race-c/join').send({ teamSlug: 'doi-r' }),
      ]);
      const statuses = [a.status, b.status].sort((x, y) => x - y);
      expect(statuses, JSON.stringify([a.body, b.body])).toEqual([201, 409]);

      const [team] = await db
        .select({ id: teams.id })
        .from(teams)
        .where(eq(teams.slug, 'doi-r'));
      const rows = await db
        .select({ id: contestParticipations.id })
        .from(contestParticipations)
        .where(
          and(
            eq(contestParticipations.contestId, await contestIdOf(db, 'race-c')),
            eq(contestParticipations.teamId, team!.id),
          ),
        );
      expect(rows).toHaveLength(1);
    } finally {
      await app.close();
    }
  }, 180_000);
});

describe('a roster PATCH racing a join (D104)', () => {
  const opened: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const close of opened) await close();
  });

  /**
   * The interleaving, written as the two transactions' WRITES.
   *
   * It cannot be driven through the two HTTP routes: each service opens its
   * own transaction and commits it before returning, so nothing outside them
   * can hold one open across the other's read. What CAN be reproduced exactly
   * is the pair of write sets, in the order that defeats both app-level
   * checks — each transaction read a world in which the other had not
   * happened, and each check said yes. Only the database sees both.
   */
  it('cannot seat one pupil on two rows of one board', async () => {
    const url = await testDbUrl();
    const { db, close } = createDb(url);
    opened.push(close);

    const app = await buildApp(db);
    try {
      // This database is COMMITTED and shared with the block above, which has
      // already seeded a problem and a language; a second `aplusb` is a
      // unique violation rather than a fixture.
      const [seeded] = await db.select({ id: problems.id }).from(problems).limit(1);
      if (!seeded) await seedProblemAndLanguage(db);
      const school = await makeSchool(app, db, 'seat-race', ['sr1', 'sr2']);
      await school.teacher
        .post('/api/v1/orgs/seat-race/teams')
        .send({ slug: 'doi-x', name: 'Đội X', members: ['sr1'] });
      await school.teacher
        .post('/api/v1/orgs/seat-race/teams')
        .send({ slug: 'doi-y', name: 'Đội Y', members: ['sr2'] });
      const { contestId } = await seedContest(db, {
        key: 'seat-race-c',
        problemId: await problemId(db),
        orgSlug: 'seat-race',
        mode: 'team',
      });
      // Đội X is already competing; sr2 is on Đội Y, which is not.
      const entered = await school.pupils
        .get('sr1')!
        .post('/api/v1/contests/seat-race-c/join')
        .send({ teamSlug: 'doi-x' });
      expect(entered.status, JSON.stringify(entered.body)).toBe(201);

      const [x] = await db.select({ id: teams.id }).from(teams).where(eq(teams.slug, 'doi-x'));
      const [y] = await db.select({ id: teams.id }).from(teams).where(eq(teams.slug, 'doi-y'));
      const [xRow] = await db
        .select({ id: contestParticipations.id })
        .from(contestParticipations)
        .where(
          and(eq(contestParticipations.contestId, contestId), eq(contestParticipations.teamId, x!.id)),
        );
      const sr2 = await userIdOf(db, 'sr2');

      const a = createDb(url);
      const b = createDb(url);
      opened.push(a.close, b.close);

      // A: the roster PATCH puts sr2 on Đội X — whose participation already
      // exists, so the PATCH seats them on it.
      const patchDone = a.db.transaction(async (tx) => {
        await tx.insert(teamMembers).values({ teamId: x!.id, userId: sr2 });
        await tx
          .insert(contestSeats)
          .values({ contestId, userId: sr2, participationId: xRow!.id });
        await tx.execute(sql`select pg_sleep(0.4)`);
      });

      // B: meanwhile Đội Y joins, seating sr2 on its own new row. One of the
      // two has to lose.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const joinDone = b.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(contestParticipations)
          .values({
            contestId,
            userId: sr2,
            teamId: y!.id,
            virtual: 0,
            startTime: new Date(),
            isDisqualified: false,
          })
          .returning({ id: contestParticipations.id });
        await tx
          .insert(contestSeats)
          .values({ contestId, userId: sr2, participationId: row!.id });
      });

      const outcomes = await Promise.allSettled([patchDone, joinDone]);
      const refused = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(refused, JSON.stringify(outcomes.map((o) => o.status))).toHaveLength(1);

      // And the board is intact: sr2 sits on exactly one row.
      const seats = await db
        .select({ id: contestSeats.participationId })
        .from(contestSeats)
        .where(and(eq(contestSeats.contestId, contestId), eq(contestSeats.userId, sr2)));
      expect(seats).toHaveLength(1);
    } finally {
      await app.close();
    }
  }, 180_000);
});

async function contestIdOf(db: Db, key: string): Promise<number> {
  const [row] = await db.select({ id: contests.id }).from(contests).where(eq(contests.key, key));
  return row!.id;
}

async function problemIdOf(db: Db, code: string): Promise<number> {
  const [row] = await db.select({ id: problems.id }).from(problems).where(eq(problems.code, code));
  return row!.id;
}
