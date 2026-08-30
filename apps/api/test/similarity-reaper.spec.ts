/**
 * F16 part A — the reaper for similarity runs whose process died (D83).
 *
 * F15's first concern: a crash between "the `running` row is committed" and
 * "the work writes its ending" leaves that contest's button answering 409
 * forever. These tests are the two halves of the fix — what must be reaped,
 * and, the load-bearing half, what must NOT be: a run that is genuinely
 * still comparing holds the contest's advisory lock, and a sweep one
 * comparison too greedy marks a report abandoned while it is being written.
 */
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { contests, similarityRuns } from '@duckoj/db/guarded';
import { createDb, type Db } from '@duckoj/db';
import { SIMILARITY_LOCK } from '../src/authz/contest.similarity.js';
import {
  DEFAULT_SIMILARITY_REAPER_BOUNDS,
  SimilarityRunReaper,
  type SimilarityReaperBounds,
} from '../src/authz/similarity.reaper.js';
import { testDbUrl, withTestDb } from './db.harness.js';
import { insertUser } from './submissions.fixtures.js';

const MINUTE = 60_000;

async function seedContest(db: Db, key: string): Promise<{ contestId: number; ownerId: number }> {
  const owner = await insertUser(db, `${key}-owner`);
  const now = Date.now();
  const [contest] = await db
    .insert(contests)
    .values({
      key,
      name: 'Thi thử tỉnh',
      startTime: new Date(now - 120 * MINUTE),
      endTime: new Date(now - 60 * MINUTE),
      format: 'icpc',
      visibility: 'public',
      createdBy: owner.id,
    })
    .returning({ id: contests.id });
  return { contestId: contest!.id, ownerId: owner.id };
}

async function insertRun(
  db: Db,
  contestId: number,
  startedAt: Date,
  status = 'running',
): Promise<number> {
  const [run] = await db
    .insert(similarityRuns)
    .values({ contestId, status, threshold: 0.6, startedAt })
    .returning({ id: similarityRuns.id });
  return run!.id;
}

async function statusOf(db: Db, id: number): Promise<{ status: string; error: string | null; finishedAt: Date | null }> {
  const [row] = await db
    .select({
      status: similarityRuns.status,
      error: similarityRuns.error,
      finishedAt: similarityRuns.finishedAt,
    })
    .from(similarityRuns)
    .where(eq(similarityRuns.id, id));
  return row!;
}

/** The defaults, with a process start old enough that only age can reap. */
function bounds(over: Partial<SimilarityReaperBounds> = {}): SimilarityReaperBounds {
  return {
    ...DEFAULT_SIMILARITY_REAPER_BOUNDS,
    processStartedAt: new Date(Date.now() - 24 * 60 * MINUTE),
    ...over,
  };
}

describe('SimilarityRunReaper (D83)', () => {
  it('abandons a run stuck past the age limit and leaves a young one running', async () => {
    await withTestDb(async (db) => {
      const now = new Date();
      const { contestId } = await seedContest(db, 'reap-age');
      const stuck = await insertRun(db, contestId, new Date(now.getTime() - 20 * MINUTE));
      const fresh = await insertRun(db, contestId, new Date(now.getTime() - 2 * MINUTE));

      const reaped = await new SimilarityRunReaper(db, bounds()).reap(now);
      expect(reaped).toBe(1);

      const dead = await statusOf(db, stuck);
      expect(dead.status).toBe('failed');
      expect(dead.error).toBe('abandoned');
      expect(dead.finishedAt).not.toBeNull();

      // The load-bearing negative: a contest still being compared at minute
      // two must not have its report cancelled out from under it.
      expect((await statusOf(db, fresh)).status).toBe('running');
    });
  }, 120_000);

  it('abandons a young run whose process is gone — it started before this one did', async () => {
    await withTestDb(async (db) => {
      const now = new Date();
      const { contestId } = await seedContest(db, 'reap-boot');
      // Two minutes old, so the age branch cannot explain this: the only
      // thing that marks it is that no process alive today started it.
      const orphan = await insertRun(db, contestId, new Date(now.getTime() - 2 * MINUTE));

      const reaped = await new SimilarityRunReaper(
        db,
        bounds({ processStartedAt: new Date(now.getTime() - MINUTE) }),
      ).reap(now);

      expect(reaped).toBe(1);
      expect((await statusOf(db, orphan)).error).toBe('abandoned');
    });
  }, 120_000);

  it('never touches a finished or failed row', async () => {
    await withTestDb(async (db) => {
      const now = new Date();
      const { contestId } = await seedContest(db, 'reap-done');
      const finished = await insertRun(db, contestId, new Date(now.getTime() - 90 * MINUTE), 'finished');
      const failed = await insertRun(db, contestId, new Date(now.getTime() - 90 * MINUTE), 'failed');

      expect(await new SimilarityRunReaper(db, bounds()).reap(now)).toBe(0);
      expect((await statusOf(db, finished)).status).toBe('finished');
      expect((await statusOf(db, failed)).status).toBe('failed');
      expect((await statusOf(db, failed)).error).toBeNull();
    });
  }, 120_000);

  it('does not stamp a run that finished between the candidate query and the write', async () => {
    await withTestDb(async (db) => {
      const now = new Date();
      const { contestId } = await seedContest(db, 'reap-race');
      // Exactly the row the candidate query saw as `running` a moment ago and
      // that the background work has since completed.
      const landed = await insertRun(db, contestId, new Date(now.getTime() - 30 * MINUTE), 'finished');

      const reaper = new SimilarityRunReaper(db, bounds());
      expect(await reaper.reapContestRuns(contestId, [landed], now)).toBe(0);
      const row = await statusOf(db, landed);
      expect(row.status).toBe('finished');
      expect(row.error).toBeNull();
    });
  }, 120_000);

  /**
   * The one that needs real committed data on two connections: an advisory
   * lock is per SESSION, so a nested savepoint inside `withTestDb` would take
   * it re-entrantly and prove nothing.
   */
  it('leaves a run alone while somebody still holds the contest lock', async () => {
    const url = await testDbUrl();
    const holder = createDb(url);
    const reaper = createDb(url);
    const key = `reap-lock-${String(Date.now())}`;
    try {
      const { contestId } = await seedContest(reaper.db, key);
      const now = new Date();
      const slow = await insertRun(reaper.db, contestId, new Date(now.getTime() - 45 * MINUTE));

      // A run in flight: `execute` holds this exact lock for the whole of its
      // transaction, in whatever process is doing the work.
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const locked = holder.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${SIMILARITY_LOCK}, ${contestId})`);
        await held;
      });
      // Give the lock a moment to actually be taken before racing it.
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(await new SimilarityRunReaper(reaper.db, bounds()).reap(now)).toBe(0);
      expect((await statusOf(reaper.db, slow)).status).toBe('running');

      release();
      await locked;

      // And once the holder is gone — which is what a crash looks like from
      // the database's side — the same sweep reaps it.
      expect(await new SimilarityRunReaper(reaper.db, bounds()).reap(now)).toBe(1);
      expect((await statusOf(reaper.db, slow)).error).toBe('abandoned');
    } finally {
      // Nothing is cleaned up: this spec file owns its own container, and the
      // contest key is unique to this run.
      await holder.close();
      await reaper.close();
    }
  }, 180_000);
});
