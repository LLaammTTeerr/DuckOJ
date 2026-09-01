/**
 * D100 — the API's half of the monitor's per-problem counters.
 *
 * `apps/judged/test/contest-problem-stats.spec.ts` pins what a verdict does
 * to them. This file pins the other three moments, all of them in this
 * process:
 *
 *  - a submission is CREATED, and the counter has to move inside the same
 *    transaction as the `contest_submissions` row — the panel no longer
 *    aggregates that table, so a row without its count is a permanent
 *    off-by-one nothing downstream can detect;
 *  - a REJUDGE takes verdicts away, and the counters are rebuilt rather than
 *    decremented;
 *  - an organiser presses `?recompute=1`, which must repair the counters AND
 *    not answer out of the five-second cache it was pressed because of.
 *
 * And, since F-43, the fourth moment that moves a panel from inside this
 * process and is not a submission at all: a CLARIFICATION. D162.
 *
 * The read itself is asserted through `ContestMonitorService`, so what is
 * checked is the number an organiser sees rather than a row in a table.
 */
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  contestParticipations,
  contestProblems,
  contestProblemSolvers,
  contestProblemStats,
  contestSubmissions,
  contests,
  problemRevisions,
  problems,
  submissions,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { ContestAccessService } from '../src/authz/contest.access.js';
import { ContestClarificationsService } from '../src/authz/contest.clarifications.js';
import { ContestMonitorService } from '../src/authz/contest.monitor.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { RateLimiter } from '../src/common/rate-limiter.js';
import { RatingService } from '../src/authz/rating.service.js';
import { RejudgeService } from '../src/authz/rejudge.access.js';
import { SubmissionAccessService } from '../src/authz/submission.access.js';
import { ScoreboardCache, type ScoreboardCacheStore } from '../src/authz/scoreboard.cache.js';
import { CONTEST_PRESENCE, type ContestPresence } from '../src/realtime/contest-presence.js';
import type { SubmissionPublisher } from '../src/realtime/submission-publisher.js';
import type { Actor } from '../src/authz/actor.js';
import { bypassCache } from './cache.harness.js';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { insertUser, registerAndLogin, userIdOf } from './submissions.fixtures.js';

const MINUTE = 60 * 1000;
const KEY = 'd100';

interface Seeded {
  contestId: number;
  problemIds: number[];
  contestProblemIds: number[];
  languageId: number;
}

/** One running contest, two problems, and whoever asks holding a live row. */
async function seedContest(db: Db, ownerId: number, key = KEY): Promise<Seeded> {
  const [language] = await db
    .insert(schema.languages)
    .values({ key: `${key}-cpp`, name: 'C++17', extension: 'cpp' })
    .returning({ id: schema.languages.id });
  await db.insert(schema.packages).values({ hash: `${key}-pkg`, sizeBytes: 1, fileCount: 1 });

  const problemIds: number[] = [];
  for (const label of ['a', 'b']) {
    const [problem] = await db
      .insert(problems)
      .values({
        code: `${key}-${label}`,
        name: `Bài ${label.toUpperCase()}`,
        statement: 'Cho $a+b$.',
        visibility: 'public',
        createdBy: ownerId,
      })
      .returning({ id: problems.id });
    const [revision] = await db
      .insert(problemRevisions)
      .values({
        problemId: problem!.id,
        version: 1,
        packageHash: `${key}-pkg`,
        state: 'published',
        createdBy: ownerId,
        timeMs: 1000,
        memoryKb: 256_000,
        testCount: 5,
        totalPoints: 100,
        checkerKind: 'wcmp',
      })
      .returning({ id: problemRevisions.id });
    await db
      .update(problems)
      .set({ currentRevisionId: revision!.id })
      .where(eq(problems.id, problem!.id));
    problemIds.push(problem!.id);
  }

  const now = Date.now();
  const [contest] = await db
    .insert(contests)
    .values({
      key,
      name: 'Thi tỉnh',
      startTime: new Date(now - 60 * MINUTE),
      endTime: new Date(now + 60 * MINUTE),
      format: 'icpc',
      visibility: 'public',
      createdBy: ownerId,
    })
    .returning({ id: contests.id });

  const contestProblemIds: number[] = [];
  for (const [index, problemId] of problemIds.entries()) {
    const [row] = await db
      .insert(contestProblems)
      .values({
        contestId: contest!.id,
        problemId,
        label: index === 0 ? 'A' : 'B',
        points: 100,
        order: index,
      })
      .returning({ id: contestProblems.id });
    contestProblemIds.push(row!.id);
  }

  return {
    contestId: contest!.id,
    problemIds,
    contestProblemIds,
    languageId: language!.id,
  };
}

