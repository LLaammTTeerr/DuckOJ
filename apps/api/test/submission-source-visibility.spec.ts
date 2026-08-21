import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { problems } from '@duckoj/db/guarded';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import {
  grantProblemRole,
  insertGradedSubmission,
  publishNextRevision,
  registerAndLogin,
  seedProblemAndLanguage,
  seedProblemWithSourceAccess,
  userIdOf,
} from './submissions.fixtures.js';

/**
 * The named rules of `docs/superpowers/specs/2026-08-21-submission-source-visibility-design.md`
 * §2, each as its own test.
 *
 * `submissions-list.spec.ts` already pins these as *one* property — that the
 * list and the single read agree over a corpus covering every viewer kind.
 * That test is the one that catches a leak. These are the ones that say what
 * the rule IS: a property test that agreed on the wrong set would still pass,
 * and these name the set.
 */
describe('submission source visibility (design §2)', () => {
  it('shows a submitter their own source, and a stranger nothing at all', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const mine = request.agent(app.getHttpServer());
        await registerAndLogin(mine, 'src-owner');
        const stranger = request.agent(app.getHttpServer());
        await registerAndLogin(stranger, 'src-stranger');

        const created = await mine
          .post('/submissions')
          .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'int main(){}' });
        expect(created.status).toBe(201);
        const id = (created.body as { id: number }).id;

        const own = await mine.get(`/submissions/${id}`);
        expect(own.status).toBe(200);
        // The whole point of the change: before it, this field did not exist
        // on the wire and nobody could ever read back what they submitted.
        expect(own.body.source).toBe('int main(){}');

        // 404, not a 200 with the source elided — the submission itself is
        // what is invisible (§2.1), not one field of it.
        expect((await stranger.get(`/submissions/${id}`)).status).toBe(404);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses an AC-holder on a problem that never set source_access — the migration default is closed (§4.3)', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      // No `sourceAccess` passed: the column takes migration 0007's DEFAULT.
      const problem = await seedProblemWithSourceAccess(db, { code: 'default-closed' });
      const app = await buildApp(db);
      try {
        const solver = request.agent(app.getHttpServer());
        await registerAndLogin(solver, 'closed-solver');
        const solverId = await userIdOf(db, 'closed-solver');
        const otherId = (await userIdOf(db, 'default-closed-owner'));

        // Guard: the corpus only proves anything if the flag really is
        // `private` because nothing set it, not because this test set it.
        const [row] = await db
          .select({ sourceAccess: problems.sourceAccess })
          .from(problems)
          .where(eq(problems.id, problem.id));
        expect(row!.sourceAccess).toBe('private');

        await insertGradedSubmission(db, { userId: solverId, problemId: problem.id, verdict: 'AC' });
        const theirs = await insertGradedSubmission(db, { userId: otherId, problemId: problem.id });

        expect((await solver.get(`/submissions/${theirs}`)).status).toBe(404);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('grants the same AC-holder access once the problem opts into source_access = solved', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const problem = await seedProblemWithSourceAccess(db, { code: 'opt-in' });
      const app = await buildApp(db);
      try {
        const solver = request.agent(app.getHttpServer());
        await registerAndLogin(solver, 'optin-solver');
        const solverId = await userIdOf(db, 'optin-solver');
        const otherId = await userIdOf(db, 'opt-in-owner');

        await insertGradedSubmission(db, { userId: solverId, problemId: problem.id, verdict: 'AC' });
        const theirs = await insertGradedSubmission(db, { userId: otherId, problemId: problem.id });

        // Closed…
        expect((await solver.get(`/submissions/${theirs}`)).status).toBe(404);
        await db.update(problems).set({ sourceAccess: 'solved' }).where(eq(problems.id, problem.id));
        // …and open, with nothing else about the corpus changed. That
        // before/after pair is what rules out the 200 below coming from some
        // other grant the fixture happened to give this user.
        const after = await solver.get(`/submissions/${theirs}`);
        expect(after.status).toBe(200);
        expect(typeof after.body.source).toBe('string');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses a WA-only submitter on a solved-access problem (§4.5)', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const problem = await seedProblemWithSourceAccess(db, { code: 'wa-only', sourceAccess: 'solved' });
      const app = await buildApp(db);
      try {
        const attempter = request.agent(app.getHttpServer());
        await registerAndLogin(attempter, 'wa-attempter');
        const attempterId = await userIdOf(db, 'wa-attempter');
        const otherId = await userIdOf(db, 'wa-only-owner');

        await insertGradedSubmission(db, { userId: attempterId, problemId: problem.id, verdict: 'WA' });
        const theirs = await insertGradedSubmission(db, { userId: otherId, problemId: problem.id });

        // Having submitted is not having solved: `solved` means an AC.
        expect((await attempter.get(`/submissions/${theirs}`)).status).toBe(404);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('keeps access for an AC on a now-archived revision — "has an AC" is not revision-scoped (§2.4)', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const problem = await seedProblemWithSourceAccess(db, { code: 'republished', sourceAccess: 'solved' });
      const app = await buildApp(db);
      try {
        const solver = request.agent(app.getHttpServer());
        await registerAndLogin(solver, 'republish-solver');
        const solverId = await userIdOf(db, 'republish-solver');
        const otherId = await userIdOf(db, 'republished-owner');

        // AC against version 1…
        await insertGradedSubmission(db, {
          userId: solverId,
          problemId: problem.id,
          revisionId: problem.revisionId,
          verdict: 'AC',
        });
        // …then version 2 publishes and version 1 is archived. Tying access
        // to the *current* revision would silently revoke it here, on every
        // republish, for everyone who had solved the problem — which is why
        // §2.4 fixes the rule as "at least one AC on this problem, ever".
        const v2 = await publishNextRevision(db, problem.id, 'republished');
        const theirs = await insertGradedSubmission(db, {
          userId: otherId,
          problemId: problem.id,
          revisionId: v2,
        });

        const res = await solver.get(`/submissions/${theirs}`);
        expect(res.status).toBe(200);
        expect(typeof res.body.source).toBe('string');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('admits an author and a curator, and refuses a tester on the same problem (§2.2)', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      // `private` source access on purpose: a member's grant comes from the
      // membership, never from the flag, so the flag must be irrelevant here.
      const problem = await seedProblemWithSourceAccess(db, { code: 'membered' });
      const app = await buildApp(db);
      try {
        const roles = ['author', 'curator', 'tester'] as const;
        const agents = {} as Record<(typeof roles)[number], ReturnType<typeof request.agent>>;
        for (const role of roles) {
          const agent = request.agent(app.getHttpServer());
          await registerAndLogin(agent, `mem-${role}`);
          agents[role] = agent;
          await grantProblemRole(db, problem.id, await userIdOf(db, `mem-${role}`), role);
        }
        const otherId = await userIdOf(db, 'membered-owner');
        const theirs = await insertGradedSubmission(db, { userId: otherId, problemId: problem.id });

        for (const role of ['author', 'curator'] as const) {
          const res = await agents[role].get(`/submissions/${theirs}`);
          expect(res.status, `a ${role} must see submissions to their problem`).toBe(200);
          expect(typeof res.body.source).toBe('string');
        }
        // A tester exists to proofread the *problem* before it is public.
        // That is not a reason to read other people's *solutions* to it —
        // and widening to testers later is one line, while un-widening after
        // testers have read submissions is not.
        expect((await agents.tester.get(`/submissions/${theirs}`)).status).toBe(404);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('carries source_access on PATCH /problems/:code and back out on the detail (§5)', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const problem = await seedProblemWithSourceAccess(db, { code: 'patchable' });
      const app = await buildApp(db);
      try {
        const author = request.agent(app.getHttpServer());
        await registerAndLogin(author, 'patch-author');
        await grantProblemRole(db, problem.id, await userIdOf(db, 'patch-author'), 'author');

        const before = await author.get('/problems/patchable');
        expect(before.status).toBe(200);
        expect(before.body.sourceAccess).toBe('private');

        const patched = await author.patch('/problems/patchable').send({ sourceAccess: 'solved' });
        expect(patched.status).toBe(200);
        expect(patched.body.sourceAccess).toBe('solved');
        // The write must have landed, not merely echoed back.
        expect((await author.get('/problems/patchable')).body.sourceAccess).toBe('solved');

        const [row] = await db
          .select({ sourceAccess: problems.sourceAccess })
          .from(problems)
          .where(eq(problems.id, problem.id));
        expect(row!.sourceAccess).toBe('solved');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses a non-member trying to open source_access, under the existing 404-then-403 ordering', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      await seedProblemWithSourceAccess(db, { code: 'not-yours' });
      await seedProblemWithSourceAccess(db, { code: 'not-even-visible', visibility: 'private' });
      const app = await buildApp(db);
      try {
        const outsider = request.agent(app.getHttpServer());
        await registerAndLogin(outsider, 'patch-outsider');

        // `sourceAccess` must not become the one PATCH field with its own
        // authorization: it rides the same 404-then-403 ordering every other
        // problem write does. A problem the caller cannot SEE answers 404
        // (a 403 would confirm it exists); a visible one she merely may not
        // EDIT answers 403.
        expect((await outsider.patch('/problems/not-even-visible').send({ sourceAccess: 'solved' })).status).toBe(404);
        expect((await outsider.patch('/problems/not-yours').send({ sourceAccess: 'solved' })).status).toBe(403);

        // Neither refusal may have written anything.
        const rows = await db
          .select({ code: problems.code, sourceAccess: problems.sourceAccess })
          .from(problems)
          .where(inArray(problems.code, ['not-yours', 'not-even-visible']));
        expect(rows.map((r) => r.sourceAccess)).toEqual(['private', 'private']);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
