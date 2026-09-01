/**
 * D100 — what `judged` owes the organiser's monitor.
 *
 * The monitor's per-problem panel no longer aggregates `contest_submissions`
 * and `submissions`; it reads `contest_problem_stats`, and this process is
 * the only one that can move that row when a verdict lands. So the claims
 * worth pinning here are not "the verdict was written" (`event-writer.spec.ts`
 * owns that) but the three ways a counter can be wrong forever:
 *
 *  - it does not move at all, and the panel under-reports every AC;
 *  - it moves twice for one person, and `solvers` — a count of PEOPLE —
 *    drifts upwards until somebody recomputes;
 *  - it moves for a write the fence rejected, so a partitioned judge's stale
 *    packet inflates a contest it was never allowed to touch.
 *
 * Each is a silent failure: nothing downstream of a wrong counter throws.
 */
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import {
  contestParticipations,
  contestProblems,
  contestProblemSolvers,
  contestProblemStats,
  contestSubmissions,
  contests,
  problems,
  problemRevisions,
  submissions,
} from '@duckoj/db/guarded';
import { noteContestSubmissionCreated, schema, type Db } from '@duckoj/db';
import { EventWriter } from '../src/event-writer.js';
import { JobStore, type ClaimedJob } from '../src/job-store.js';
import { withTestDb } from './db.harness.js';

const MINUTE = 60 * 1000;

interface Fixture {
  contestProblemId: number;
  problemId: number;
  revisionId: number;
  languageId: number;
  participationIds: Map<string, number>;
}

/** One contest, one problem in it, two competitors holding participations. */
async function seedContest(db: Db): Promise<Fixture> {
  const [owner] = await db
    .insert(schema.users)
    .values({ username: 'chuthi', email: 'c@e.com', passwordHash: 'x', displayName: 'Chủ thi' })
    .returning();
  // Migration 0042 seeds the language catalogue (F-39/D154), so `cpp17`
  // exists in every migrated database and inserting it here is now a unique
  // violation on `languages_key_idx`. Read it instead: after 0042 the
  // catalogue is schema-seeded data, not something a fixture owns.
  const [language] = await db
    .select()
    .from(schema.languages)
    .where(eq(schema.languages.key, 'cpp17'));
  const [problem] = await db
    .insert(problems)
    .values({ code: 'aplusb', name: 'A+B', statement: 's', createdBy: owner!.id })
    .returning();
  await db.insert(schema.packages).values({ hash: 'h', sizeBytes: 1, fileCount: 1 });
  const [revision] = await db
    .insert(problemRevisions)
    .values({
      problemId: problem!.id,
      version: 1,
      packageHash: 'h',
      state: 'published',
      createdBy: owner!.id,
      timeMs: 1000,
      memoryKb: 256_000,
      testCount: 5,
      totalPoints: 100,
      checkerKind: 'wcmp',
    })
    .returning();
  const now = Date.now();
  const [contest] = await db
    .insert(contests)
    .values({
      key: 'tinh2026',
      name: 'Thi tỉnh',
      startTime: new Date(now - 60 * MINUTE),
      endTime: new Date(now + 60 * MINUTE),
      format: 'icpc',
      visibility: 'public',
      createdBy: owner!.id,
    })
    .returning({ id: contests.id });
  const [contestProblem] = await db
    .insert(contestProblems)
    .values({ contestId: contest!.id, problemId: problem!.id, label: 'A', points: 100, order: 0 })
    .returning({ id: contestProblems.id });

  const participationIds = new Map<string, number>();
  for (const username of ['an', 'binh']) {
    const [user] = await db
      .insert(schema.users)
      .values({
        username,
        email: `${username}@e.com`,
        passwordHash: 'x',
        displayName: username,
      })
      .returning();
    const [row] = await db
      .insert(contestParticipations)
      .values({
        contestId: contest!.id,
        userId: user!.id,
        virtual: 0,
        startTime: new Date(now - 55 * MINUTE),
      })
      .returning({ id: contestParticipations.id });
    participationIds.set(username, row!.id);
  }

  return {
    contestProblemId: contestProblem!.id,
    problemId: problem!.id,
    revisionId: revision!.id,
    languageId: language!.id,
    participationIds,
  };
}

/**
 * A submission into the contest, with its counter moved exactly as
 * `SubmissionAccessService.create` moves it — this fixture stands in for the
 * API, which this process never talks to.
 */
async function handIn(
  db: Db,
  store: JobStore,
  fixture: Fixture,
  username: string,
): Promise<{ submissionId: number; job: ClaimedJob }> {
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username));
  const [submission] = await db
    .insert(submissions)
    .values({
      userId: user!.id,
      problemId: fixture.problemId,
      revisionId: fixture.revisionId,
      languageId: fixture.languageId,
      source: 'int main(){}',
    })
    .returning({ id: submissions.id });
  await db.insert(contestSubmissions).values({
    participationId: fixture.participationIds.get(username)!,
    contestProblemId: fixture.contestProblemId,
    submissionId: submission!.id,
  });
  // The API's own counter write, called by its own name rather than
  // reimplemented: a fixture that hand-rolled the increment would keep
  // passing after `noteContestSubmissionCreated` stopped being right.
  await noteContestSubmissionCreated(db, fixture.contestProblemId);

  await store.enqueue({
    revisionId: fixture.revisionId,
    packageHash: 'h',
    submissionId: submission!.id,
  });
  const job = (await store.claim('worker-a'))!;
  return { submissionId: submission!.id, job };
}

