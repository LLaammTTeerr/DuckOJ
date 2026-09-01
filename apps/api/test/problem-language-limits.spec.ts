import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@duckoj/db';
import { problems } from '@duckoj/db/guarded';
import { SubmissionAccessService } from '../src/authz/submission.access.js';
import type { Actor } from '../src/authz/actor.js';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { seedProblemAndLanguage, insertUser } from './submissions.fixtures.js';
import type { Db } from '@duckoj/db';

/**
 * D154's display half, and the refusal it makes possible.
 *
 * `seedProblemAndLanguage` publishes `aplusb` at 1000 ms / 256000 KB, and
 * migration 0042 seeds `python3` at 300 % / +32768 KB — so the numbers this
 * file asserts (3000 ms, 288768 KB) are the same two the judge is handed by
 * `JobStore.claim` in `apps/judged/test/job-language-routing.spec.ts`. That
 * they are asserted twice, from opposite ends, is the point: the whole
 * feature is the claim that what is shown and what is enforced are one
 * number.
 */
function actorFor(userId: number): Actor {
  return { userId, globalRole: 'user', via: 'session', scopes: [] };
}

async function languageId(db: Db, key: string): Promise<number> {
  const [row] = await db
    .select({ id: schema.languages.id })
    .from(schema.languages)
    .where(eq(schema.languages.key, key));
  return row!.id;
}

async function problemId(db: Db, code: string): Promise<number> {
  const [row] = await db.select({ id: problems.id }).from(problems).where(eq(problems.code, code));
  return row!.id;
}

describe('GET /problems/:code — the limits each language really gets', () => {
  it('shows C++ the authored limits and Python the adjusted ones', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const res = await request(app.getHttpServer()).get('/api/v1/problems/aplusb');
        expect(res.status).toBe(200);
        const limits = res.body.languageLimits as {
          languageKey: string;
          languageName: string;
          timeMs: number;
          memoryKb: number;
          allowed: boolean;
        }[];

        // Every ACTIVE language, in the order they were ADDED — the picker's
        // whole menu, and its first entry is what the submit box preselects
        // (D158). Alphabetical put `c11` there, so every pupil who reached
        // the submit box from a statement page was offered C11 and a C
        // starter template for no reason but that `c` sorts before `cpp`.
        expect(limits.map((l) => l.languageKey)).toEqual([
          'cpp17',
          'cpp20',
          'cpp14',
          'c11',
          'python3',
          'pascal',
          'java',
        ]);
        expect(limits.find((l) => l.languageKey === 'cpp17')).toEqual({
          languageKey: 'cpp17',
          languageName: 'C++17',
          timeMs: 1000,
          memoryKb: 256_000,
          allowed: true,
        });
        // 300 % of 1000 ms; 256000 + 32768 KB. This is the number the pupil
        // is shown AND the number the judge enforces — a page that quoted
        // 1000 ms here while judged allowed 3000 would be the lie D154 exists
        // to prevent.
        expect(limits.find((l) => l.languageKey === 'python3')).toEqual({
          languageKey: 'python3',
          languageName: 'Python 3',
          timeMs: 3000,
          memoryKb: 288_768,
          allowed: true,
        });
        // D169, the same rule reaching two more languages. Pascal's 200 % of
        // 1000 ms with no addend at all — its floor is BELOW C++'s — and
        // Java's 300 % with the largest addend in the catalogue, which buys
        // heap rather than a floor because the judge passes the limit as
        // `-Xmx`.
        expect(limits.find((l) => l.languageKey === 'pascal')).toEqual({
          languageKey: 'pascal',
          languageName: 'Pascal',
          timeMs: 2000,
          memoryKb: 256_000,
          allowed: true,
        });
        expect(limits.find((l) => l.languageKey === 'java')).toEqual({
          languageKey: 'java',
          languageName: 'Java 17',
          timeMs: 3000,
          memoryKb: 321_536,
          allowed: true,
        });
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it("reports a problem's refusal, so the picker can omit the language", async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      await db.insert(schema.problemLanguageLimits).values({
        problemId: await problemId(db, 'aplusb'),
        languageId: await languageId(db, 'python3'),
        allowed: false,
      });
      const app = await buildApp(db);
      try {
        const res = await request(app.getHttpServer()).get('/api/v1/problems/aplusb');
        const limits = res.body.languageLimits as { languageKey: string; allowed: boolean }[];
        // Present and flagged, not omitted: the response is the picker's
        // source of truth about what exists, and a silently missing row would
        // read as "the catalogue shrank".
        expect(limits.find((l) => l.languageKey === 'python3')?.allowed).toBe(false);
        expect(limits.find((l) => l.languageKey === 'cpp17')?.allowed).toBe(true);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('is empty for a problem with no published revision', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'no-rev-owner');
      await db
        .insert(problems)
        .values({ code: 'norev', name: 'No revision', statement: 's', createdBy: owner.id });
      const app = await buildApp(db);
      try {
        const res = await request(app.getHttpServer()).get('/api/v1/problems/norev');
        expect(res.status).toBe(200);
        // There are no authored limits to adjust, and inventing a base to
        // multiply would put a limit on screen that nobody wrote.
        expect(res.body.languageLimits).toEqual([]);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('POST /submissions — a refused language', () => {
  it('404s for a language this problem refuses, with the same code as an unknown one', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      await db.insert(schema.problemLanguageLimits).values({
        problemId: await problemId(db, 'aplusb'),
        languageId: await languageId(db, 'python3'),
        allowed: false,
      });
      const user = await insertUser(db, 'refused-lang');
      const app = await buildApp(db);
      try {
        const service = app.get(SubmissionAccessService);
        // One code for "no such key", "deactivated" and "this problem refuses
        // it": a distinct error would make the refusal an oracle, and the
        // pupil's answer is the picker omitting it either way.
        await expect(
          service.create(actorFor(user.id), {
            problemCode: 'aplusb',
            languageKey: 'python3',
            source: 'print(1)',
          }),
        ).rejects.toMatchObject({ status: 404, code: 'language_not_found' });

        // The refusal is scoped to the pair, not to the language: C++ on the
        // same problem, and Python on another problem, both still work.
        await expect(
          service.create(actorFor(user.id), {
            problemCode: 'aplusb',
            languageKey: 'cpp17',
            source: 'int main(){}',
          }),
        ).resolves.toMatchObject({ id: expect.any(Number) });
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('accepts a language the problem says nothing about', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const user = await insertUser(db, 'allowed-lang');
      const app = await buildApp(db);
      try {
        const service = app.get(SubmissionAccessService);
        // No `problem_language_limits` row at all — the ordinary case, and
        // the reason the join coalesces to `true` rather than filtering.
        await expect(
          service.create(actorFor(user.id), {
            problemCode: 'aplusb',
            languageKey: 'python3',
            source: 'print(1)',
          }),
        ).resolves.toMatchObject({ id: expect.any(Number) });
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