async function joinLive(db: Db, contestId: number, userId: number): Promise<number> {
  const [row] = await db
    .insert(contestParticipations)
    .values({
      contestId,
      userId,
      virtual: 0,
      startTime: new Date(Date.now() - 30 * MINUTE),
    })
    .returning({ id: contestParticipations.id });
  return row!.id;
}

const NOBODY_ONLINE: ContestPresence = {
  seen: () => Promise.resolve(),
  recent: () => Promise.resolve([]),
};

/**
 * The clarifications service, sharing ONE `ScoreboardCache` with the monitor
 * beside it — which is the whole point of the test below. Two caches would be
 * two independent Maps, the invalidation would land in one and the snapshot
 * would be read from the other, and the assertion would pass against the
 * unfixed code as readily as against the fixed one.
 */
function clarificationsFor(db: Db, cache: ScoreboardCache): ContestClarificationsService {
  return new ContestClarificationsService(
    db,
    new ContestAccessService(db, bypassCache()),
    new NotificationsService(db),
    new RateLimiter(db),
    cache,
  );
}

function monitorFor(db: Db, cache: ScoreboardCache = bypassCache()): ContestMonitorService {
  return new ContestMonitorService(
    db,
    new ContestAccessService(db, bypassCache()),
    cache,
    NOBODY_ONLINE,
  );
}

/** A `ScoreboardCache` over a Map — the real read-through, and a real staleness. */
function realCache(): { cache: ScoreboardCache; entries: Map<string, string> } {
  const entries = new Map<string, string>();
  const store: ScoreboardCacheStore = {
    get: (k) => Promise.resolve(entries.get(k) ?? null),
    set: (k, v) => {
      entries.set(k, v);
      return Promise.resolve();
    },
    del: (keys) => {
      for (const k of keys) entries.delete(k);
      return Promise.resolve();
    },
  };
  return { cache: new ScoreboardCache(store), entries };
}

function actorFor(userId: number, role: 'user' | 'admin' = 'user'): Actor {
  return { userId, globalRole: role, via: 'session', scopes: [] };
}

class RecordingPublisher implements SubmissionPublisher {
  readonly published: number[] = [];
  async publish(submissionId: number): Promise<void> {
    this.published.push(submissionId);
  }
}

describe('creating a contest submission (D100)', () => {
  it('counts it on the per-problem panel the instant the row exists', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'd100-owner');
      const competitor = await insertUser(db, 'd100-an');
      const seeded = await seedContest(db, owner.id);
      await joinLive(db, seeded.contestId, competitor.id);

      const before = await monitorFor(db).snapshot(actorFor(owner.id), KEY);
      expect(before.problems[0]).toMatchObject({ submitted: 0, pending: 0 });

      const submissions = new SubmissionAccessService(db);
      await submissions.create(actorFor(competitor.id), {
        problemCode: `${KEY}-a`,
        languageKey: `${KEY}-cpp`,
        source: 'int main(){}',
        contestKey: KEY,
      });

      const after = await monitorFor(db).snapshot(actorFor(owner.id), KEY);
      expect(after.problems[0]).toMatchObject({
        code: `${KEY}-a`,
        submitted: 1,
        accepted: 0,
        solvers: 0,
        pending: 1,
      });
      // The other problem is untouched: a counter keyed on the wrong contest
      // problem would move both, and both would still add up.
      expect(after.problems[1]).toMatchObject({ submitted: 0, pending: 0 });
    });
  }, 180_000);

  it('does not count a PRACTICE submission to the same problem', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'd100p-owner');
      const competitor = await insertUser(db, 'd100p-an');
      const seeded = await seedContest(db, owner.id, 'd100p');
      await joinLive(db, seeded.contestId, competitor.id);

      await new SubmissionAccessService(db).create(actorFor(competitor.id), {
        problemCode: 'd100p-a',
        languageKey: 'd100p-cpp',
        source: 'int main(){}',
      });

      const snap = await monitorFor(db).snapshot(actorFor(owner.id), 'd100p');
      expect(snap.problems[0]).toMatchObject({ submitted: 0, pending: 0 });
    });
  }, 180_000);
});

