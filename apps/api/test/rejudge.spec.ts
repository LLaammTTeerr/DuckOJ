/**
 * Rejudging, end to end against a real database — including the one property
 * the find-and-fix sweep's in-statement fence exists to hold: a stale attempt
 * that is still writing when a rejudge lands must not overwrite it.
 *
 * `JobStore` and `EventWriter` are imported from `apps/judged/src` by relative
 * path rather than through a package edge. That is deliberate: this test spans
 * both processes (the API queues, the judge claims and writes), and the
 * alternative — a `@duckoj/judged` dependency on `@duckoj/api` — would put
 * judged's source and dev-dependencies into the API's image for the sake of one
 * spec file (`dockerfile-manifest.spec.ts` derives the image's COPY manifest
 * from exactly that graph). Node and TypeScript both resolve judged's own
 * imports relative to judged's directory, so nothing else is needed;
 * `tsconfig.test.json` widens `rootDir` to `apps/` so the typechecker allows
 * the reach across.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { asc, eq } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import {
  contestParticipations,
  contestProblems,
  contestSubmissions,
  contests,
  problems,
  submissionCases,
  submissions,
} from '@duckoj/db/guarded';
import { JobStore } from '../../judged/src/job-store.js';
import { EventWriter } from '../../judged/src/event-writer.js';
import type { SubmissionEvents } from '../../judged/src/submission-events.js';
import { RejudgeService } from '../src/authz/rejudge.access.js';
import { SUBMISSION_PUBLISHER, type SubmissionPublisher } from '../src/realtime/submission-publisher.js';
import type { Actor } from '../src/authz/actor.js';
import { RatingService } from '../src/authz/rating.service.js';
import { ContestAccessService } from '../src/authz/contest.access.js';
import { uncachedScoreboards } from './scoreboard.fixtures.js';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import {
  insertGradedSubmission,
  insertUser,
  registerAndLogin,
  seedProblemAndLanguage,
  publishNextRevision,
  userIdOf,
} from './submissions.fixtures.js';

/** Records what was published instead of dialling Redis. */
class RecordingPublisher implements SubmissionPublisher {
  readonly published: number[] = [];
  async publish(submissionId: number): Promise<void> {
    this.published.push(submissionId);
  }
}

function adminActor(userId: number): Actor {
  return { userId, globalRole: 'admin', via: 'session', scopes: [] };
}

function serviceFor(db: Db, publisher: SubmissionPublisher = new RecordingPublisher()): RejudgeService {
  return new RejudgeService(
    db,
    publisher,
    new RatingService(db, new ContestAccessService(db, uncachedScoreboards())),
    uncachedScoreboards(),
  );
}

/** The `grading_jobs` row for a submission — the fencing token lives here. */
async function jobRow(db: Db, submissionId: number) {
  const [row] = await db
    .select()
    .from(schema.gradingJobs)
    .where(eq(schema.gradingJobs.submissionId, submissionId));
  return row!;
}

