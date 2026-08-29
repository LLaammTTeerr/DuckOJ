/**
 * The freeze window applied to individual submissions (D23).
 *
 * D22 froze the *scoreboard* by filtering; every other route still served the
 * late verdicts the board was hiding (`p1c-freeze-report.md`, "Concerns").
 * This is the other half: `GET /submissions` and `GET /submissions/{id}` mask
 * a frozen row instead of dropping it, so the row's existence stays public and
 * its outcome does not.
 *
 * No clock is injected. Every contest is seeded relative to `Date.now()`, so
 * the wall clock lands wherever the scenario wants it — the same convention
 * `contest-freeze.spec.ts` established one layer up.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import {
  contestParticipations,
  contestProblems,
  contestSubmissions,
  contests,
  submissionCases,
  submissions,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { SubmissionDetail, SubmissionPage } from '@duckoj/contracts';
import { ContestAccessService } from '../src/authz/contest.access.js';
import { uncachedScoreboards } from './scoreboard.fixtures.js';
import { SubmissionAccessService } from '../src/authz/submission.access.js';
import {
  frozenSubmissionsWhere,
  isSubmissionFrozen,
  loadSubmissionFreezeContext,
} from '../src/authz/submission.freeze.js';
import type { Actor } from '../src/authz/actor.js';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import {
  grantProblemRole,
  insertUser,
  registerAndLogin,
  seedProblemAndLanguage,
  seedProblemWithSourceAccess,
  userIdOf,
} from './submissions.fixtures.js';

const MINUTE = 60_000;

function actorFor(userId: number, globalRole: Actor['globalRole'] = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

interface SeedOptions {
  key: string;
  /** The contest's `end_time`, relative to `Date.now()`. */
  contestEndInMs: number;
  /** `end_time - start_time`. Default one hour. */
  durationMs?: number;
  /** `frozen_last_minutes`. Default 20. */
  frozenLastMinutes?: number;
  /** The participation's `virtual`. Default 0 (live). */
  virtual?: number;
  /** `contest_participations.start_time`, relative to now. Default: the contest's start. */
  participationStartInMs?: number;
  /** `time_limit_seconds`. Default null. */
  timeLimitSeconds?: number | null;
  /** When each of alice's submissions was made, relative to now. */
  submissionOffsetsInMs: number[];
}

interface Seeded {
  key: string;
  contestId: number;
  problemId: number;
  aliceId: number;
  organizerId: number;
  /** One id per entry of `submissionOffsetsInMs`, in the same order. */
  submissionIds: number[];
}

/**
 * One contest, one problem, one participant (`alice`) with a graded AC per
 * requested offset. Everything is inserted directly: joining and submitting
 * through HTTP cannot produce a submission dated in the past, and the whole
 * point of these fixtures is where a submission sits relative to the freeze.
 */
