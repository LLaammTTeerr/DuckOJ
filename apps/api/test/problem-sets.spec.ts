/**
 * Classroom problem sets — homework, "bài tập về nhà" (D66).
 *
 * Everything here goes over HTTP against the real controller, because half
 * of what this feature IS lives in the gates: who may see a set, who may see
 * the grid, and what the two answer to somebody who may not.
 *
 * The one exception is the last block, which needs two committed
 * transactions on two connections and so runs on `testDbUrl()` rather than
 * `withTestDb`'s rollback — the same split `org-member-import.spec.ts` makes,
 * and for the same reason.
 */
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import {
  contestParticipations,
  contestProblems,
  contestSubmissions,
  contests,
  organizations,
  problemOrgs,
  problems,
  submissions,
} from '@duckoj/db/guarded';
import { createDb, schema, type Db } from '@duckoj/db';
import { progressCsv } from '../src/authz/problem-set.access.js';
import { buildApp } from './app.harness.js';
import { testDbUrl, withTestDb } from './db.harness.js';
import {
  insertUser,
  registerAndLogin,
  seedProblemAndLanguage,
  seedProblemWithSourceAccess,
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

/**
 * An organization created by a global admin (the only actor `POST /orgs`
 * admits), with `teacher` as a NON-admin owner and every other name a plain
 * member. The distinction matters everywhere here: a global admin passes
 * every gate in this file for the wrong reason, so no test uses one as its
 * subject.
 */
async function makeOrg(
  app: INestApplication,
  db: Db,
  slug: string,
  visibility: 'public' | 'private',
  members: string[] = [],
): Promise<{ admin: Agent; teacher: Agent; members: Map<string, Agent> }> {
  const admin = await signIn(app, db, `${slug}-root`, true);
  const created = await admin.post('/orgs').send({ slug, name: slug, visibility, joinPolicy: 'invite' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);

  const teacher = await signIn(app, db, `${slug}-teacher`);
  const added = await admin.post(`/orgs/${slug}/members`).send({ username: `${slug}-teacher`, role: 'owner' });
  expect(added.status, JSON.stringify(added.body)).toBe(201);

  const agents = new Map<string, Agent>();
  for (const name of members) {
    agents.set(name, await signIn(app, db, name));
    const res = await admin.post(`/orgs/${slug}/members`).send({ username: name, role: 'member' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
  return { admin, teacher, members: agents };
}

async function orgIdOf(db: Db, slug: string): Promise<number> {
  const [row] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug));
  return row!.id;
}

async function userIdOf(db: Db, username: string): Promise<number> {
  const [row] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username));
  return row!.id;
}

/** One graded submission, at a chosen instant. */
async function submit(
  db: Db,
  opts: {
    userId: number;
    problemId: number;
    verdict: 'AC' | 'WA' | 'CE';
    points?: number | null;
    createdAt: Date;
  },
): Promise<number> {
  const [language] = await db
    .select({ id: schema.languages.id })
    .from(schema.languages)
    .where(eq(schema.languages.key, 'cpp17'));
  const [problem] = await db
    .select({ currentRevisionId: problems.currentRevisionId })
    .from(problems)
    .where(eq(problems.id, opts.problemId));
  const [row] = await db
    .insert(submissions)
    .values({
      userId: opts.userId,
      problemId: opts.problemId,
      revisionId: problem!.currentRevisionId!,
      languageId: language!.id,
      source: 'src',
      state: 'done',
      verdict: opts.verdict,
      points: opts.points === undefined ? (opts.verdict === 'AC' ? 100 : 30) : opts.points,
      maxPoints: 100,
      createdAt: opts.createdAt,
    })
    .returning({ id: submissions.id });
  return row!.id;
}

/** A contest still running, with `submissionId` routed into it. */
async function routeIntoOpenContest(
  db: Db,
  opts: { key: string; problemId: number; userId: number; submissionId: number },
): Promise<void> {
  const owner = await insertUser(db, `${opts.key}-owner`, 'admin');
  const start = new Date(Date.now() - 10 * MINUTE);
  const [contest] = await db
    .insert(contests)
    .values({
      key: opts.key,
      name: opts.key,
      startTime: start,
      endTime: new Date(start.getTime() + 5 * HOUR),
      format: 'icpc',
      visibility: 'public',
      createdBy: owner.id,
    })
    .returning({ id: contests.id });
  const [contestProblem] = await db
    .insert(contestProblems)
    .values({ contestId: contest!.id, problemId: opts.problemId, label: 'A', points: 100, order: 0 })
    .returning({ id: contestProblems.id });
  const [participation] = await db
    .insert(contestParticipations)
    .values({ contestId: contest!.id, userId: opts.userId, virtual: 0, startTime: start })
    .returning({ id: contestParticipations.id });
  await db.insert(contestSubmissions).values({
    participationId: participation!.id,
    contestProblemId: contestProblem!.id,
    submissionId: opts.submissionId,
  });
}

describe('assigning a set', () => {
  it('creates it, orders the items, and serves it to a member', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        await seedProblemWithSourceAccess(db, { code: 'second' });
        const org = await makeOrg(app, db, 'school', 'public', ['pupil']);

        const created = await org.teacher.post('/orgs/school/sets').send({
          slug: 'week-1',
          name: 'Tuần 1',
          description: 'Ôn tập',
          problems: [{ code: 'second', points: 50 }, { code: 'aplusb' }],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        // The request's order, not the codes' — a teacher's sequence is the
        // sequence.
        expect(created.body.items.map((i: { code: string }) => i.code)).toEqual(['second', 'aplusb']);
        expect(created.body.items[0].points).toBe(50);
        // The default from the contract, not from the column, is what a
        // client that omitted `points` gets back.
        expect(created.body.items[1].points).toBe(100);
        expect(created.body.itemCount).toBe(2);

        const seen = await org.members.get('pupil')!.get('/orgs/school/sets/week-1');
        expect(seen.status).toBe(200);
        expect(seen.body.name).toBe('Tuần 1');
        expect(seen.body.items[0].me).toBeNull();
        expect(seen.body.solvedCount).toBe(0);

        const listed = await org.members.get('pupil')!.get('/orgs/school/sets');
        expect(listed.body.items).toHaveLength(1);
        expect(listed.body.items[0].itemCount).toBe(2);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('refuses a duplicate slug with nothing created', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const org = await makeOrg(app, db, 'dup', 'public');
        await org.teacher.post('/orgs/dup/sets').send({ slug: 'week-1', name: 'One' });
        const again = await org.teacher.post('/orgs/dup/sets').send({ slug: 'week-1', name: 'Two' });
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('problem_set_slug_taken');

        const listed = await org.teacher.get('/orgs/dup/sets');
        expect(listed.body.items).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('refuses a problem the school cannot open, and names the row', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        await seedProblemWithSourceAccess(db, { code: 'secret', visibility: 'private' });
        const org = await makeOrg(app, db, 'refuse', 'public');

        const refused = await org.teacher.post('/orgs/refuse/sets').send({
          slug: 'week-1',
          name: 'One',
          problems: [{ code: 'aplusb' }, { code: 'secret' }],
        });
        expect(refused.status).toBe(422);
        expect(refused.body.code).toBe('problem_set_problem_private');
        expect(refused.body.fields['problems[1].code']).toHaveLength(1);
        // Nothing created: the set is refused whole, never half-assigned.
        expect((await org.teacher.get('/orgs/refuse/sets')).body.items).toEqual([]);

        const unknown = await org.teacher.post('/orgs/refuse/sets').send({
          slug: 'week-2',
          name: 'Two',
          problems: [{ code: 'nope' }],
        });
        expect(unknown.status).toBe(422);
        expect(unknown.body.code).toBe('problem_set_problem_unknown');

        const twice = await org.teacher.post('/orgs/refuse/sets').send({
          slug: 'week-3',
          name: 'Three',
          problems: [{ code: 'aplusb' }, { code: 'APLUSB' }],
        });
        expect(twice.status).toBe(422);
        expect(twice.body.code).toBe('problem_set_problem_duplicate');
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('accepts an org-visible problem for the school it is shared with, and refuses it for another', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const shared = await seedProblemWithSourceAccess(db, { code: 'shared', visibility: 'org' });
        const mine = await makeOrg(app, db, 'mine', 'public');
        const other = await makeOrg(app, db, 'other', 'public');
        await db.insert(problemOrgs).values({ problemId: shared.id, orgId: await orgIdOf(db, 'mine') });

        const ok = await mine.teacher
          .post('/orgs/mine/sets')
          .send({ slug: 'wk', name: 'W', problems: [{ code: 'shared' }] });
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);

        const no = await other.teacher
          .post('/orgs/other/sets')
          .send({ slug: 'wk', name: 'W', problems: [{ code: 'shared' }] });
        expect(no.status).toBe(422);
        expect(no.body.code).toBe('problem_set_problem_private');
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

describe('who may read a set', () => {
  it('hides a private school entirely, and answers a public one with an empty page to an outsider', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const secret = await makeOrg(app, db, 'secret-school', 'private');
        await secret.teacher.post('/orgs/secret-school/sets').send({ slug: 'wk', name: 'W' });
        const open = await makeOrg(app, db, 'open-school', 'public');
        await open.teacher.post('/orgs/open-school/sets').send({ slug: 'wk', name: 'W' });

        const outsider = await signIn(app, db, 'outsider');

        // A school the caller may not see: the organization's own 404,
        // unchanged, with no mention of sets.
        expect((await outsider.get('/orgs/secret-school/sets')).status).toBe(404);
        expect((await outsider.get('/orgs/secret-school/sets/wk')).status).toBe(404);

        // A school they CAN see but do not belong to: the list is empty —
        // exactly what a school that has assigned nothing returns — and the
        // set itself is a 404, indistinguishable from one that never existed.
        const listed = await outsider.get('/orgs/open-school/sets');
        expect(listed.status).toBe(200);
        expect(listed.body.items).toEqual([]);
        const detail = await outsider.get('/orgs/open-school/sets/wk');
        expect(detail.status).toBe(404);
        expect(detail.body.code).toBe('problem_set_not_found');

        // And an anonymous reader never even reaches the service.
        expect((await request(app.getHttpServer()).get('/orgs/open-school/sets')).status).toBe(401);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('lets a global admin read a school they have never joined', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const org = await makeOrg(app, db, 'audited', 'private');
        await org.teacher
          .post('/orgs/audited/sets')
          .send({ slug: 'wk', name: 'W', problems: [{ code: 'aplusb' }] });

        // A global admin holds no membership anywhere — `myRole` is a
        // membership fact, not a permission (D58) — so "member or admin" has
        // to be spelled with the admin half or the province's own
        // administrator is an outsider to every school on the judge.
        const superuser = await signIn(app, db, 'auditor', true);
        expect((await superuser.get('/orgs/audited/sets')).body.items).toHaveLength(1);
        expect((await superuser.get('/orgs/audited/sets/wk')).status).toBe(200);
        expect((await superuser.get('/orgs/audited/sets/wk/progress')).status).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('lets a plain member read, but not run, the set', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const org = await makeOrg(app, db, 'roles', 'public', ['pupil']);
        await org.teacher.post('/orgs/roles/sets').send({ slug: 'wk', name: 'W' });
        const pupil = org.members.get('pupil')!;

        expect((await pupil.get('/orgs/roles/sets/wk')).status).toBe(200);
        expect((await pupil.post('/orgs/roles/sets').send({ slug: 'wx', name: 'X' })).status).toBe(403);
        expect((await pupil.patch('/orgs/roles/sets/wk').send({ name: 'X' })).status).toBe(403);
        expect((await pupil.delete('/orgs/roles/sets/wk')).status).toBe(403);
        // The grid is about other people, so it is the owners' screen.
        expect((await pupil.get('/orgs/roles/sets/wk/progress')).status).toBe(403);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

describe('the deadline', () => {
  it('counts the best on-time attempt, and shows a late solve beside it rather than instead of it', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const org = await makeOrg(app, db, 'late', 'public', ['pupil']);
        const deadline = new Date(Date.now() - 2 * HOUR);
        const created = await org.teacher.post('/orgs/late/sets').send({
          slug: 'wk',
          name: 'W',
          deadline: deadline.toISOString(),
          problems: [{ code: 'aplusb' }],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);

        const pupilId = await userIdOf(db, 'pupil');
        const problemId = (await db.select({ id: problems.id }).from(problems).where(eq(problems.code, 'aplusb')))[0]!
          .id;
        await submit(db, {
          userId: pupilId,
          problemId,
          verdict: 'WA',
          createdAt: new Date(deadline.getTime() - HOUR),
        });
        // AT the deadline is ON TIME — the bound is inclusive, and a pupil
        // who submitted on the stroke of it is not late.
        await submit(db, { userId: pupilId, problemId, verdict: 'WA', points: 60, createdAt: deadline });
        const solvedAt = new Date(deadline.getTime() + HOUR);
        await submit(db, { userId: pupilId, problemId, verdict: 'AC', createdAt: solvedAt });

        const seen = await org.members.get('pupil')!.get('/orgs/late/sets/wk');
        const cell = seen.body.items[0].me;
        expect(cell.onTime.points).toBe(60);
        expect(cell.onTime.verdict).toBe('WA');
        expect(cell.onTime.solvedAt).toBeNull();
        expect(cell.late.verdict).toBe('AC');
        expect(cell.late.solvedAt).toBe(solvedAt.toISOString());
        // The homework is done, even though it was done late.
        expect(seen.body.solvedCount).toBe(1);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('has no late side at all when the set has no deadline', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const org = await makeOrg(app, db, 'undated', 'public', ['pupil']);
        await org.teacher
          .post('/orgs/undated/sets')
          .send({ slug: 'wk', name: 'W', problems: [{ code: 'aplusb' }] });

        const problemId = (await db.select({ id: problems.id }).from(problems).where(eq(problems.code, 'aplusb')))[0]!
          .id;
        await submit(db, {
          userId: await userIdOf(db, 'pupil'),
          problemId,
          verdict: 'AC',
          createdAt: new Date(),
        });

        const cell = (await org.members.get('pupil')!.get('/orgs/undated/sets/wk')).body.items[0].me;
        expect(cell.late).toBeNull();
        expect(cell.onTime.verdict).toBe('AC');
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

describe('the progress grid', () => {
  it('is the roster against the set, and counts no submission whose contest is still running', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        await seedProblemWithSourceAccess(db, { code: 'second' });
        const org = await makeOrg(app, db, 'grid', 'public', ['anna', 'bao']);
        await org.teacher.post('/orgs/grid/sets').send({
          slug: 'wk',
          name: 'W',
          problems: [{ code: 'aplusb' }, { code: 'second' }],
        });

        const aplusb = (await db.select({ id: problems.id }).from(problems).where(eq(problems.code, 'aplusb')))[0]!.id;
        const second = (await db.select({ id: problems.id }).from(problems).where(eq(problems.code, 'second')))[0]!.id;
        const annaId = await userIdOf(db, 'anna');
        await submit(db, { userId: annaId, problemId: aplusb, verdict: 'AC', createdAt: new Date() });
        // Anna's second submission is inside a contest that is still running.
        // D49: it counts for nobody yet — not even for the teacher.
        const inContest = await submit(db, {
          userId: annaId,
          problemId: second,
          verdict: 'AC',
          createdAt: new Date(),
        });
        await routeIntoOpenContest(db, {
          key: 'live-now',
          problemId: second,
          userId: annaId,
          submissionId: inContest,
        });

        const grid = await org.teacher.get('/orgs/grid/sets/wk/progress');
        expect(grid.status, JSON.stringify(grid.body)).toBe(200);
        expect(grid.body.columns.map((c: { code: string }) => c.code)).toEqual(['aplusb', 'second']);
        const anna = grid.body.rows.find((r: { username: string }) => r.username === 'anna');
        expect(anna.cells[0].onTime.verdict).toBe('AC');
        expect(anna.cells[1]).toBeNull();
        const bao = grid.body.rows.find((r: { username: string }) => r.username === 'bao');
        expect(bao.cells).toEqual([null, null]);

        // Anna herself still sees her own result: D23 exempts a submission's
        // own author from every mask in this codebase.
        const hers = await org.members.get('anna')!.get('/orgs/grid/sets/wk');
        expect(hers.body.items[1].me.onTime.verdict).toBe('AC');
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('pages the rows on username, and refuses a cursor no username could be', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const org = await makeOrg(app, db, 'paged', 'public', ['anna', 'bao']);
        await org.teacher.post('/orgs/paged/sets').send({ slug: 'wk', name: 'W' });

        const first = await org.teacher.get('/orgs/paged/sets/wk/progress?limit=1');
        expect(first.body.rows).toHaveLength(1);
        expect(first.body.nextCursor).toBe(first.body.rows[0].username);
        const next = await org.teacher.get(
          `/orgs/paged/sets/wk/progress?limit=1&cursor=${String(first.body.nextCursor)}`,
        );
        expect(next.body.rows[0].username > first.body.rows[0].username).toBe(true);

        const bad = await org.teacher.get(`/orgs/paged/sets/wk/progress?cursor=${'x'.repeat(200)}`);
        expect(bad.status).toBe(422);
        expect(bad.body.code).toBe('invalid_cursor');
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('exports the WHOLE roster as CSV, with a late column because the set has a deadline', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const org = await makeOrg(app, db, 'sheet', 'public', ['anna', 'bao']);
        const deadline = new Date(Date.now() - HOUR);
        await org.teacher.post('/orgs/sheet/sets').send({
          slug: 'wk',
          name: 'W',
          deadline: deadline.toISOString(),
          problems: [{ code: 'aplusb' }],
        });
        const aplusb = (await db.select({ id: problems.id }).from(problems).where(eq(problems.code, 'aplusb')))[0]!.id;
        await submit(db, {
          userId: await userIdOf(db, 'anna'),
          problemId: aplusb,
          verdict: 'AC',
          createdAt: new Date(deadline.getTime() + MINUTE),
        });

        // `limit=1` is honoured by the JSON grid and IGNORED by the export:
        // a file that stops after one pupil is a file somebody would mark a
        // class from.
        const csv = await org.teacher.get('/orgs/sheet/sets/wk/progress?format=csv&limit=1');
        expect(csv.status).toBe(200);
        expect(csv.headers['content-type']).toContain('text/csv');
        expect(csv.headers['content-disposition']).toContain('sheet-wk.csv');
        // NOT `.trim()`: JS treats U+FEFF as whitespace, so trimming the
        // response would quietly throw away the BOM this file is judged on.
        const lines = (csv.text as string).replace(/\r\n$/, '').split('\r\n');
        expect(lines[0]).toBe('\ufeffusername,displayName,aplusb,aplusb (late)');
        // Four members: the creating admin, the teacher, and both pupils.
        expect(lines).toHaveLength(5);
        expect(lines.find((line) => line.startsWith('anna,'))).toBe('anna,anna,,100');
        expect(lines.find((line) => line.startsWith('bao,'))).toBe('bao,bao,,');
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

describe('editing and withdrawing a set', () => {
  it('replaces the problem list, moves the deadline, and deletes the set with its items', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        await seedProblemWithSourceAccess(db, { code: 'second' });
        const org = await makeOrg(app, db, 'edit', 'public');
        await org.teacher
          .post('/orgs/edit/sets')
          .send({ slug: 'wk', name: 'W', problems: [{ code: 'aplusb' }] });

        const patched = await org.teacher.patch('/orgs/edit/sets/wk').send({
          name: 'W2',
          deadline: new Date(Date.now() + HOUR).toISOString(),
          problems: [{ code: 'second', points: 5 }],
        });
        expect(patched.status, JSON.stringify(patched.body)).toBe(200);
        expect(patched.body.name).toBe('W2');
        expect(patched.body.deadline).not.toBeNull();
        // REPLACED, not merged: the old problem is gone.
        expect(patched.body.items.map((i: { code: string }) => i.code)).toEqual(['second']);

        // A deadline can be taken off again — `null` is a value, not "absent".
        const cleared = await org.teacher.patch('/orgs/edit/sets/wk').send({ deadline: null });
        expect(cleared.body.deadline).toBeNull();

        expect((await org.teacher.delete('/orgs/edit/sets/wk')).status).toBe(204);
        expect((await org.teacher.get('/orgs/edit/sets/wk')).status).toBe(404);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('marks an item the viewer can no longer open rather than dropping it', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblemAndLanguage(db);
        const shared = await seedProblemWithSourceAccess(db, { code: 'shared', visibility: 'org' });
        const org = await makeOrg(app, db, 'narrowed', 'public', ['pupil']);
        await db.insert(problemOrgs).values({ problemId: shared.id, orgId: await orgIdOf(db, 'narrowed') });
        await org.teacher
          .post('/orgs/narrowed/sets')
          .send({ slug: 'wk', name: 'W', problems: [{ code: 'shared' }] });

        const before = await org.members.get('pupil')!.get('/orgs/narrowed/sets/wk');
        expect(before.body.items[0].visible).toBe(true);

        // The setter narrows the problem after it was assigned. The item
        // stays — the teacher assigned it — but the page must not offer a
        // link that 404s.
        await db.update(problems).set({ visibility: 'private' }).where(eq(problems.id, shared.id));
        const after = await org.members.get('pupil')!.get('/orgs/narrowed/sets/wk');
        expect(after.body.items).toHaveLength(1);
        expect(after.body.items[0].visible).toBe(false);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

/**
 * Two committed transactions on two connections: `withTestDb` runs
 * everything inside one rolled-back transaction, where a "concurrent"
 * duplicate is a savepoint of the same xid and never collides.
 */
describe('two teachers assigning the same slug at once', () => {
  const opened: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const close of opened) await close();
  });

  it('lets exactly one through and answers the other 409', async () => {
    const url = await testDbUrl();
    const { db, close } = createDb(url);
    opened.push(close);

    const app = await buildApp(db);
    try {
      await seedProblemAndLanguage(db);
      const org = await makeOrg(app, db, 'race-school', 'public');
      const [a, b] = await Promise.all([
        org.teacher.post('/orgs/race-school/sets').send({ slug: 'wk', name: 'A' }),
        org.teacher.post('/orgs/race-school/sets').send({ slug: 'wk', name: 'B' }),
      ]);
      const statuses = [a.status, b.status].sort((x, y) => x - y);
      expect(statuses).toEqual([201, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body.code).toBe('problem_set_slug_taken');
    } finally {
      await app.close();
    }
  }, 180_000);
});

describe("the homework sheet's bytes", () => {
  /** The smallest grid that still has a person-typed cell in it. */
  function grid(rows: { username: string; displayName: string }[]) {
    return {
      slug: 'wk',
      name: 'W',
      deadline: null,
      columns: [{ code: 'aplusb', name: 'A+B', points: 100 }],
      rows: rows.map((row) => ({ ...row, role: 'member' as const, cells: [null] })),
      nextCursor: null,
    };
  }

  it('opens with a BOM and ends every line with CRLF, like the results sheet (D71)', () => {
    // Without the BOM Excel opens the file in the machine's ANSI code page,
    // and every name in a Vietnamese class list arrives as mojibake — the
    // whole reason D71 wrote the BOM down, for a file with strictly fewer
    // Vietnamese names in it than this one.
    const csv = progressCsv(grid([{ username: 'anna', displayName: 'Nguyễn Văn A' }]));
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toBe('﻿username,displayName,aplusb\r\nanna,Nguyễn Văn A,\r\n');
  });

  it('neutralises a display name a pupil set to a formula', () => {
    // The one export whose person-typed column is chosen by the person being
    // exported: a pupil picks their own display name, and their teacher is
    // the one who opens the file.
    const csv = progressCsv(grid([{ username: 'anna', displayName: '=HYPERLINK("http://evil","A")' }]));
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""A"")"`);
  });

  it('leaves a generated cell alone', () => {
    // A score cannot begin `=`, and a guard firing on one would turn every
    // number in the sheet into text.
    const scored = {
      ...grid([{ username: 'anna', displayName: 'A' }]),
      rows: [
        {
          username: 'anna',
          displayName: 'A',
          role: 'member' as const,
          cells: [
            { onTime: { verdict: 'AC', points: 100, solvedAt: null, submissionId: 1 }, late: null },
          ],
        },
      ],
    };
    expect(progressCsv(scored as never)).toContain('anna,A,100');
  });

  it('keeps the truncation trailer distinguishable from a pupil called `truncated`', () => {
    // `truncated` is a perfectly valid username (D8), so the trailer's own
    // comment — "a value no account can hold" — was wrong. What actually
    // tells them apart is the width: a data row carries a cell per column.
    const cut = progressCsv(grid([{ username: 'truncated', displayName: 'T' }]), true);
    const lines = cut.trimEnd().split('\r\n');
    expect(lines.at(-1)).toBe('truncated,1');
    expect(lines.at(-2)).toBe('truncated,T,');
  });
});