describe('rejudging one submission', () => {
  it(
    're-queues the SAME job row, and the stale attempt cannot overwrite the rejudge',
    async () => {
      await withTestDb(async (db) => {
        await seedProblemAndLanguage(db);
        const [problem] = await db
          .select({ id: problems.id, currentRevisionId: problems.currentRevisionId })
          .from(problems);
        const admin = await insertUser(db, 'rj-admin', 'admin');
        const competitor = await insertUser(db, 'rj-competitor');
        const submissionId = await insertGradedSubmission(db, {
          userId: competitor.id,
          problemId: problem!.id,
        });

        const jobs = new JobStore(db);
        await jobs.enqueue({
          revisionId: problem!.currentRevisionId!,
          packageHash: 'phase1-aplusb',
          submissionId,
        });

        // A judge claims it and starts grading: attempt 1, leased.
        const stale = (await jobs.claim('worker-a'))!;
        expect(stale.submissionId).toBe(submissionId);

        // The admin rejudges while that attempt is still in flight.
        const result = await serviceFor(db).rejudgeSubmission(adminActor(admin.id), submissionId);
        expect(result.submissionId).toBe(submissionId);
        // The SAME row, re-queued — not a second job racing the first.
        expect(result.jobId).toBe(stale.id);
        const requeued = await jobRow(db, submissionId);
        expect(requeued.state).toBe('queued');
        expect(requeued.attempt).toBe(stale.attempt + 1);

        // A worker picks the rejudge up.
        const fresh = (await jobs.claim('worker-b'))!;
        expect(fresh.id).toBe(stale.id);
        expect(fresh.submissionId).toBe(submissionId);

        // The stale attempt finally reports. It must change nothing.
        // `SubmissionEvents` carries a private `redis`, so a structural
        // stand-in cannot satisfy it; what matters here is that nothing is
        // published, not how the publisher is built.
        const events = { publish: async (): Promise<void> => undefined } as unknown as SubmissionEvents;
        const writer = new EventWriter(db, jobs, events);
        const applied = await writer.apply(stale, {
          type: 'finished',
          verdict: 'WA',
          points: 0,
          maxPoints: 100,
          timeMs: 9,
          memoryKb: 9,
        });
        expect(applied).toBe(false);
        const [afterStale] = await db
          .select({ verdict: submissions.verdict, state: submissions.state })
          .from(submissions)
          .where(eq(submissions.id, submissionId));
        expect([afterStale!.verdict, afterStale!.state]).toEqual([null, 'queued']);

        // The rejudge's own attempt lands.
        expect(
          await writer.apply(fresh, {
            type: 'finished',
            verdict: 'AC',
            points: 100,
            maxPoints: 100,
            timeMs: 5,
            memoryKb: 5,
          }),
        ).toBe(true);
        const [afterFresh] = await db
          .select({ verdict: submissions.verdict, points: submissions.points })
          .from(submissions)
          .where(eq(submissions.id, submissionId));
        expect([afterFresh!.verdict, afterFresh!.points]).toEqual(['AC', 100]);
      });
    },
    120_000,
  );

  it('clears the verdict and the case rows', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const [problem] = await db.select({ id: problems.id }).from(problems);
      const admin = await insertUser(db, 'rj2-admin', 'admin');
      const competitor = await insertUser(db, 'rj2-competitor');
      const submissionId = await insertGradedSubmission(db, {
        userId: competitor.id,
        problemId: problem!.id,
        verdict: 'AC',
        points: 100,
        maxPoints: 100,
      });
      await db.insert(submissionCases).values({
        submissionId,
        attempt: 1,
        groupIndex: 0,
        caseIndex: 0,
        verdict: 'AC',
        timeMs: 1,
        memoryKb: 1,
        points: 100,
        maxPoints: 100,
      });

      await serviceFor(db).rejudgeSubmission(adminActor(admin.id), submissionId);

      const [row] = await db
        .select()
        .from(submissions)
        .where(eq(submissions.id, submissionId));
      expect(row!.state).toBe('queued');
      expect([row!.verdict, row!.points, row!.maxPoints, row!.judgedAt]).toEqual([
        null,
        null,
        null,
        null,
      ]);
      const cases = await db
        .select()
        .from(submissionCases)
        .where(eq(submissionCases.submissionId, submissionId));
      expect(cases).toEqual([]);
    });
  }, 120_000);

  it('publishes the submission on the realtime channel', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const [problem] = await db.select({ id: problems.id }).from(problems);
      const admin = await insertUser(db, 'rj3-admin', 'admin');
      const competitor = await insertUser(db, 'rj3-competitor');
      const submissionId = await insertGradedSubmission(db, {
        userId: competitor.id,
        problemId: problem!.id,
      });

      const publisher = new RecordingPublisher();
      await serviceFor(db, publisher).rejudgeSubmission(adminActor(admin.id), submissionId);
      expect(publisher.published).toEqual([submissionId]);
    });
  }, 120_000);

  it('refuses a non-admin with 403 admin_forbidden, and 404s an unknown submission', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const [problem] = await db.select({ id: problems.id }).from(problems);
      const admin = await insertUser(db, 'rj4-admin', 'admin');
      const plain = await insertUser(db, 'rj4-plain');
      const submissionId = await insertGradedSubmission(db, {
        userId: plain.id,
        problemId: problem!.id,
      });
      const service = serviceFor(db);

      await expect(
        service.rejudgeSubmission(
          { userId: plain.id, globalRole: 'user', via: 'session', scopes: [] },
          submissionId,
        ),
      ).rejects.toMatchObject({ status: 403, code: 'admin_forbidden' });
      await expect(
        service.rejudgeSubmission(adminActor(admin.id), submissionId + 9999),
      ).rejects.toMatchObject({ status: 404, code: 'submission_not_found' });
    });
  }, 120_000);
});