async function seedFreezeContest(db: Db, opts: SeedOptions): Promise<Seeded> {
  const duration = opts.durationMs ?? 60 * MINUTE;
  const endMs = Date.now() + opts.contestEndInMs;
  const startMs = endMs - duration;

  const organizer = await insertUser(db, `${opts.key}-org`);
  const alice = await insertUser(db, `${opts.key}-alice`);
  const problem = await seedProblemWithSourceAccess(db, { code: `${opts.key}-p` });

  const [contest] = await db
    .insert(contests)
    .values({
      key: opts.key,
      name: opts.key,
      startTime: new Date(startMs),
      endTime: new Date(endMs),
      format: 'default',
      pointsPrecision: 3,
      frozenLastMinutes: opts.frozenLastMinutes ?? 20,
      timeLimitSeconds: opts.timeLimitSeconds ?? null,
      visibility: 'public',
      createdBy: organizer.id,
    })
    .returning({ id: contests.id });

  const [contestProblem] = await db
    .insert(contestProblems)
    .values({
      contestId: contest!.id,
      problemId: problem.id,
      label: 'A',
      points: 100,
      partial: false,
      order: 0,
    })
    .returning({ id: contestProblems.id });

  const participationStartMs =
    opts.participationStartInMs === undefined ? startMs : Date.now() + opts.participationStartInMs;
  const [participation] = await db
    .insert(contestParticipations)
    .values({
      contestId: contest!.id,
      userId: alice.id,
      startTime: new Date(participationStartMs),
      virtual: opts.virtual ?? 0,
    })
    .returning({ id: contestParticipations.id });

  const [language] = await db
    .select({ id: schema.languages.id })
    .from(schema.languages)
    .where(eq(schema.languages.key, 'cpp17'));

  const submissionIds: number[] = [];
  for (const offset of opts.submissionOffsetsInMs) {
    const at = new Date(Date.now() + offset);
    const [row] = await db
      .insert(submissions)
      .values({
        userId: alice.id,
        problemId: problem.id,
        revisionId: problem.revisionId,
        languageId: language!.id,
        source: `int main(){} // ${String(offset)}`,
        state: 'done',
        verdict: 'AC',
        points: 100,
        maxPoints: 100,
        timeMs: 42,
        memoryKb: 4096,
        compileOutput: 'warning: unused variable',
        createdAt: at,
        judgedAt: at,
      })
      .returning({ id: submissions.id });
    await db.insert(submissionCases).values({
      submissionId: row!.id,
      attempt: 1,
      groupIndex: 0,
      caseIndex: 1,
      verdict: 'AC',
      timeMs: 42,
      memoryKb: 4096,
      points: 100,
      maxPoints: 100,
    });
    await db.insert(contestSubmissions).values({
      participationId: participation!.id,
      contestProblemId: contestProblem!.id,
      submissionId: row!.id,
    });
    submissionIds.push(row!.id);
  }

  return {
    key: opts.key,
    contestId: contest!.id,
    problemId: problem.id,
    aliceId: alice.id,
    organizerId: organizer.id,
    submissionIds,
  };
}

/**
 * A viewer who may read alice's submissions without running the contest — the
 * only kind of viewer for whom the mask is reachable at all. `curator` rather
 * than an AC-holder on a `source_access = 'solved'` problem: both reach the
 * same predicate, and this one needs no second submission to set up.
 */
async function curatorAgent(
  app: Awaited<ReturnType<typeof buildApp>>,
  db: Db,
  name: string,
  problemId: number,
) {
  const agent = request.agent(app.getHttpServer());
  await registerAndLogin(agent, name);
  await grantProblemRole(db, problemId, await userIdOf(db, name), 'curator');
  return agent;
}

/** The freeze window is open: `now` sits 10 minutes before a 20-minute freeze's end. */
const INSIDE = { contestEndInMs: 10 * MINUTE, submissionOffsetsInMs: [-30 * MINUTE, -5 * MINUTE] };

