import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { contestParticipations, contestProblems, contestSubmissions, contests, problemTags, problems } from '@duckoj/db/guarded';
import { createDb, schema, type Db } from '@duckoj/db';
import { ProblemAccessService } from '../src/authz/problem.access.js';
import { AppError } from '../src/common/app.error.js';
import type { Actor } from '../src/authz/actor.js';
import type { PackageStore } from '../src/packages/package.store.js';
import { testDbUrl, withTestDb } from './db.harness.js';
import { bypassCache } from './cache.harness.js';
import {
  insertGradedSubmission,
  insertUser,
  seedProblemAndLanguage,
  seedProblemWithSourceAccess,
} from './submissions.fixtures.js';

/**
 * D125 — the per-viewer `status` filter (`solved` | `attempted` | `unsolved`)
 * and the `myStatus` marker on every list row. "solved" is window-gated
 * exactly as D49's `solvedCount` is: an `AC` made inside a still-open contest
 * window does not count until the window closes, so this file seeds the same
 * open/closed participation shapes `problem-stats.spec.ts` does and asserts
 * the marker and the filter both honour it.
 */

const MINUTE = 60_000;

const UNUSED_STORE: PackageStore = {
  has: () => Promise.reject(new Error('unexpected package store access in this test')),
  put: () => Promise.reject(new Error('unexpected package store access in this test')),
  get: () => Promise.reject(new Error('unexpected package store access in this test')),
  delete: () => Promise.reject(new Error('unexpected package store access in this test')),
};

function actorFor(userId: number): Actor {
  return { userId, globalRole: 'user', scopes: ['problems:read'], via: 'session' };
}

/**
 * Copied from `problem-stats.spec.ts` rather than exported from the fixtures —
 * the same precedent that file set relative to `submission-freeze.spec.ts`.
 * Routes `submissionId` into a fresh contest holding `problemId`, one
 * participation of the given age; an OPEN window is `startedMinutesAgo` well
 * inside `durationMinutes`, a CLOSED one is a duration that has already ended.
 */
