import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import { problemMembers, problems } from '@duckoj/db/guarded';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import {
  registerAndLogin,
  seedPrivateProblem,
  seedProblemAndLanguage,
} from './submissions.fixtures.js';

/**
 * D159 — the authoring surface for `problem_language_limits`.
 *
 * F-39 shipped the column, its enforcement and its appearance on
 * `ProblemDetail`, and B-30 recorded what was left: "the only way to SET an
 * override today is SQL". This is that route, and the two properties it
 * exists to keep are the two a form is likeliest to break.
 *
 *  - **NULL is not zero.** Both numeric columns inherit COLUMN BY COLUMN, so
 *    an override that pins the time and says nothing about memory must keep
 *    the interpreter's floor. A form that sent `0` for an empty box would MRE
 *    every Python submission on a problem that still accepts them.
 *  - **A refusal is not a limit of zero.** `allowed: false` is a 404 at
 *    submit time (D154); the bounds make "0 ms" unsayable so it cannot be
 *    reached by typo either.
 */
async function problemIdOf(db: Db, code: string): Promise<number> {
  const [row] = await db.select({ id: problems.id }).from(problems).where(eq(problems.code, code));
  return row!.id;
}

async function makeEditor(db: Db, code: string, username: string): Promise<void> {
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username));
  await db
    .insert(problemMembers)
    .values({ problemId: await problemIdOf(db, code), userId: user!.id, role: 'author' });
}