describe("a submission inside its contest's freeze window", () => {
  it('masks the verdict, points, timing and cases for a non-privileged viewer, on both routes', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const seeded = await seedFreezeContest(db, { key: 'sf1', ...INSIDE });
      const [early, late] = seeded.submissionIds as [number, number];
      const app = await buildApp(db);
      try {
        const viewer = await curatorAgent(app, db, 'sf1-curator', seeded.problemId);

        const detail = await viewer.get(`/submissions/${late}`);
        expect(detail.status).toBe(200);
        expect(detail.body.frozen).toBe(true);
        expect(detail.body.verdict).toBeNull();
        expect(detail.body.points).toBeNull();
        expect(detail.body.timeMs).toBeNull();
        expect(detail.body.memoryKb).toBeNull();
        expect(detail.body.compileOutput).toBeNull();
        expect(detail.body.cases).toEqual([]);
        // Existence, and the fact that grading finished, stay public — the
        // freeze hides the outcome, not the attempt.
        expect(detail.body.state).toBe('done');
        expect(() => SubmissionDetail.parse(detail.body)).not.toThrow();

        const list = await viewer.get('/submissions');
        expect(list.status).toBe(200);
        const rows = list.body.items as { id: number; frozen: boolean; verdict: string | null }[];
        expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([early, late]);
        const lateRow = rows.find((r) => r.id === late)!;
        expect(lateRow.frozen).toBe(true);
        expect(lateRow.verdict).toBeNull();
        expect(() => SubmissionPage.parse(list.body)).not.toThrow();

        // The submission made BEFORE the freeze instant is untouched: the
        // window is a window, not a switch on the whole contest.
        const earlyRow = rows.find((r) => r.id === early)!;
        expect(earlyRow.frozen).toBe(false);
        expect(earlyRow.verdict).toBe('AC');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it("never masks the submitter's own row", async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const seeded = await seedFreezeContest(db, { key: 'sf2', ...INSIDE });
      const late = seeded.submissionIds[1]!;
      const service = new SubmissionAccessService(db);

      const detail = await service.getVisible(actorFor(seeded.aliceId), late);

      expect(detail.frozen).toBe(false);
      expect(detail.verdict).toBe('AC');
      expect(detail.cases).toHaveLength(1);
    });
  }, 120_000);

  it('never masks a global admin', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const seeded = await seedFreezeContest(db, { key: 'sf3', ...INSIDE });
      const late = seeded.submissionIds[1]!;
      const admin = await insertUser(db, 'sf3-admin', 'admin');
      const service = new SubmissionAccessService(db);

      const detail = await service.getVisible(actorFor(admin.id, 'admin'), late);
      const page = await service.listVisible(actorFor(admin.id, 'admin'), { limit: 50 });

      expect(detail.frozen).toBe(false);
      expect(detail.verdict).toBe('AC');
      expect(page.items.every((item) => item.frozen === false)).toBe(true);
      expect(page.items.every((item) => item.verdict === 'AC')).toBe(true);
    });
  }, 120_000);

  it("never masks the contest's creator", async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const seeded = await seedFreezeContest(db, { key: 'sf4', ...INSIDE });
      const late = seeded.submissionIds[1]!;
      // The organiser is not a member of the problem, so give them the one
      // grant that lets them read the submission at all; the mask must still
      // stand down because they RUN the contest.
      await grantProblemRole(db, seeded.problemId, seeded.organizerId, 'curator');
      const service = new SubmissionAccessService(db);

      const detail = await service.getVisible(actorFor(seeded.organizerId), late);

      expect(detail.frozen).toBe(false);
      expect(detail.verdict).toBe('AC');
    });
  }, 120_000);

  it('reveals everything once the participation has ended', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      // Ended five minutes ago: past the freeze instant AND past the end.
      const seeded = await seedFreezeContest(db, {
        key: 'sf5',
        contestEndInMs: -5 * MINUTE,
        submissionOffsetsInMs: [-40 * MINUTE, -15 * MINUTE],
      });
      const late = seeded.submissionIds[1]!;
      const app = await buildApp(db);
      try {
        const viewer = await curatorAgent(app, db, 'sf5-curator', seeded.problemId);

        const detail = await viewer.get(`/submissions/${late}`);

        expect(detail.status).toBe(200);
        expect(detail.body.frozen).toBe(false);
        expect(detail.body.verdict).toBe('AC');
        expect(detail.body.timeMs).toBe(42);
        expect(detail.body.cases).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('leaves a practice submission — one attached to no contest — alone', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const owner = await insertUser(db, 'sf6-owner');
      const problem = await seedProblemWithSourceAccess(db, { code: 'sf6-p' });
      const [language] = await db
        .select({ id: schema.languages.id })
        .from(schema.languages)
        .where(eq(schema.languages.key, 'cpp17'));
      const [row] = await db
        .insert(submissions)
        .values({
          userId: owner.id,
          problemId: problem.id,
          revisionId: problem.revisionId,
          languageId: language!.id,
          source: 'x',
          state: 'done',
          verdict: 'WA',
        })
        .returning({ id: submissions.id });
      const curator = await insertUser(db, 'sf6-curator');
      await grantProblemRole(db, problem.id, curator.id, 'curator');
      const service = new SubmissionAccessService(db);

      const detail = await service.getVisible(actorFor(curator.id), row!.id);

      expect(detail.frozen).toBe(false);
      expect(detail.verdict).toBe('WA');
    });
  }, 120_000);

  it("keeps a virtual entrant frozen past the contest's own end_time (D22's per-participation clause)", async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      // The contest ended ten minutes ago; this virtual attempt started 50
      // minutes ago and runs the contest's full hour, so its own window
      // closes ten minutes from now and its freeze opened ten minutes ago.
      const seeded = await seedFreezeContest(db, {
        key: 'sf7',
        contestEndInMs: -10 * MINUTE,
        virtual: 1,
        participationStartInMs: -50 * MINUTE,
        submissionOffsetsInMs: [-30 * MINUTE, -5 * MINUTE],
      });
      const [early, late] = seeded.submissionIds as [number, number];
      const curator = await insertUser(db, 'sf7-curator');
      await grantProblemRole(db, seeded.problemId, curator.id, 'curator');
      const service = new SubmissionAccessService(db);

      expect((await service.getVisible(actorFor(curator.id), late)).frozen).toBe(true);
      expect((await service.getVisible(actorFor(curator.id), early)).frozen).toBe(false);
    });
  }, 120_000);
});