describe('rejudging a whole problem', () => {
  it('queues every submission newest first, against the current published revision', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const [problem] = await db
        .select({ id: problems.id, currentRevisionId: problems.currentRevisionId })
        .from(problems);
      const admin = await insertUser(db, 'rp-admin', 'admin');
      const competitor = await insertUser(db, 'rp-competitor');

      const ids: number[] = [];
      for (let i = 0; i < 3; i++) {
        const id = await insertGradedSubmission(db, {
          userId: competitor.id,
          problemId: problem!.id,
          verdict: 'WA',
          points: 0,
          maxPoints: 100,
        });
        await db.insert(schema.gradingJobs).values({
          submissionId: id,
          revisionId: problem!.currentRevisionId!,
          packageHash: 'phase1-aplusb',
        });
        ids.push(id);
      }

      // A second revision is published AFTER those submissions were graded:
      // the rejudge must move onto it, not re-run the retired test set.
      const newRevisionId = await publishNextRevision(db, problem!.id, 'aplusb');

      const result = await serviceFor(db).rejudgeProblem(adminActor(admin.id), 'APLUSB');
      expect(result).toEqual({ submissionsQueued: 3, ratedContestKeys: [] });

      const jobs = await db
        .select({
          submissionId: schema.gradingJobs.submissionId,
          revisionId: schema.gradingJobs.revisionId,
          packageHash: schema.gradingJobs.packageHash,
          state: schema.gradingJobs.state,
        })
        .from(schema.gradingJobs)
        .orderBy(asc(schema.gradingJobs.createdAt), asc(schema.gradingJobs.id));

      // Claim order is `created_at` ascending, so this list IS the grading
      // order: newest submission first.
      expect(jobs.map((job) => job.submissionId)).toEqual([...ids].reverse());
      for (const job of jobs) {
        expect(job.state).toBe('queued');
        expect(job.revisionId).toBe(newRevisionId);
        expect(job.packageHash).toBe('pkg-aplusb-v2');
      }
      // `submissions.revision_id` records which tests actually graded it.
      const rows = await db
        .select({ revisionId: submissions.revisionId })
        .from(submissions)
        .where(eq(submissions.problemId, problem!.id));
      expect(rows.map((row) => row.revisionId)).toEqual(rows.map(() => newRevisionId));
    });
  }, 120_000);

  it('404s an unknown problem and 409s one with no published revision', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const admin = await insertUser(db, 'rp2-admin', 'admin');
      const owner = await insertUser(db, 'rp2-owner');
      await db
        .insert(problems)
        .values({ code: 'draft', name: 'Draft', statement: 's', createdBy: owner.id });
      const service = serviceFor(db);

      await expect(service.rejudgeProblem(adminActor(admin.id), 'nope')).rejects.toMatchObject({
        status: 404,
        code: 'problem_not_found',
      });
      await expect(service.rejudgeProblem(adminActor(admin.id), 'draft')).rejects.toMatchObject({
        status: 409,
        code: 'problem_not_submittable',
      });
    });
  }, 120_000);
});