describe('GET /problems/:code/language-limits (D159)', () => {
  it('hands back the INPUTS — inherit as null, beside the default it inherits', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'd159-editor');
        await makeEditor(db, 'aplusb', 'd159-editor');

        const res = await agent.get('/api/v1/problems/aplusb/language-limits');
        expect(res.status).toBe(200);
        // The authored limits the multipliers multiply — what the form
        // previews against.
        expect(res.body.base).toEqual({ timeMs: 1000, memoryKb: 256_000 });
        // Same order as the pupil's picker (D158), so a setter comparing the
        // two screens compares the same list.
        expect(res.body.languages.map((l: { languageKey: string }) => l.languageKey)).toEqual([
          'cpp17',
          'cpp20',
          'cpp14',
          'c11',
          'python3',
          'pascal',
          'java',
        ]);
        // The row nobody has overridden: `null`, NOT the resolved 300. This
        // is the whole difference between this route and
        // `GET /problems/:code` — resolving here would leave the form unable
        // to put a field back to "inherit", because it would never again know
        // which numbers were typed and which were inherited.
        expect(
          res.body.languages.find((l: { languageKey: string }) => l.languageKey === 'python3'),
        ).toEqual({
          languageKey: 'python3',
          languageName: 'Python 3',
          defaultTimeMultiplierPct: 300,
          defaultMemoryExtraKb: 32_768,
          timeMultiplierPct: null,
          memoryExtraKb: null,
          allowed: true,
        });
        // F-46's rows reach this form for free, which is the point: the
        // defaults it renders are read from `languages`, so D169's numbers
        // appear as the placeholder a setter overrides, with no code here
        // knowing what they are.
        expect(
          res.body.languages.find((l: { languageKey: string }) => l.languageKey === 'java'),
        ).toEqual({
          languageKey: 'java',
          languageName: 'Java 17',
          defaultTimeMultiplierPct: 300,
          defaultMemoryExtraKb: 65_536,
          timeMultiplierPct: null,
          memoryExtraKb: null,
          allowed: true,
        });
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('404s a problem the caller cannot SEE and 403s one they merely cannot edit', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      await seedPrivateProblem(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'd159-stranger');

        // Invisible: 404, never a distinct error saying "exists but not
        // yours" — the same ordering `PATCH /problems/:code` applies, because
        // this IS editing the problem.
        const invisible = await agent.get('/api/v1/problems/hidden/language-limits');
        expect(invisible.status).toBe(404);
        expect(invisible.body.code).toBe('problem_not_found');

        // Visible and public, but this person is not an author: 403.
        const visible = await agent.get('/api/v1/problems/aplusb/language-limits');
        expect(visible.status).toBe(403);
        expect(visible.body.code).toBe('problem_forbidden');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('PUT /problems/:code/language-limits (D159)', () => {
  it('pins the time and keeps the memory floor — null is inherit, not zero', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'd159-pinner');
        await makeEditor(db, 'aplusb', 'd159-pinner');

        const put = await agent.put('/api/v1/problems/aplusb/language-limits').send({
          limits: [
            {
              languageKey: 'python3',
              timeMultiplierPct: 150,
              memoryExtraKb: null,
              allowed: true,
            },
          ],
        });
        expect(put.status).toBe(200);
        expect(
          put.body.languages.find((l: { languageKey: string }) => l.languageKey === 'python3'),
        ).toMatchObject({ timeMultiplierPct: 150, memoryExtraKb: null });

        // And the pupil's view, which is the number that decides a verdict:
        // 150 % of 1000 ms, and the interpreter's floor STILL added. A form
        // that had sent `0` for the empty memory box would show 256000 KB
        // here and MRE every Python submission on this problem.
        const detail = await agent.get('/api/v1/problems/aplusb');
        expect(
          detail.body.languageLimits.find(
            (l: { languageKey: string }) => l.languageKey === 'python3',
          ),
        ).toMatchObject({ timeMs: 1500, memoryKb: 288_768 });
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('replaces the whole set, and stores a row that says nothing as no row', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'd159-clearer');
        await makeEditor(db, 'aplusb', 'd159-clearer');

        await agent
          .put('/api/v1/problems/aplusb/language-limits')
          .send({
            limits: [
              {
                languageKey: 'python3',
                timeMultiplierPct: 200,
                memoryExtraKb: null,
                allowed: true,
              },
              { languageKey: 'c11', timeMultiplierPct: null, memoryExtraKb: null, allowed: false },
            ],
          })
          .expect(200);
        expect(
          await db
            .select()
            .from(schema.problemLanguageLimits)
            .where(eq(schema.problemLanguageLimits.problemId, await problemIdOf(db, 'aplusb'))),
        ).toHaveLength(2);

        // Everything inherited and allowed: byte-identical to no row in every
        // reader, so no row is what is stored. Otherwise this table would
        // grow one row per (problem, language) for every problem anyone ever
        // opened the form on.
        const cleared = await agent.put('/api/v1/problems/aplusb/language-limits').send({
          limits: [
            { languageKey: 'python3', timeMultiplierPct: null, memoryExtraKb: null, allowed: true },
            { languageKey: 'c11', timeMultiplierPct: null, memoryExtraKb: null, allowed: true },
          ],
        });
        expect(cleared.status).toBe(200);
        expect(
          await db
            .select()
            .from(schema.problemLanguageLimits)
            .where(eq(schema.problemLanguageLimits.problemId, await problemIdOf(db, 'aplusb'))),
        ).toHaveLength(0);
        // Re-read, not echoed: a response built from the request body would
        // report the two rows that were just dropped.
        expect(
          cleared.body.languages.find((l: { languageKey: string }) => l.languageKey === 'python3'),
        ).toMatchObject({ timeMultiplierPct: null, allowed: true });
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses the bounds independently of any form (D159)', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'd159-typo');
        await makeEditor(db, 'aplusb', 'd159-typo');

        const send = (limit: unknown) =>
          agent.put('/api/v1/problems/aplusb/language-limits').send({ limits: [limit] });

        // `0` is the typo B-30 found: every submission in this language TLEs
        // instantly, which is a refusal presented as a wrong verdict.
        const zero = await send({
          languageKey: 'python3',
          timeMultiplierPct: 0,
          memoryExtraKb: null,
          allowed: true,
        });
        expect(zero.status).toBe(422);
        // D146 — the objection reaches the FIELD, not just the banner.
        expect(Object.keys(zero.body.fields ?? {})).toContain('limits.0.timeMultiplierPct');

        expect(
          (
            await send({
              languageKey: 'python3',
              timeMultiplierPct: 100_000,
              memoryExtraKb: null,
              allowed: true,
            })
          ).status,
        ).toBe(422);
        expect(
          (
            await send({
              languageKey: 'python3',
              timeMultiplierPct: null,
              memoryExtraKb: -1,
              allowed: true,
            })
          ).status,
        ).toBe(422);

        // A key nobody can submit in is refused rather than ignored: silently
        // dropping it would tell a setter their refusal was saved when
        // nothing was written.
        expect(
          (
            await send({
              languageKey: 'brainfuck',
              timeMultiplierPct: null,
              memoryExtraKb: null,
              allowed: false,
            })
          ).status,
        ).toBe(422);

        // Nothing landed.
        expect(
          await db
            .select()
            .from(schema.problemLanguageLimits)
            .where(eq(schema.problemLanguageLimits.problemId, await problemIdOf(db, 'aplusb'))),
        ).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('403s a signed-in stranger, so the write is gated exactly as the edit is', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'd159-outsider');
        const res = await agent.put('/api/v1/problems/aplusb/language-limits').send({
          limits: [
            {
              languageKey: 'python3',
              timeMultiplierPct: null,
              memoryExtraKb: null,
              allowed: false,
            },
          ],
        });
        expect(res.status).toBe(403);
        expect(await db.select().from(schema.problemLanguageLimits)).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
