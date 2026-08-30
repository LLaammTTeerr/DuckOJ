import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import {
  organizations,
  orgMembers,
  problemMembers,
  problemOrgs,
  problemRevisions,
  problems,
} from '@duckoj/db/guarded';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { insertUser, registerAndLogin, seedProblemAndLanguage, seedPrivateProblem } from './submissions.fixtures.js';

async function userIdOf(db: Db, username: string): Promise<number> {
  const [user] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, username));
  if (!user) throw new Error(`no such user: ${username}`);
  return user.id;
}

/**
 * A problem with `visibility: 'org'`, shared with a fresh private org, plus a
 * published revision — the minimum this suite needs to submit against it.
 * Mirrors `seedProblem` in `problem-reads.spec.ts`, kept local because that
 * helper isn't exported.
 */
async function seedOrgProblem(db: Db, code: string, ownerId: number): Promise<{ orgId: number }> {
  const [org] = await db
    .insert(organizations)
    .values({ slug: `${code}-org`, name: `${code} org`, visibility: 'private' })
    .returning();
  const [problem] = await db
    .insert(problems)
    .values({ code, name: code, statement: 'statement', visibility: 'org', createdBy: ownerId })
    .returning();
  await db.insert(problemOrgs).values({ problemId: problem!.id, orgId: org!.id });
  const hash = `hash-${code}`;
  await db.insert(schema.packages).values({ hash, sizeBytes: 1, fileCount: 1 });
  const [revision] = await db
    .insert(problemRevisions)
    .values({
      problemId: problem!.id,
      version: 1,
      packageHash: hash,
      state: 'published',
      createdBy: ownerId,
      timeMs: 1000,
      memoryKb: 256_000,
      testCount: 5,
      totalPoints: 100,
      checkerKind: 'wcmp',
    })
    .returning();
  await db.update(problems).set({ currentRevisionId: revision!.id }).where(eq(problems.id, problem!.id));
  return { orgId: org!.id };
}

// This suite exists to fail if anyone reintroduces a second visibility
// implementation in the submission path. It is not about submissions.
describe('submission create honours problem visibility', () => {
  // AC4, and the reason this whole phase has a Global Constraint about one
  // shared visibility predicate. The two paths are deliberately exercised by
  // ONE actor against ONE problem in ONE test: two separate tests, with two
  // fixtures, can both pass while the paths disagree — which is exactly the
  // bug this phase found, where an org member saw a problem in the list and
  // got a 404 submitting to it. Splitting this test reintroduces the blind
  // spot it exists to cover.
  it('lets the SAME org member both see the problem and submit to it', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const owner = await insertUser(db, 'ac4-owner');
      const { orgId } = await seedOrgProblem(db, 'ac4org', owner.id);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'ac4-member');
        const memberId = await userIdOf(db, 'ac4-member');
        await db.insert(orgMembers).values({ orgId, userId: memberId, role: 'member' });

        // Path 1: the read side sees it.
        const detail = await agent.get('/api/v1/problems/ac4org');
        expect(detail.status).toBe(200);
        expect(detail.body.code).toBe('ac4org');

        // Path 2: the same session submits to it.
        const created = await agent
          .post('/api/v1/submissions')
          .send({ problemCode: 'ac4org', languageKey: 'cpp17', source: 'int main(){}' });
        expect(created.status).toBe(201);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('accepts a submission from a member of an org the problem is shared with', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const owner = await insertUser(db, 'org-vis-owner');
      const { orgId } = await seedOrgProblem(db, 'orgvis1', owner.id);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'org-vis-member');
        const memberId = await userIdOf(db, 'org-vis-member');
        await db.insert(orgMembers).values({ orgId, userId: memberId, role: 'member' });

        const res = await agent
          .post('/api/v1/submissions')
          .send({ problemCode: 'orgvis1', languageKey: 'cpp17', source: 'int main(){}' });

        expect(res.status).toBe(201);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('rejects a submission to an org problem from a non-member', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const owner = await insertUser(db, 'org-vis-owner2');
      await seedOrgProblem(db, 'orgvis2', owner.id);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'org-vis-stranger');

        const res = await agent
          .post('/api/v1/submissions')
          .send({ problemCode: 'orgvis2', languageKey: 'cpp17', source: 'int main(){}' });

        expect(res.status).toBe(404);
        expect(res.body.code).toBe('problem_not_found');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('accepts a submission from a tester of a private problem', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      await seedPrivateProblem(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'private-vis-tester');
        const testerId = await userIdOf(db, 'private-vis-tester');
        const [problem] = await db.select({ id: problems.id }).from(problems).where(eq(problems.code, 'hidden'));
        await db.insert(problemMembers).values({ problemId: problem!.id, userId: testerId, role: 'tester' });

        const res = await agent
          .post('/api/v1/submissions')
          .send({ problemCode: 'hidden', languageKey: 'cpp17', source: 'int main(){}' });

        expect(res.status).toBe(201);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('rejects a submission to a private problem from a stranger', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      await seedPrivateProblem(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'private-vis-stranger');

        const res = await agent
          .post('/api/v1/submissions')
          .send({ problemCode: 'hidden', languageKey: 'cpp17', source: 'int main(){}' });

        expect(res.status).toBe(404);
        expect(res.body.code).toBe('problem_not_found');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
