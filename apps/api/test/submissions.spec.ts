import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@duckoj/db';
import { problemRevisions, submissionCases, submissions } from '@duckoj/db/guarded';
import { SubmissionAccessService } from '../src/authz/submission.access.js';
import type { Actor } from '../src/authz/actor.js';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import {
  seedProblemAndLanguage,
  seedPrivateProblem,
  registerAndLogin,
  insertUser,
} from './submissions.fixtures.js';

function actorFor(userId: number, globalRole: 'user' | 'admin' = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

/**
 * Walks `.cause` the way `problem.filter.ts`'s `driverCodeOf` does, to reach
 * the underlying Postgres SQLSTATE through `DrizzleQueryError`. Duplicated
 * here (rather than exported from the filter) because it's test-only and
 * small; see that file for the fuller rationale.
 */
function driverCodeOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

describe('submissions', () => {
  it('creates a submission and enqueues a grading job', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'alice');

        const created = await agent
          .post('/submissions')
          .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'int main(){}' });

        expect(created.status).toBe(201);
        const detail = await agent.get(`/submissions/${created.body.id}`);
        expect(detail.status).toBe(200);
        expect(detail.body.state).toBe('queued');
        expect(detail.body.problemCode).toBe('aplusb');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('rejects an anonymous submission', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const res = await request(app.getHttpServer())
          .post('/submissions')
          .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'x' });
        expect(res.status).toBe(401);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses to read another user\'s submission, with 404 rather than 403', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const alice = request.agent(app.getHttpServer());
        await registerAndLogin(alice, 'alice');
        const created = await alice
          .post('/submissions')
          .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'int main(){}' });

        const bob = request.agent(app.getHttpServer());
        await registerAndLogin(bob, 'bob');
        const seen = await bob.get(`/submissions/${created.body.id}`);

        // 404, not 403: the existence of another user's submission is itself
        // information we do not disclose.
        expect(seen.status).toBe(404);
        expect(seen.body.code).toBe('submission_not_found');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('rejects an unknown problem code with 404', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'carol');
        const res = await agent
          .post('/submissions')
          .send({ problemCode: 'nope', languageKey: 'cpp17', source: 'x' });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('problem_not_found');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('rejects an oversized source with 422 rather than truncating it', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'dave');
        const res = await agent
          .post('/submissions')
          .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'x'.repeat(64 * 1024 + 1) });
        expect(res.status).toBe(422);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('rejects an id path parameter beyond the safe-integer range with 422, not 500', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'kelly');

        // Bigger than any bigint id this schema can hold, and bigger than
        // Number.MAX_SAFE_INTEGER: `ParseIntPipe` used to accept this, parse
        // it to an imprecise float, and let it reach the driver as a 500.
        const tooBig = await agent.get('/submissions/99999999999999999999');
        expect(tooBig.status).toBe(422);
        expect(tooBig.body.code).toBe('validation_failed');

        const notANumber = await agent.get('/submissions/abc');
        expect(notANumber.status).toBe(422);
        expect(notANumber.body.code).toBe('validation_failed');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('SubmissionAccessService.create transactional guarantee', () => {
  it('leaves no orphan submission — and no grading job — when the job insert fails', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const user = await insertUser(db, 'erin');
      const actor = actorFor(user.id);

      // Forces the second insert of the transaction (into `grading_jobs`) to
      // fail with a genuine constraint violation, independently of the first
      // insert (into `submissions`), which would otherwise succeed on its own.
      //
      // Note: `ADD CONSTRAINT` takes an ACCESS EXCLUSIVE lock on `grading_jobs`
      // for the rest of this test's (outer, always-rolled-back) transaction.
      // Harmless today — nothing else in `apps/api` touches `grading_jobs` —
      // but it would block any concurrent transaction that does, so this
      // pattern doesn't belong in a test that runs alongside others touching
      // the same table.
      await db.execute(
        sql`ALTER TABLE grading_jobs ADD CONSTRAINT force_job_insert_to_fail CHECK (false) NOT VALID`,
      );

      const service = new SubmissionAccessService(db);
      let thrown: unknown;
      try {
        await service.create(actor, { problemCode: 'aplusb', languageKey: 'cpp17', source: 'int main(){}' });
      } catch (error) {
        thrown = error;
      }

      // A specific check, not "it threw something": 23514 is Postgres's
      // check_violation SQLSTATE, reached through `DrizzleQueryError.cause`.
      // Matching only "it rejected" would also pass if the seed ever drifted
      // and `create()` threw its own `problem_not_found` before the
      // transaction body ran at all — which would prove nothing about the
      // transaction.
      expect(driverCodeOf(thrown)).toBe('23514');

      const orphanSubmissions = await db
        .select()
        .from(submissions)
        .where(sql`${submissions.userId} = ${user.id}`);
      expect(orphanSubmissions).toHaveLength(0);

      const jobs = await db.select().from(schema.gradingJobs);
      expect(jobs).toHaveLength(0);
    });
  }, 120_000);
});