describe('the rejudge routes', () => {
  it('202s for an admin session, 403s a plain user, and refuses a token outright', async () => {
    await withTestDb(async (db) => {
      const publisher = new RecordingPublisher();
      const app = await buildApp(db, {
        overrides: [{ provide: SUBMISSION_PUBLISHER, useValue: publisher }],
      });
      try {
        await seedProblemAndLanguage(db);
        const [problem] = await db.select({ id: problems.id }).from(problems);

        const adminAgent = request.agent(app.getHttpServer());
        await registerAndLogin(adminAgent, 'rt-admin');
        await db
          .update(schema.users)
          .set({ globalRole: 'admin' })
          .where(eq(schema.users.username, 'rt-admin'));
        const plainAgent = request.agent(app.getHttpServer());
        await registerAndLogin(plainAgent, 'rt-plain');

        const submissionId = await insertGradedSubmission(db, {
          userId: await userIdOf(db, 'rt-plain'),
          problemId: problem!.id,
        });

        const ok = await adminAgent.post(`/api/v1/admin/submissions/${String(submissionId)}/rejudge`).send({});
        expect(ok.status).toBe(202);
        expect(ok.body).toEqual({ submissionId, jobId: expect.any(Number), ratedContestKeys: [] });
        expect(publisher.published).toEqual([submissionId]);

        const denied = await plainAgent
          .post(`/api/v1/admin/submissions/${String(submissionId)}/rejudge`)
          .send({});
        expect([denied.status, denied.body.code]).toEqual([403, 'admin_forbidden']);

        const missing = await adminAgent.post('/api/v1/admin/submissions/999999/rejudge').send({});
        expect([missing.status, missing.body.code]).toEqual([404, 'submission_not_found']);

        const problemWide = await adminAgent.post('/api/v1/admin/problems/aplusb/rejudge').send({});
        expect(problemWide.status).toBe(202);
        expect(problemWide.body).toEqual({ submissionsQueued: 1, ratedContestKeys: [] });

        // Session-only: an access token minted by the admin gets nowhere.
        const minted = await adminAgent
          .post('/api/v1/auth/tokens')
          .send({ name: 'probe', scopes: ['submissions:write'] });
        const token = (minted.body as { token: string }).token;
        const viaToken = await request(app.getHttpServer())
          .post(`/api/v1/admin/submissions/${String(submissionId)}/rejudge`)
          .set('Authorization', `Bearer ${token}`)
          .send({});
        expect([viaToken.status, viaToken.body.code]).toEqual([403, 'session_required']);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('a rejudge names the rated contests it touches, and never replays ratings itself (D4, D21)', () => {
  it('returns the rated contest keys and leaves replayAll uncalled', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const [problem] = await db
        .select({ id: problems.id, currentRevisionId: problems.currentRevisionId })
        .from(problems);
      const admin = await insertUser(db, 'rr-admin', 'admin');
      const competitor = await insertUser(db, 'rr-competitor');
      const submissionId = await insertGradedSubmission(db, {
        userId: competitor.id,
        problemId: problem!.id,
      });
      await db.insert(schema.gradingJobs).values({
        submissionId,
        revisionId: problem!.currentRevisionId!,
        packageHash: 'phase1-aplusb',
      });

      const rating = new RatingService(db, new ContestAccessService(db, uncachedScoreboards()));
      let replays = 0;
      rating.replayAll = async (): Promise<number> => {
        replays += 1;
        return 0;
      };
      const service = new RejudgeService(
        db,
        new RecordingPublisher(),
        rating,
        uncachedScoreboards(),
      );

      // Not in any contest yet.
      const first = await service.rejudgeSubmission(adminActor(admin.id), submissionId);
      expect(first.ratedContestKeys).toEqual([]);
      expect(replays).toBe(0);

      const now = new Date();
      const [contest] = await db
        .insert(contests)
        .values({
          key: 'rr-open',
          name: 'Rated Open',
          startTime: new Date(now.getTime() - 7_200_000),
          endTime: new Date(now.getTime() - 3_600_000),
          format: 'default',
          isRated: true,
          createdBy: admin.id,
        })
        .returning({ id: contests.id });
      const [participation] = await db
        .insert(contestParticipations)
        .values({
          contestId: contest!.id,
          userId: competitor.id,
          virtual: 0,
          startTime: new Date(now.getTime() - 7_200_000),
        })
        .returning({ id: contestParticipations.id });
      const [contestProblem] = await db
        .insert(contestProblems)
        .values({ contestId: contest!.id, problemId: problem!.id, label: 'A', points: 100, order: 0 })
        .returning({ id: contestProblems.id });
      await db.insert(contestSubmissions).values({
        participationId: participation!.id,
        contestProblemId: contestProblem!.id,
        submissionId,
      });

      const second = await service.rejudgeSubmission(adminActor(admin.id), submissionId);
      expect(second.ratedContestKeys).toEqual(['rr-open']);
      // The scores are zero at this moment; folding them would corrupt every
      // later rating, and nothing re-folds when grading finishes. Never here.
      expect(replays).toBe(0);
      const whole = await service.rejudgeProblem(adminActor(admin.id), 'aplusb');
      expect(whole.ratedContestKeys).toEqual(['rr-open']);
      expect(replays).toBe(0);
    });
  }, 120_000);
});