describe('GET /contests/{key}/me', () => {
  it('has nothing to mask: it answers with the window, never with an outcome', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const seeded = await seedFreezeContest(db, { key: 'sfme', ...INSIDE });
      const service = new ContestAccessService(db, uncachedScoreboards());

      const me = await service.myParticipation(actorFor(seeded.aliceId), seeded.key);

      // D23's scope ruling, pinned rather than asserted in prose: this route
      // returns ONE participation — the caller's own — and not one field of
      // it describes a verdict, a score or a submission. The day a field like
      // that is added, this test says so before the freeze quietly stops
      // covering the route.
      expect(Object.keys(me).sort()).toEqual([
        'contestKey',
        'endTime',
        'id',
        'isDisqualified',
        'startTime',
        'virtual',
      ]);
    });
  }, 120_000);
});

describe('the verdict filter is not a way around the mask', () => {
  it('drops a frozen row from a verdict-filtered page, and returns it once the window closes', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const open = await seedFreezeContest(db, { key: 'sf8', ...INSIDE });
      const closed = await seedFreezeContest(db, {
        key: 'sf9',
        contestEndInMs: -5 * MINUTE,
        submissionOffsetsInMs: [-40 * MINUTE, -15 * MINUTE],
      });
      const curator = await insertUser(db, 'sf8-curator');
      await grantProblemRole(db, open.problemId, curator.id, 'curator');
      await grantProblemRole(db, closed.problemId, curator.id, 'curator');
      const service = new SubmissionAccessService(db);

      const page = await service.listVisible(actorFor(curator.id), { limit: 50, verdict: 'AC' });
      const ids = page.items.map((item) => item.id);

      // Without this the mask is theatre: nine `?verdict=` probes read the
      // verdict straight off which page the row appears on.
      expect(ids).not.toContain(open.submissionIds[1]);
      expect(ids).toContain(open.submissionIds[0]);
      expect(ids).toContain(closed.submissionIds[0]);
      expect(ids).toContain(closed.submissionIds[1]);
    });
  }, 120_000);
});

