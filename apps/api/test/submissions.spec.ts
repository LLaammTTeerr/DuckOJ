import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { schema } from '@qhhoj/db';
import { submissions } from '@qhhoj/db/guarded';
import { SubmissionAccessService } from '../src/authz/submission.access.js';
import type { Actor } from '../src/authz/actor.js';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { seedProblemAndLanguage, registerAndLogin } from './submissions.fixtures.js';

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
});

describe('SubmissionAccessService.create transactional guarantee', () => {
  it('leaves no orphan submission when the grading-job insert fails', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const [user] = await db
        .insert(schema.users)
        .values({ username: 'erin', email: 'erin@e.com', passwordHash: 'x', displayName: 'Erin' })
        .returning();
      const actor: Actor = { userId: user!.id, globalRole: 'user', via: 'session', scopes: [] };

      // Forces the second insert of the transaction (into `grading_jobs`) to
      // fail with a genuine constraint violation, independently of the first
      // insert (into `submissions`), which would otherwise succeed on its own.
      await db.execute(
        sql`ALTER TABLE grading_jobs ADD CONSTRAINT force_job_insert_to_fail CHECK (false) NOT VALID`,
      );

      const service = new SubmissionAccessService(db);
      await expect(
        service.create(actor, { problemCode: 'aplusb', languageKey: 'cpp17', source: 'int main(){}' }),
      ).rejects.toThrow();

      const rows = await db.select().from(submissions).where(sql`${submissions.userId} = ${user!.id}`);
      expect(rows).toHaveLength(0);
    });
  }, 120_000);
});
