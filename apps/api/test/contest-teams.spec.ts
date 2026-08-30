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
import { and, eq } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import {
  contestOrgs,
  contestParticipations,
  contestProblems,
  contestSubmissions,
  contests,
  organizations,
  problems,
  teams,
} from '@duckoj/db/guarded';
import { createDb, schema, type Db } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { testDbUrl, withTestDb } from './db.harness.js';
import {
  clearSubmissionMeter,
  insertUser,
  registerAndLogin,
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
          .where(eq(contestParticipations.contestId, first.body.id > 0 ? await contestIdOf(db, 'team-c') : 0));
        expect(rows).toHaveLength(1);
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
        const [header, first] = csv.text.replace(/^﻿/, '').trimEnd().split('\r\n');
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

async function contestIdOf(db: Db, key: string): Promise<number> {
  const [row] = await db.select({ id: contests.id }).from(contests).where(eq(contests.key, key));
  return row!.id;
}