describe('the two forms of the freeze predicate agree', () => {
  it('marks the same submissions frozen in SQL as in TypeScript, over every participation shape', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const shapes: SeedOptions[] = [
        // live, no time limit, inside the window
        { key: 'ag1', ...INSIDE },
        // live, no time limit, window closed
        {
          key: 'ag2',
          contestEndInMs: -5 * MINUTE,
          submissionOffsetsInMs: [-40 * MINUTE, -15 * MINUTE],
        },
        // live, time-limited: the participation ends before the contest does
        {
          key: 'ag3',
          contestEndInMs: 120 * MINUTE,
          durationMs: 180 * MINUTE,
          timeLimitSeconds: 60 * 60,
          participationStartInMs: -50 * MINUTE,
          submissionOffsetsInMs: [-30 * MINUTE, -5 * MINUTE],
        },
        // virtual, no time limit: the window is shifted by its own start
        {
          key: 'ag4',
          contestEndInMs: -10 * MINUTE,
          virtual: 1,
          participationStartInMs: -50 * MINUTE,
          submissionOffsetsInMs: [-30 * MINUTE, -5 * MINUTE],
        },
        // virtual, time-limited
        {
          key: 'ag5',
          contestEndInMs: -10 * MINUTE,
          virtual: 2,
          timeLimitSeconds: 60 * 60,
          participationStartInMs: -50 * MINUTE,
          submissionOffsetsInMs: [-30 * MINUTE, -5 * MINUTE],
        },
        // spectating: the window is the contest's, never the entrant's
        {
          key: 'ag6',
          contestEndInMs: 10 * MINUTE,
          virtual: -1,
          participationStartInMs: -50 * MINUTE,
          submissionOffsetsInMs: [-30 * MINUTE, -5 * MINUTE],
        },
        // no freeze window at all
        {
          key: 'ag7',
          contestEndInMs: 10 * MINUTE,
          frozenLastMinutes: 0,
          submissionOffsetsInMs: [-5 * MINUTE],
        },
      ];
      const viewer = await insertUser(db, 'ag-viewer');
      const all: number[] = [];
      for (const shape of shapes) {
        const seeded = await seedFreezeContest(db, shape);
        await grantProblemRole(db, seeded.problemId, viewer.id, 'curator');
        all.push(...seeded.submissionIds);
      }

      const actor = actorFor(viewer.id);
      const now = new Date();
      const sqlRows = await db
        .select({ id: submissions.id, frozen: frozenSubmissionsWhere(actor, now) })
        .from(submissions);
      const bySql = new Map(sqlRows.map((row) => [row.id, row.frozen]));

      const byTs = new Map<number, boolean>();
      for (const id of all) {
        const [row] = await db
          .select({ userId: submissions.userId, createdAt: submissions.createdAt })
          .from(submissions)
          .where(eq(submissions.id, id));
        const ctx = await loadSubmissionFreezeContext(db, id);
        byTs.set(id, isSubmissionFrozen(actor, row!, ctx, now));
      }

      // Not merely "both non-empty": at least one of each answer, or a
      // predicate stuck on `false` would agree with itself perfectly.
      expect([...byTs.values()].filter(Boolean).length).toBeGreaterThan(0);
      expect([...byTs.values()].filter((v) => !v).length).toBeGreaterThan(0);
      for (const id of all) {
        expect([id, bySql.get(id)]).toEqual([id, byTs.get(id)]);
      }
    });
  }, 180_000);
});

/** A guard on the fixture itself: the seeded cases really are there to hide. */
describe('the freeze fixture', () => {
  it('stores a case row per seeded submission', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const seeded = await seedFreezeContest(db, { key: 'sfx', ...INSIDE });
      const rows = await db
        .select({ id: submissionCases.id })
        .from(submissionCases)
        .where(
          and(
            eq(submissionCases.submissionId, seeded.submissionIds[1]!),
            eq(submissionCases.attempt, 1),
          ),
        );
      expect(rows).toHaveLength(1);
    });
  }, 120_000);
});
