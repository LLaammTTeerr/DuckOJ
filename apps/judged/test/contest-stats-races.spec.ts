/**
 * D100 — the counter recompute against concurrency.
 *
 * `recomputeContestProblemStats` is the repair path a rejudge takes and the
 * `?recompute=1` button calls. It rebuilds a contest problem's counters from
 * the rows with an absolute `SET = excluded` upsert. Two ways that used to be
 * wrong the moment anything else touched the same contest problem at the same
 * instant — both silent, both leaving a monitor lying to an organiser:
 *
 *  1. it read `submissions` on a snapshot and never locked those rows, so a
 *     `judged` terminal verdict that committed between the snapshot and the
 *     upsert was discarded — the counter drifts DOWN by that verdict and the
 *     cached `solvers` disagrees with the set it is supposed to count;
 *  2. its `contest_problem_solvers` INSERT had no `ON CONFLICT`, so two
 *     recomputes on one problem (an organiser pressing the button while a
 *     whole-problem rejudge recomputes, or two organisers at once) raced to a
 *     duplicate-key error — the repair button 500s exactly when it is needed.
 *
 * Both need a real Postgres over independent connections: `withTestDb`'s
 * rollback transaction cannot show cross-transaction locking or snapshots.
 */
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
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
import {
  createDb,
  noteContestSubmissionCreated,
  noteContestVerdict,
  recomputeContestProblemStats,
  schema,
  type Db,
} from '@duckoj/db';
import { testDbUrl } from './db.harness.js';

const MINUTE = 60 * 1000;