describe('getVisible: case rows are scoped to the latest grading attempt', () => {
  it('returns only the current attempt\'s case, not a stale attempt\'s', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const user = await insertUser(db, 'frank');
      const actor = actorFor(user.id);
      const service = new SubmissionAccessService(db);

      const { id: submissionId } = await service.create(actor, {
        problemCode: 'aplusb',
        languageKey: 'cpp17',
        source: 'int main(){}',
      });

      // Simulates a lease that lapsed mid-grade and was re-claimed:
      // `JobStore.claim` bumps `attempt` on every claim, so attempt 1's stale
      // WA on case (0,0) and attempt 2's clean regrade to AC are both real
      // rows in the table, inserted in that order — exactly what
      // `JobStore` + `EventWriter` produce in production.
      await db.insert(submissionCases).values([
        {
          submissionId,
          attempt: 1,
          groupIndex: 0,
          caseIndex: 0,
          verdict: 'WA',
          skipped: false,
          timeMs: 10,
          memoryKb: 1000,
          points: 0,
          maxPoints: 1,
          feedback: 'stale attempt',
        },
        {
          submissionId,
          attempt: 2,
          groupIndex: 0,
          caseIndex: 0,
          verdict: 'AC',
          skipped: false,
          timeMs: 12,
          memoryKb: 1000,
          points: 1,
          maxPoints: 1,
          feedback: null,
        },
      ]);

      const detail = await service.getVisible(actor, submissionId);
      expect(detail.cases).toHaveLength(1);
      expect(detail.cases[0]).toMatchObject({ verdict: 'AC', points: 1, feedback: null });
    });
  }, 120_000);

  it('returns an empty case list, not an error, before any case has graded', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const user = await insertUser(db, 'wendy');
      const actor = actorFor(user.id);
      const service = new SubmissionAccessService(db);

      const { id: submissionId } = await service.create(actor, {
        problemCode: 'aplusb',
        languageKey: 'cpp17',
        source: 'int main(){}',
      });

      const detail = await service.getVisible(actor, submissionId);
      expect(detail.cases).toEqual([]);
    });
  }, 120_000);
});

describe('create(): a private problem is not an existence oracle', () => {
  it('answers problem_not_found for a non-admin, but lets an admin submit', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      await seedPrivateProblem(db);
      const service = new SubmissionAccessService(db);

      const outsider = await insertUser(db, 'gina', 'user');
      await expect(
        service.create(actorFor(outsider.id), { problemCode: 'hidden', languageKey: 'cpp17', source: 'x' }),
      ).rejects.toMatchObject({ status: 404, code: 'problem_not_found' });

      const admin = await insertUser(db, 'henry', 'admin');
      const created = await service.create(actorFor(admin.id, 'admin'), {
        problemCode: 'hidden',
        languageKey: 'cpp17',
        source: 'x',
      });
      expect(created.id).toBeGreaterThan(0);
    });
  }, 120_000);
});

describe('create(): only a published revision and an active language are gradeable', () => {
  it('rejects a problem whose current revision is not published', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      await db
        .update(problemRevisions)
        .set({ state: 'draft' })
        .where(eq(problemRevisions.packageHash, 'phase1-aplusb'));
      const user = await insertUser(db, 'iris');
      const service = new SubmissionAccessService(db);

      await expect(
        service.create(actorFor(user.id), { problemCode: 'aplusb', languageKey: 'cpp17', source: 'x' }),
      ).rejects.toMatchObject({ status: 404, code: 'problem_not_found' });
    });
  }, 120_000);

  it('rejects a language that has been deactivated', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      await db.update(schema.languages).set({ isActive: false }).where(eq(schema.languages.key, 'cpp17'));
      const user = await insertUser(db, 'jack');
      const service = new SubmissionAccessService(db);

      await expect(
        service.create(actorFor(user.id), { problemCode: 'aplusb', languageKey: 'cpp17', source: 'x' }),
      ).rejects.toMatchObject({ status: 404, code: 'language_not_found' });
    });
  }, 120_000);
});