async function statsOf(db: Db, contestProblemId: number) {
  const [row] = await db
    .select()
    .from(contestProblemStats)
    .where(eq(contestProblemStats.contestProblemId, contestProblemId));
  return row;
}

describe('a terminal verdict and the monitor’s counters (D100)', () => {
  it('drops pending, raises accepted, and counts the solver once', async () => {
    await withTestDb(async (db) => {
      const publish = vi.fn(async () => {});
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish } as never);
      const fixture = await seedContest(db);

      const first = await handIn(db, store, fixture, 'an');
      expect(await statsOf(db, fixture.contestProblemId)).toMatchObject({
        submitted: 1,
        accepted: 0,
        solvers: 0,
        pending: 1,
      });

      await writer.apply(first.job, {
        type: 'finished',
        verdict: 'AC',
        points: 100,
        maxPoints: 100,
        timeMs: 3,
        memoryKb: 900,
      });
      expect(await statsOf(db, fixture.contestProblemId)).toMatchObject({
        submitted: 1,
        accepted: 1,
        solvers: 1,
        pending: 0,
      });

      // The SAME person solving it again is one more accepted ROW and not one
      // more solver: `solvers` counts people, and the gap between the two
      // numbers is the whole reason D95 shows both.
      const second = await handIn(db, store, fixture, 'an');
      await writer.apply(second.job, {
        type: 'finished',
        verdict: 'AC',
        points: 100,
        maxPoints: 100,
        timeMs: 3,
        memoryKb: 900,
      });
      expect(await statsOf(db, fixture.contestProblemId)).toMatchObject({
        submitted: 2,
        accepted: 2,
        solvers: 1,
        pending: 0,
      });

      // A different person does move it.
      const other = await handIn(db, store, fixture, 'binh');
      await writer.apply(other.job, {
        type: 'finished',
        verdict: 'AC',
        points: 100,
        maxPoints: 100,
        timeMs: 3,
        memoryKb: 900,
      });
      expect(await statsOf(db, fixture.contestProblemId)).toMatchObject({
        submitted: 3,
        accepted: 3,
        solvers: 2,
        pending: 0,
      });
      const solvers = await db
        .select()
        .from(contestProblemSolvers)
        .where(eq(contestProblemSolvers.contestProblemId, fixture.contestProblemId));
      expect(solvers).toHaveLength(2);
    });
  }, 180_000);

  it('empties pending for a non-AC verdict without touching accepted', async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish: async () => {} } as never);
      const fixture = await seedContest(db);
      const { job } = await handIn(db, store, fixture, 'an');

      await writer.apply(job, {
        type: 'finished',
        verdict: 'WA',
        points: 0,
        maxPoints: 100,
        timeMs: 3,
        memoryKb: 900,
      });
      expect(await statsOf(db, fixture.contestProblemId)).toMatchObject({
        submitted: 1,
        accepted: 0,
        solvers: 0,
        pending: 0,
      });
    });
  }, 180_000);

  it('counts an errored attempt as no longer pending', async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish: async () => {} } as never);
      const fixture = await seedContest(db);
      const { job } = await handIn(db, store, fixture, 'an');

      await writer.apply(job, { type: 'internalError', message: 'boom' });
      expect(await statsOf(db, fixture.contestProblemId)).toMatchObject({
        accepted: 0,
        pending: 0,
      });
    });
  }, 180_000);

  it('moves nothing when the fence rejects a superseded attempt', async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish: async () => {} } as never);
      const fixture = await seedContest(db);
      const { job } = await handIn(db, store, fixture, 'an');

      // The stale packet the fence exists for. `isCurrentAttempt` is stubbed
      // to have already passed — that is the state `apply` is in when it
      // reaches the write — and the supersession lands in the gap it leaves,
      // so what rejects this write is the fence folded into the UPDATE's own
      // WHERE, and what must not move is the counter beside it.
      vi.spyOn(store, 'isCurrentAttempt').mockResolvedValue(true);
      await db.execute(sql`update grading_jobs set attempt = attempt + 1`);
      await writer.apply(job, {
        type: 'finished',
        verdict: 'AC',
        points: 100,
        maxPoints: 100,
        timeMs: 3,
        memoryKb: 900,
      });

      expect(await statsOf(db, fixture.contestProblemId)).toMatchObject({
        submitted: 1,
        accepted: 0,
        solvers: 0,
        pending: 1,
      });
    });
  }, 180_000);

  it('leaves a practice submission alone — no contest row, no counter', async () => {
    await withTestDb(async (db) => {
      const store = new JobStore(db);
      const writer = new EventWriter(db, store, { publish: async () => {} } as never);
      const fixture = await seedContest(db);

      const [user] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.username, 'an'));
      const [submission] = await db
        .insert(submissions)
        .values({
          userId: user!.id,
          problemId: fixture.problemId,
          revisionId: fixture.revisionId,
          languageId: fixture.languageId,
          source: 'int main(){}',
        })
        .returning({ id: submissions.id });
      await store.enqueue({
        revisionId: fixture.revisionId,
        packageHash: 'h',
        submissionId: submission!.id,
      });
      const job = (await store.claim('worker-a'))!;

      await writer.apply(job, {
        type: 'finished',
        verdict: 'AC',
        points: 100,
        maxPoints: 100,
        timeMs: 3,
        memoryKb: 900,
      });

      expect(await statsOf(db, fixture.contestProblemId)).toBeUndefined();
      const [row] = await db.select().from(submissions).where(eq(submissions.id, submission!.id));
      expect(row?.verdict).toBe('AC');
    });
  }, 180_000);
});
