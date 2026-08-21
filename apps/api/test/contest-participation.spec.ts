/**
 * Phase 4d: joining a contest, and routing a submission into one.
 *
 * The contest formats, the persistence mapping and the scoreboard are all
 * already green in isolation. What was never testable before this phase is the
 * path a real competitor takes — join, submit, be refused once the window
 * shuts — because nothing in the product had ever written a
 * `contest_submissions` row.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import {
  contestProblems,
  contestSubmissions,
  contests,
  submissionCases,
  submissions,
} from '@duckoj/db/guarded';
import type { Db } from '@duckoj/db';
import {
  listParticipations,
  participationWindow,
  resolveContestTarget,
} from '../src/authz/participation.js';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import {
  insertUser,
  registerAndLogin,
  seedProblemAndLanguage,
  seedProblemWithSourceAccess,
  userIdOf,
} from './submissions.fixtures.js';

const MINUTE = 60_000;
/** A user to own the seeded contests, distinct from any problem's owner. */
const CONTEST_OWNER = 'contest-owner';

/**
 * A contest whose window is expressed relative to *now*, so a test can put
 * itself before, inside or after it without waiting.
 */
async function seedContestWith(
  db: Db,
  opts: {
    key: string;
    problemId: number;
    startsInMs: number;
    endsInMs: number;
    visibility?: 'private' | 'org' | 'public';
    timeLimitSeconds?: number | null;
  },
): Promise<{ contestId: number; contestProblemId: number }> {
  const now = Date.now();
  const owner = await userIdOf(db, CONTEST_OWNER);
  const [contest] = await db
    .insert(contests)
    .values({
      key: opts.key,
      name: opts.key,
      startTime: new Date(now + opts.startsInMs),
      endTime: new Date(now + opts.endsInMs),
      timeLimitSeconds: opts.timeLimitSeconds ?? null,
      format: 'icpc',
      visibility: opts.visibility ?? 'public',
      createdBy: owner,
    })
    .returning({ id: contests.id });
  const [cp] = await db
    .insert(contestProblems)
    .values({
      contestId: contest!.id,
      problemId: opts.problemId,
      label: 'A',
      points: 100,
      order: 0,
    })
    .returning({ id: contestProblems.id });
  return { contestId: contest!.id, contestProblemId: cp!.id };
}

/** Seeds the language, an owner for contests, and a published problem. */
async function baseline(db: Db, code: string, visibility: 'private' | 'public' = 'public') {
  await seedProblemAndLanguage(db);
  await insertUser(db, CONTEST_OWNER);
  return seedProblemWithSourceAccess(db, { code, visibility });
}