describe('a rejudge and the counters (D100)', () => {
  it('rebuilds them, so an AC it took away stops being counted and the attempt is pending again', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'd100r-owner', 'admin');
      const competitor = await insertUser(db, 'd100r-an');
      const seeded = await seedContest(db, owner.id, 'd100r');
      const participationId = await joinLive(db, seeded.contestId, competitor.id);

      const created = await new SubmissionAccessService(db).create(actorFor(competitor.id), {
        problemCode: 'd100r-a',
        languageKey: 'd100r-cpp',
        source: 'int main(){}',
        contestKey: 'd100r',
      });
      // The verdict `judged` would have written, plus the counter move it
      // would have made — this spec is about what a REJUDGE then does to it.
      await db
        .update(submissions)
        .set({ state: 'done', verdict: 'AC', points: 100, maxPoints: 100, judgedAt: new Date() })
        .where(eq(submissions.id, created.id));
      await db
        .update(contestProblemStats)
        .set({ accepted: 1, solvers: 1, pending: 0 })
        .where(eq(contestProblemStats.contestProblemId, seeded.contestProblemIds[0]!));
      await db
        .insert(contestProblemSolvers)
        .values({ contestProblemId: seeded.contestProblemIds[0]!, userId: competitor.id });
      expect(participationId).toBeGreaterThan(0);

      const solved = await monitorFor(db).snapshot(actorFor(owner.id, 'admin'), 'd100r');
      expect(solved.problems[0]).toMatchObject({ accepted: 1, solvers: 1, pending: 0 });

      const rejudge = new RejudgeService(
        db,
        new RecordingPublisher(),
        new RatingService(db, new ContestAccessService(db, bypassCache())),
        bypassCache(),
      );
      await rejudge.rejudgeSubmission(actorFor(owner.id, 'admin'), created.id);

      const after = await monitorFor(db).snapshot(actorFor(owner.id, 'admin'), 'd100r');
      expect(after.problems[0]).toMatchObject({
        submitted: 1,
        accepted: 0,
        solvers: 0,
        pending: 1,
      });
      // The SET, not merely its cached count: a `solvers` that dropped to
      // zero while the row survived would come back the moment anybody else
      // solved the problem and the count was rebuilt from it.
      const solvers = await db
        .select()
        .from(contestProblemSolvers)
        .where(eq(contestProblemSolvers.contestProblemId, seeded.contestProblemIds[0]!));
      expect(solvers).toHaveLength(0);
    });
  }, 180_000);
});