let N = 0;
async function seed(db: Db) {
  const ns = `r${++N}_${Math.floor(Math.random() * 1e9)}`;
  const [owner] = await db
    .insert(schema.users)
    .values({ username: `owner_${ns}`, email: `owner_${ns}@e.com`, passwordHash: 'x', displayName: 'O' })
    .returning();
  const [language] = await db
    .insert(schema.languages)
    .values({ key: `cpp_${ns}`, name: 'C++17', extension: 'cpp' })
    .returning();
  const [problem] = await db
    .insert(problems)
    .values({ code: `aplusb_${ns}`, name: 'A+B', statement: 's', createdBy: owner!.id })
    .returning();
  await db.insert(schema.packages).values({ hash: `h_${ns}`, sizeBytes: 1, fileCount: 1 });
  const [revision] = await db
    .insert(problemRevisions)
    .values({
      problemId: problem!.id,
      version: 1,
      packageHash: `h_${ns}`,
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
      key: `tinh_${ns}`,
      name: 'T',
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

  const parts = new Map<string, number>();
  const names = { an: `an_${ns}`, binh: `binh_${ns}` };
  for (const username of [names.an, names.binh]) {
    const [user] = await db
      .insert(schema.users)
      .values({ username, email: `${username}@e.com`, passwordHash: 'x', displayName: username })
      .returning();
    const [row] = await db
      .insert(contestParticipations)
      .values({ contestId: contest!.id, userId: user!.id, virtual: 0, startTime: new Date(now - 55 * MINUTE) })
      .returning({ id: contestParticipations.id });
    parts.set(username, row!.id);
  }
  return {
    contestProblemId: contestProblem!.id,
    problemId: problem!.id,
    revisionId: revision!.id,
    languageId: language!.id,
    parts,
    names,
  };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function addSubmission(
  db: Db,
  f: Fixture,
  username: string,
  verdict: string | null,
  state: string,
): Promise<number> {
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username));
  const [submission] = await db
    .insert(submissions)
    .values({
      userId: user!.id,
      problemId: f.problemId,
      revisionId: f.revisionId,
      languageId: f.languageId,
      source: 'x',
      verdict: verdict as never,
      state: state as never,
    })
    .returning({ id: submissions.id });
  await db.insert(contestSubmissions).values({
    participationId: f.parts.get(username)!,
    contestProblemId: f.contestProblemId,
    submissionId: submission!.id,
  });
  return submission!.id;
}

async function statsOf(db: Db, cpId: number) {
  const [row] = await db
    .select()
    .from(contestProblemStats)
    .where(eq(contestProblemStats.contestProblemId, cpId));
  return row!;
}

/** The counters the panel SHOULD show, computed straight from the rows. */
async function groundTruth(db: Db, cpId: number) {
  const [row] = await db.execute<{ accepted: string; solvers: string; pending: string }>(sql`
    select count(*) filter (where s.verdict = 'AC') as accepted,
           count(distinct part.user_id) filter (where s.verdict = 'AC') as solvers,
           count(*) filter (where cs.id is not null and s.state not in ('done','errored')) as pending
      from contest_problems cp
      left join contest_submissions cs on cs.contest_problem_id = cp.id
      left join submissions s on s.id = cs.submission_id
      left join contest_participations part on part.id = cs.participation_id
     where cp.id = ${cpId}
     group by cp.id`);
  return {
    accepted: Number(row!.accepted),
    solvers: Number(row!.solvers),
    pending: Number(row!.pending),
  };
}

describe('recompute under concurrency (D100)', () => {
  it('does not discard a verdict that commits while it runs', async () => {
    const url = await testDbUrl();
    const main = createDb(url);
    const judge = createDb(url); // judged's writeTerminal transaction
    const organiser = createDb(url); // the ?recompute=1 / rejudge recompute
    try {
      const f = await seed(main.db);
      await addSubmission(main.db, f, f.names.an, 'AC', 'done'); // already graded
      const live = await addSubmission(main.db, f, f.names.binh, null, 'queued'); // mid-grade
      await noteContestSubmissionCreated(main.db, f.contestProblemId);
      await recomputeContestProblemStats(main.db, [f.contestProblemId]); // correct baseline
      expect(await statsOf(main.db, f.contestProblemId)).toMatchObject({
        accepted: 1,
        solvers: 1,
        pending: 1,
      });

      // The judge transaction lands its terminal AC and then holds its locks
      // open at the gate — exactly the window `EventWriter.writeTerminal` is
      // in after its fenced UPDATE and `noteContestVerdict`, before commit.
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      const judgeTxn = judge.db.transaction(async (tx) => {
        await tx
          .update(submissions)
          .set({ verdict: 'AC' as never, state: 'done' as never })
          .where(eq(submissions.id, live));
        await noteContestVerdict(
          tx as unknown as Db,
          live,
          { state: 'grading', verdict: null },
          { state: 'done', verdict: 'AC' },
        );
        await gate;
      });

      // Let the judge txn take its locks, then start the recompute — it must
      // block on those locks rather than sail past on a stale snapshot.
      await new Promise((r) => setTimeout(r, 400));
      let recomputeDone = false;
      const recompute = organiser.db
        .transaction(async (tx) => {
          await recomputeContestProblemStats(tx as unknown as Db, [f.contestProblemId]);
        })
        .then(() => {
          recomputeDone = true;
        });

      await new Promise((r) => setTimeout(r, 600));
      // The fix makes the recompute wait for the verdict's transaction; if it
      // has already finished here it read a stale snapshot — the bug.
      expect(recomputeDone).toBe(false);

      openGate();
      await judgeTxn;
      await recompute;

      const stats = await statsOf(main.db, f.contestProblemId);
      const truth = await groundTruth(main.db, f.contestProblemId);
      const solverRows = await main.db
        .select()
        .from(contestProblemSolvers)
        .where(eq(contestProblemSolvers.contestProblemId, f.contestProblemId));

      expect({ accepted: stats.accepted, solvers: stats.solvers, pending: stats.pending }).toEqual(
        truth,
      );
      expect(truth).toEqual({ accepted: 2, solvers: 2, pending: 0 });
      // The cached count must equal the set it caches.
      expect(stats.solvers).toBe(solverRows.length);
    } finally {
      await judge.close();
      await organiser.close();
      await main.close();
    }
  }, 180_000);

  it('survives two recomputes racing on the same contest problem', async () => {
    const url = await testDbUrl();
    const main = createDb(url);
    const a = createDb(url);
    const b = createDb(url);
    try {
      const f = await seed(main.db);
      await addSubmission(main.db, f, f.names.an, 'AC', 'done');
      await addSubmission(main.db, f, f.names.binh, 'AC', 'done');
      await recomputeContestProblemStats(main.db, [f.contestProblemId]); // solvers set has two rows

      // Two independent transactions recompute the same problem at once — the
      // whole-problem rejudge and an organiser's ?recompute=1, say.
      await Promise.all([
        a.db.transaction(async (tx) => {
          await recomputeContestProblemStats(tx as unknown as Db, [f.contestProblemId]);
        }),
        b.db.transaction(async (tx) => {
          await recomputeContestProblemStats(tx as unknown as Db, [f.contestProblemId]);
        }),
      ]);

      const stats = await statsOf(main.db, f.contestProblemId);
      const truth = await groundTruth(main.db, f.contestProblemId);
      expect({ accepted: stats.accepted, solvers: stats.solvers, pending: stats.pending }).toEqual(
        truth,
      );
      expect(truth.solvers).toBe(2);
    } finally {
      await a.close();
      await b.close();
      await main.close();
    }
  }, 180_000);
});