describe('POST /contests/:key/join', () => {
  it('is idempotent for a live join — twice yields one participation', async () => {
    await withTestDb(async (db) => {
      const problem = await baseline(db, 'cp-owner');
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'joiner');
        await seedContestWith(db, {
          key: 'live-1',
          problemId: problem.id,
          startsInMs: -MINUTE,
          endsInMs: 60 * MINUTE,
        });

        const first = await agent.post('/contests/live-1/join');
        expect(first.status).toBe(201);
        const second = await agent.post('/contests/live-1/join');
        expect(second.status).toBe(201);
        // The same row, not a second one. A retrying client must not be able
        // to fork its own participation.
        expect(second.body.id).toBe(first.body.id);
        expect(second.body.virtual).toBe(0);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses before the start, and creates successive virtual attempts after the end', async () => {
    await withTestDb(async (db) => {
      const problem = await baseline(db, 'cp-owner');
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'virtualer');
        await seedContestWith(db, {
          key: 'future',
          problemId: problem.id,
          startsInMs: 60 * MINUTE,
          endsInMs: 120 * MINUTE,
        });
        const early = await agent.post('/contests/future/join');
        expect(early.status).toBe(409);
        expect(early.body.code).toBe('contest_not_started');

        await seedContestWith(db, {
          key: 'past',
          problemId: problem.id,
          startsInMs: -120 * MINUTE,
          endsInMs: -60 * MINUTE,
        });
        // Each virtual join is a fresh attempt — deliberately NOT idempotent,
        // because `virtual = n` is exactly "the n-th attempt".
        expect((await agent.post('/contests/past/join')).body.virtual).toBe(1);
        expect((await agent.post('/contests/past/join')).body.virtual).toBe(2);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('GET :key/me 404s before joining and returns the participation after', async () => {
    await withTestDb(async (db) => {
      const problem = await baseline(db, 'cp-owner');
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'me-reader');
        await seedContestWith(db, {
          key: 'me-c',
          problemId: problem.id,
          startsInMs: -MINUTE,
          endsInMs: 60 * MINUTE,
        });
        expect((await agent.get('/contests/me-c/me')).status).toBe(404);
        await agent.post('/contests/me-c/join');
        const mine = await agent.get('/contests/me-c/me');
        expect(mine.status).toBe(200);
        // `endTime` is derived, never stored — no time limit, so it is the
        // contest's own end.
        expect(typeof mine.body.endTime).toBe('string');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('routing a submission into a contest', () => {
  async function submit(
    agent: request.Agent,
    problemCode: string,
    contestKey?: string,
  ): Promise<request.Response> {
    return agent
      .post('/submissions')
      .send({ problemCode, languageKey: 'cpp17', source: 'int main(){}', ...(contestKey ? { contestKey } : {}) });
  }

  async function contestRowsFor(db: Db, submissionId: number) {
    return db
      .select({ id: contestSubmissions.id })
      .from(contestSubmissions)
      .where(eq(contestSubmissions.submissionId, submissionId));
  }

  it('writes a contest_submissions row with contestKey, and none without it', async () => {
    await withTestDb(async (db) => {
      const problem = await baseline(db, 'cp-owner');
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'router');
        await seedContestWith(db, {
          key: 'route-c',
          problemId: problem.id,
          startsInMs: -MINUTE,
          endsInMs: 60 * MINUTE,
        });
        await agent.post('/contests/route-c/join');

        const inContest = await submit(agent, 'cp-owner', 'route-c');
        expect(inContest.status).toBe(201);
        expect(await contestRowsFor(db, inContest.body.id)).toHaveLength(1);

        // §2's stated cost, asserted rather than assumed: a participant
        // submitting without the key is practising, not competing.
        const practice = await submit(agent, 'cp-owner');
        expect(practice.status).toBe(201);
        expect(await contestRowsFor(db, practice.body.id)).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses a non-participant, a closed window, and a problem outside the contest', async () => {
    await withTestDb(async (db) => {
      const problem = await baseline(db, 'cp-owner');
      const outsider = await seedProblemWithSourceAccess(db, { code: 'not-in-contest' });
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'refused');
        await seedContestWith(db, {
          key: 'open-c',
          problemId: problem.id,
          startsInMs: -MINUTE,
          endsInMs: 60 * MINUTE,
        });

        // Never joined.
        const unjoined = await submit(agent, 'cp-owner', 'open-c');
        expect(unjoined.status).toBe(403);
        expect(unjoined.body.code).toBe('contest_not_joined');

        await agent.post('/contests/open-c/join');
        // Joined, but this problem is not in that contest.
        const wrongProblem = await submit(agent, 'not-in-contest', 'open-c');
        expect(wrongProblem.status).toBe(400);
        expect(wrongProblem.body.code).toBe('problem_not_in_contest');
        expect(outsider.id).toBeGreaterThan(0);

        // A contest that has already ended, joined virtually and then wound
        // past its window: `startTime` is set to the far past directly, since
        // a virtual window is measured from the participation's own start.
        await seedContestWith(db, {
          key: 'shut-c',
          problemId: problem.id,
          startsInMs: -300 * MINUTE,
          endsInMs: -240 * MINUTE,
        });
        const joined = await agent.post('/contests/shut-c/join');
        expect(joined.status).toBe(201);
        await db.execute(
          // Backdate the participation so its virtual window (the contest's
          // own 60-minute duration, from its start) has already elapsed.
          `UPDATE contest_participations SET start_time = now() - interval '120 minutes' WHERE id = ${joined.body.id as number}`,
        );
        const closed = await submit(agent, 'cp-owner', 'shut-c');
        expect(closed.status).toBe(403);
        expect(closed.body.code).toBe('contest_window_closed');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('accepts a submission at exactly the deadline and refuses one a millisecond later', async () => {
    await withTestDb(async (db) => {
      const problem = await baseline(db, 'cp-owner');
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'deadliner');
        const { contestId } = await seedContestWith(db, {
          key: 'edge-c',
          problemId: problem.id,
          startsInMs: -MINUTE,
          endsInMs: 60 * MINUTE,
        });
        await agent.post('/contests/edge-c/join');

        // Driven through `resolveContestTarget` with an explicit instant
        // rather than over HTTP: the boundary is one millisecond wide, and a
        // request that merely happens to arrive "before the end" does not
        // test it. An earlier version of this test used a two-second window
        // and passed against an exclusive comparison.
        const [contest] = await db
          .select({
            id: contests.id,
            key: contests.key,
            startTime: contests.startTime,
            endTime: contests.endTime,
            timeLimitSeconds: contests.timeLimitSeconds,
          })
          .from(contests)
          .where(eq(contests.id, contestId));
        const userId = await userIdOf(db, 'deadliner');
        const [participation] = await listParticipations(db, contestId, userId);
        const { endMs } = participationWindow(contest!, participation!);

        // Inclusive: `Contest.ended` is `end_time < now`, strictly after.
        await expect(
          resolveContestTarget(db, contest!, userId, problem.id, new Date(endMs)),
        ).resolves.toBeTruthy();
        await expect(
          resolveContestTarget(db, contest!, userId, problem.id, new Date(endMs + 1)),
        ).rejects.toMatchObject({ code: 'contest_window_closed' });
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('a contest grants access to its own problems', () => {
  it('hides a private contest problem until the caller joins, in both the read and the list', async () => {
    await withTestDb(async (db) => {
      // The problem is `private` and the caller holds no role on it: without
      // the contest clause it is invisible, which is the point — a contest
      // whose problems are already public leaked them before it started.
      const problem = await baseline(db, 'cp-owner', 'private');
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'contestant');
        await seedContestWith(db, {
          key: 'grant-c',
          problemId: problem.id,
          startsInMs: -MINUTE,
          endsInMs: 60 * MINUTE,
        });

        expect((await agent.get('/problems/cp-owner')).status).toBe(404);
        const before = await agent.get('/problems');
        expect((before.body.items as { code: string }[]).map((p) => p.code)).not.toContain('cp-owner');

        expect((await agent.post('/contests/grant-c/join')).status).toBe(201);

        // Both forms, because either alone passes against a predicate that
        // widened only one of them — the divergence this codebase keeps
        // finding once a phase.
        expect((await agent.get('/problems/cp-owner')).status).toBe(200);
        const after = await agent.get('/problems');
        expect((after.body.items as { code: string }[]).map((p) => p.code)).toContain('cp-owner');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('grants nothing to someone who joined a different contest', async () => {
    await withTestDb(async (db) => {
      const problem = await baseline(db, 'cp-owner', 'private');
      const other = await seedProblemWithSourceAccess(db, { code: 'other-p', visibility: 'private' });
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'wrong-contest');
        await seedContestWith(db, {
          key: 'mine-c',
          problemId: other.id,
          startsInMs: -MINUTE,
          endsInMs: 60 * MINUTE,
        });
        await seedContestWith(db, {
          key: 'theirs-c',
          problemId: problem.id,
          startsInMs: -MINUTE,
          endsInMs: 60 * MINUTE,
        });
        await agent.post('/contests/mine-c/join');

        // Joining one contest must not open every contest's problems — the
        // subquery has to match on the contest, not merely on holding some
        // participation somewhere.
        expect((await agent.get('/problems/other-p')).status).toBe(200);
        expect((await agent.get('/problems/cp-owner')).status).toBe(404);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('keeps access after the contest has ended', async () => {
    await withTestDb(async (db) => {
      const problem = await baseline(db, 'cp-owner', 'private');
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'post-contest');
        await seedContestWith(db, {
          key: 'ended-c',
          problemId: problem.id,
          startsInMs: -120 * MINUTE,
          endsInMs: -60 * MINUTE,
        });
        // Joined virtually, after the end. Access is deliberately not gated
        // on the window: you may re-read what you competed on, and anyone may
        // join virtually anyway.
        await agent.post('/contests/ended-c/join');
        expect((await agent.get('/problems/cp-owner')).status).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('the contest problem is scored on the scoreboard', () => {
  it('a routed submission reaches the scoreboard once graded', async () => {
    await withTestDb(async (db) => {
      const problem = await baseline(db, 'cp-owner');
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'scorer');
        const { contestId } = await seedContestWith(db, {
          key: 'score-c',
          problemId: problem.id,
          startsInMs: -MINUTE,
          endsInMs: 60 * MINUTE,
        });
        await agent.post('/contests/score-c/join');
        const created = await submit(agent, 'cp-owner', 'score-c');
        expect(created.status).toBe(201);

        // Grading is asynchronous and no judge runs here, so the verdict is
        // written directly — the point under test is that the row the API
        // created is the one the scoreboard reads, not the judge pipeline.
        const submissionId = created.body.id as number;
        await db
          .update(submissions)
          .set({
            state: 'done',
            verdict: 'AC',
            points: 100,
            maxPoints: 100,
            judgedAt: new Date(),
          })
          .where(eq(submissions.id, submissionId));
        await db.insert(submissionCases).values({
          submissionId,
          attempt: 1,
          groupIndex: 0,
          caseIndex: 1,
          verdict: 'AC',
          skipped: false,
          flags: [],
          timeMs: 1,
          memoryKb: 1,
          points: 100,
          maxPoints: 100,
        });

        const board = await agent.get('/contests/score-c/scoreboard');
        expect(board.status).toBe(200);
        const row = (board.body.ranking as { participant: string; score: number }[]).find(
          (entry) => entry.participant === 'scorer',
        );
        expect(row?.score).toBe(100);
        expect(contestId).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  async function submit(
    agent: request.Agent,
    problemCode: string,
    contestKey?: string,
  ): Promise<request.Response> {
    return agent
      .post('/submissions')
      .send({ problemCode, languageKey: 'cpp17', source: 'int main(){}', ...(contestKey ? { contestKey } : {}) });
  }
});