describe('?recompute=1 (D100)', () => {
  it('rebuilds a drifted counter and answers with the rebuilt numbers, not the cached ones', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'd100c-owner');
      const competitor = await insertUser(db, 'd100c-an');
      const seeded = await seedContest(db, owner.id, 'd100c');
      const participationId = await joinLive(db, seeded.contestId, competitor.id);

      // Two rows written straight into the tables — an import, a restore, a
      // future code path that forgot the counter. The counters know nothing
      // about them, which is exactly the state `?recompute=1` exists for.
      for (const verdict of ['AC', 'WA'] as const) {
        const [row] = await db
          .insert(submissions)
          .values({
            userId: competitor.id,
            problemId: seeded.problemIds[0]!,
            revisionId: (
              await db
                .select({ id: problemRevisions.id })
                .from(problemRevisions)
                .where(eq(problemRevisions.problemId, seeded.problemIds[0]!))
            )[0]!.id,
            languageId: seeded.languageId,
            source: 'int main(){}',
            state: 'done',
            verdict,
          })
          .returning({ id: submissions.id });
        await db.insert(contestSubmissions).values({
          participationId,
          contestProblemId: seeded.contestProblemIds[0]!,
          submissionId: row!.id,
        });
      }

      const { cache } = realCache();
      const monitor = monitorFor(db, cache);
      const organiser = actorFor(owner.id);

      const stale = await monitor.snapshot(organiser, 'd100c');
      expect(stale.problems[0]).toMatchObject({ submitted: 0, accepted: 0, solvers: 0 });

      const repaired = await monitor.snapshot(organiser, 'd100c', { recompute: '1' });
      expect(repaired.problems[0]).toMatchObject({
        submitted: 2,
        accepted: 1,
        solvers: 1,
        pending: 0,
      });

      // And the cache now holds the repaired snapshot: an organiser who
      // presses the button and then lets the page poll must not watch the
      // wrong numbers come back for another five seconds.
      const next = await monitor.snapshot(organiser, 'd100c');
      expect(next.problems[0]).toMatchObject({ submitted: 2, accepted: 1, solvers: 1 });
    });
  }, 180_000);

  it('is reachable over HTTP by an organiser and nobody else', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, {
        overrides: [{ provide: CONTEST_PRESENCE, useValue: NOBODY_ONLINE }],
      });
      try {
        const agent = request.agent(app.getHttpServer());
        const cookie = await registerAndLogin(agent, 'd100http');
        const ownerId = await userIdOf(db, 'd100http');
        const seeded = await seedContest(db, ownerId, 'd100http');
        await db.execute(sql`
          update contest_problem_stats set submitted = 99
           where contest_problem_id = ${seeded.contestProblemIds[0]!}
        `);

        const res = await agent
          .get('/api/v1/contests/d100http/monitor?recompute=1')
          .set('Cookie', cookie);
        expect(res.status).toBe(200);
        expect(res.body.problems[0].submitted).toBe(0);

        // A value the schema does not admit is refused before anything is
        // rebuilt — the repair is not a place to be lenient about input.
        const bad = await agent
          .get('/api/v1/contests/d100http/monitor?recompute=yes')
          .set('Cookie', cookie);
        expect(bad.status).toBe(422);

        const outsider = request.agent(app.getHttpServer());
        const theirs = await registerAndLogin(outsider, 'd100stranger');
        const refused = await outsider
          .get('/api/v1/contests/d100http/monitor?recompute=1')
          .set('Cookie', theirs);
        expect(refused.status).toBe(403);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

/**
 * D162 — the panel this cache's own comment used to claim could not move.
 *
 * The comment on `monitorCacheKey` justified having no invalidation at all
 * with "every write that would change this snapshot is a submission or a
 * verdict, and the API does not handle the verdict at all". The snapshot
 * carries a clarifications panel and this process handles every write to it,
 * so the sentence was false the day it was written (B-31 found it).
 *
 * Both cases go through a REAL read-through cache — `realCache()`, the same
 * Map-backed store `?recompute=1` above is proved on — because a bypassed
 * cache cannot be stale and would make either case pass against the unfixed
 * code. The first snapshot is what fills the key; the second is the one an
 * organiser's five-second poll takes, and it is the one that used to lie.
 */
describe('a clarification and the monitor snapshot (D162)', () => {
  it('shows a question asked a moment ago, rather than the panel cached before it', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'd162a-owner');
      const asker = await insertUser(db, 'd162a-an');
      const seeded = await seedContest(db, owner.id, 'd162a');
      await joinLive(db, seeded.contestId, asker.id);

      const { cache } = realCache();
      const monitor = monitorFor(db, cache);
      const organiser = actorFor(owner.id);

      const before = await monitor.snapshot(organiser, 'd162a');
      expect(before.clarifications).toMatchObject({ unanswered: 0 });

      await clarificationsFor(db, cache).ask(actorFor(asker.id), 'd162a', {
        problemCode: 'd162a-a',
        question: 'Đề bài có tính trường hợp n = 0 không ạ?',
      });

      const after = await monitor.snapshot(organiser, 'd162a');
      expect(after.clarifications.unanswered).toBe(1);
      expect(after.clarifications.latest[0]).toMatchObject({
        askedBy: 'd162a-an',
        problemCode: 'd162a-a',
      });
    });
  }, 180_000);

  it('takes an answered question off the panel, in the round it was answered in', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'd162b-owner');
      const asker = await insertUser(db, 'd162b-an');
      const seeded = await seedContest(db, owner.id, 'd162b');
      await joinLive(db, seeded.contestId, asker.id);

      const { cache } = realCache();
      const monitor = monitorFor(db, cache);
      const clarifications = clarificationsFor(db, cache);
      const organiser = actorFor(owner.id);

      const asked = await clarifications.ask(actorFor(asker.id), 'd162b', {
        problemCode: null,
        question: 'Được dùng thư viện chuẩn không ạ?',
      });

      // The snapshot an organiser is looking at when they decide to answer.
      const waiting = await monitor.snapshot(organiser, 'd162b');
      expect(waiting.clarifications.unanswered).toBe(1);

      await clarifications.answer(organiser, 'd162b', asked.id, {
        answer: 'Có, thư viện chuẩn C++ được phép.',
        visibility: 'public',
      });

      // THE case. Same key, same TTL, no clock moved: without the
      // invalidation the organiser watches their own answer sit in the
      // "nobody has answered these" list for another five seconds, on the
      // screen they opened because the round is running.
      const answered = await monitor.snapshot(organiser, 'd162b');
      expect(answered.clarifications.unanswered).toBe(0);
      expect(answered.clarifications.latest).toHaveLength(0);
    });
  }, 180_000);
});