async function routeIntoContest(
  db: Db,
  opts: {
    key: string;
    problemId: number;
    userId: number;
    submissionId: number;
    startedMinutesAgo: number;
    durationMinutes: number;
    virtual?: number;
  },
): Promise<void> {
  const owner = await insertUser(db, `${opts.key}-owner`, 'admin');
  const start = new Date(Date.now() - opts.startedMinutesAgo * MINUTE);
  const [contest] = await db
    .insert(contests)
    .values({
      key: opts.key,
      name: opts.key,
      startTime: start,
      endTime: new Date(start.getTime() + opts.durationMinutes * MINUTE),
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
    .values({ contestId: contest!.id, userId: opts.userId, virtual: opts.virtual ?? 0, startTime: start })
    .returning({ id: contestParticipations.id });
  await db
    .insert(contestSubmissions)
    .values({
      participationId: participation!.id,
      contestProblemId: contestProblem!.id,
      submissionId: opts.submissionId,
    });
}

/** The codes a page returned, for terse set assertions. */
function codesOf(page: { items: { code: string }[] }): string[] {
  return page.items.map((p) => p.code).sort();
}

describe('ProblemAccessService — the `status` filter and `myStatus` marker (D125)', () => {
  it('reports myStatus solved / attempted / null from the viewer’s own submissions', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const solved = await seedProblemWithSourceAccess(db, { code: 'st-solved' });
      const attempted = await seedProblemWithSourceAccess(db, { code: 'st-attempted' });
      await seedProblemWithSourceAccess(db, { code: 'st-untouched' });
      const viewer = await insertUser(db, 'st-viewer');
      await insertGradedSubmission(db, { userId: viewer.id, problemId: solved.id, verdict: 'AC', points: 100, maxPoints: 100 });
      await insertGradedSubmission(db, { userId: viewer.id, problemId: attempted.id, verdict: 'WA', points: 0, maxPoints: 100 });

      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
      const page = await service.listVisible(actorFor(viewer.id), { limit: 25 });
      const byCode = new Map(page.items.map((p) => [p.code, p.myStatus]));
      expect(byCode.get('st-solved')).toBe('solved');
      expect(byCode.get('st-attempted')).toBe('attempted');
      expect(byCode.get('st-untouched')).toBeNull();
    });
  }, 120_000);

  it('myStatus is null for an anonymous caller', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const solved = await seedProblemWithSourceAccess(db, { code: 'anon-solved' });
      const someone = await insertUser(db, 'anon-someone');
      await insertGradedSubmission(db, { userId: someone.id, problemId: solved.id, verdict: 'AC', points: 100, maxPoints: 100 });

      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
      const page = await service.listVisible(null, { limit: 25 });
      expect(page.items.every((p) => p.myStatus === null)).toBe(true);
    });
  }, 120_000);

  it('filters to solved, attempted and unsolved independently', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const solved = await seedProblemWithSourceAccess(db, { code: 'f-solved' });
      const attempted = await seedProblemWithSourceAccess(db, { code: 'f-attempted' });
      await seedProblemWithSourceAccess(db, { code: 'f-unsolved' });
      const viewer = await insertUser(db, 'f-viewer');
      await insertGradedSubmission(db, { userId: viewer.id, problemId: solved.id, verdict: 'AC', points: 100, maxPoints: 100 });
      await insertGradedSubmission(db, { userId: viewer.id, problemId: attempted.id, verdict: 'WA', points: 0, maxPoints: 100 });

      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
      const a = actorFor(viewer.id);
      expect(codesOf(await service.listVisible(a, { limit: 25 }, { status: 'solved' }))).toEqual(['f-solved']);
      expect(codesOf(await service.listVisible(a, { limit: 25 }, { status: 'attempted' }))).toEqual(['f-attempted']);
      // `aplusb` (seeded by `seedProblemAndLanguage`, never submitted to) is
      // itself unsolved, so this asserts membership, not an exact set: the
      // untouched problem is IN and the solved/attempted ones are OUT.
      const unsolved = codesOf(await service.listVisible(a, { limit: 25 }, { status: 'unsolved' }));
      expect(unsolved).toContain('f-unsolved');
      expect(unsolved).not.toContain('f-solved');
      expect(unsolved).not.toContain('f-attempted');
    });
  }, 120_000);

  it('composes status with tag and difficulty filters (AND)', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const [tag] = await db.insert(schema.tags).values({ slug: 'dp', nameVi: 'QHĐ', nameEn: 'DP' }).returning();
      const solvedTagged = await seedProblemWithSourceAccess(db, { code: 'c-solved-dp' });
      const solvedPlain = await seedProblemWithSourceAccess(db, { code: 'c-solved-plain' });
      const unsolvedTagged = await seedProblemWithSourceAccess(db, { code: 'c-unsolved-dp' });
      await db.insert(problemTags).values([
        { problemId: solvedTagged.id, tagId: tag!.id },
        { problemId: unsolvedTagged.id, tagId: tag!.id },
      ]);
      // Difficulty: only the solved+tagged one is in [3,7].
      await db.update(problems).set({ difficulty: 5 }).where(eq(problems.id, solvedTagged.id));
      await db.update(problems).set({ difficulty: 5 }).where(eq(problems.id, solvedPlain.id));
      const viewer = await insertUser(db, 'c-viewer');
      await insertGradedSubmission(db, { userId: viewer.id, problemId: solvedTagged.id, verdict: 'AC', points: 100, maxPoints: 100 });
      await insertGradedSubmission(db, { userId: viewer.id, problemId: solvedPlain.id, verdict: 'AC', points: 100, maxPoints: 100 });

      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
      const a = actorFor(viewer.id);
      // solved AND carries `dp` → only c-solved-dp (c-solved-plain lacks the tag, c-unsolved-dp is unsolved).
      expect(codesOf(await service.listVisible(a, { limit: 25 }, { status: 'solved', tags: ['dp'] }))).toEqual(['c-solved-dp']);
      // solved AND difficulty 3..7 → both solved ones (both rated 5).
      expect(codesOf(await service.listVisible(a, { limit: 25 }, { status: 'solved', difficultyMin: 3, difficultyMax: 7 }))).toEqual([
        'c-solved-dp',
        'c-solved-plain',
      ]);
    });
  }, 120_000);

  it('refuses the status filter for an anonymous caller with 422', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      await seedProblemWithSourceAccess(db, { code: 'anon-422' });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
      await expect(service.listVisible(null, { limit: 25 }, { status: 'solved' })).rejects.toMatchObject({
        status: 422,
        code: 'status_requires_auth',
      });
      // An anonymous caller with NO status filter is still served.
      const page = await service.listVisible(null, { limit: 25 });
      expect(page.items.map((p) => p.code)).toContain('anon-422');
    });
  }, 120_000);

  it('does not flip status to solved while the contest window is open, and flips once it closes', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const live = await seedProblemWithSourceAccess(db, { code: 'w-live' });
      const closed = await seedProblemWithSourceAccess(db, { code: 'w-closed' });
      const viewer = await insertUser(db, 'w-viewer');
      // The viewer's OWN AC on each — but each is routed into a contest, one
      // still running, one finished. D23 shows the viewer their own verdict,
      // yet D125's `solved` is window-gated like D49's counter.
      const liveAc = await insertGradedSubmission(db, { userId: viewer.id, problemId: live.id, verdict: 'AC', points: 100, maxPoints: 100 });
      await routeIntoContest(db, { key: 'w-live-c', problemId: live.id, userId: viewer.id, submissionId: liveAc, startedMinutesAgo: 10, durationMinutes: 300 });
      const closedAc = await insertGradedSubmission(db, { userId: viewer.id, problemId: closed.id, verdict: 'AC', points: 100, maxPoints: 100 });
      await routeIntoContest(db, { key: 'w-closed-c', problemId: closed.id, userId: viewer.id, submissionId: closedAc, startedMinutesAgo: 600, durationMinutes: 300 });

      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
      const a = actorFor(viewer.id);
      const byCode = new Map((await service.listVisible(a, { limit: 25 })).items.map((p) => [p.code, p.myStatus]));
      // The in-window AC is a submission, so it reads attempted — not solved,
      // not unsolved. The finished one reads solved.
      expect(byCode.get('w-live')).toBe('attempted');
      expect(byCode.get('w-closed')).toBe('solved');
      // And the filter agrees on both counts.
      expect(codesOf(await service.listVisible(a, { limit: 25 }, { status: 'solved' }))).toEqual(['w-closed']);
      expect(codesOf(await service.listVisible(a, { limit: 25 }, { status: 'attempted' }))).toEqual(['w-live']);
    });
  }, 120_000);

  it('carries myStatus on the problem detail, agreeing with the list', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const closed = await seedProblemWithSourceAccess(db, { code: 'd-closed' });
      const viewer = await insertUser(db, 'd-viewer');
      const ac = await insertGradedSubmission(db, { userId: viewer.id, problemId: closed.id, verdict: 'AC', points: 100, maxPoints: 100 });
      await routeIntoContest(db, { key: 'd-closed-c', problemId: closed.id, userId: viewer.id, submissionId: ac, startedMinutesAgo: 600, durationMinutes: 300 });

      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
      const detail = await service.getVisible(actorFor(viewer.id), 'd-closed');
      expect(detail.myStatus).toBe('solved');
    });
  }, 120_000);

  it('sends ONE main statement carrying me_solved — no extra round trip for the filter', async () => {
    const url = await testDbUrl();
    const queries: string[] = [];
    const { db, close } = createDb(url, { logger: { logQuery: (query: string) => queries.push(query) } });
    try {
      await db
        .transaction(async (tx) => {
          const t = tx as unknown as Db;
          await seedProblemAndLanguage(t);
          const solved = await seedProblemWithSourceAccess(t, { code: 'q-solved' });
          const viewer = await insertUser(t, 'q-viewer');
          await insertGradedSubmission(t, { userId: viewer.id, problemId: solved.id, verdict: 'AC', points: 100, maxPoints: 100 });
          const service = new ProblemAccessService(t, UNUSED_STORE, bypassCache());

          queries.length = 0;
          await service.listVisible(actorFor(viewer.id), { limit: 25 }, { status: 'solved' });
          const selects = queries.filter((q) => q.toLowerCase().includes('from "problems"'));
          expect(selects).toHaveLength(1);
          expect(selects[0]).toContain('me_solved');
          throw new AppError(0, 'rollback', 'rollback');
        })
        .catch((error: unknown) => {
          if (!(error instanceof AppError) || error.code !== 'rollback') throw error;
        });
    } finally {
      await close();
    }
  }, 120_000);
});
