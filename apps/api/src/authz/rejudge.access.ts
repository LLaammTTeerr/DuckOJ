/**
 * Rejudging: putting a submission that has already been graded back in the
 * queue, and doing it for every submission of a problem at once.
 *
 * Lives in `authz/` for the reason every service here does — it reads and
 * writes guarded tables (`submissions`, `submission_cases`), which the repo
 * confines to this directory.
 *
 * **The one design decision worth reading before changing anything:** a
 * rejudge RE-QUEUES the submission's existing `grading_jobs` row (bumping
 * `attempt`) rather than inserting a new one. `SubmissionAccess.create()`
 * inserts a row because none exists yet; here one does, and the difference
 * is the fence. `EventWriter.fencedById` folds `grading_jobs.attempt = <the
 * attempt this packet belongs to>` into the WHERE of every `submissions`
 * UPDATE, keyed on **that job row's id**. Insert a second job row and the
 * old row's `attempt` never moves, so a judge still grinding away on the
 * pre-rejudge attempt keeps passing its own fence and overwrites the
 * rejudge's verdict — the exact failure the sweep's in-statement fence was
 * added to prevent. Bumping the existing row's `attempt` fences that stale
 * attempt the instant the rejudge commits, and `claim()` bumping it again on
 * the next claim is harmless.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  contestParticipations,
  contestSubmissions,
  contests,
  problems,
  problemRevisions,
  submissionCases,
  submissions,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import type { RejudgeProblemResponseDto, RejudgeSubmissionResponseDto } from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import {
  SUBMISSION_PUBLISHER,
  type SubmissionPublisher,
} from '../realtime/submission-publisher.js';
import { isAdmin, type Actor } from './actor.js';
import { RatingService } from './rating.service.js';

/** What one requeue needs: which submission, and which package to grade it with. */
interface RejudgeTarget {
  submissionId: number;
  revisionId: number;
  packageHash: string;
}

@Injectable()
export class RejudgeService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(SUBMISSION_PUBLISHER) private readonly publisher: SubmissionPublisher,
    @Inject(RatingService) private readonly rating: RatingService,
  ) {}

  /**
   * One submission, re-graded against the revision it was already pinned to.
   *
   * Deliberately NOT the problem's current revision — that is what
   * `rejudgeProblem` is for. Rejudging a single submission is the "the judge
   * hiccuped, run it again" operation, and silently moving it onto a
   * different test set would make the two routes differ in a way neither
   * name suggests.
   */
  async rejudgeSubmission(actor: Actor, id: number): Promise<RejudgeSubmissionResponseDto> {
    requireAdmin(actor);
    const [row] = await this.db
      .select({
        id: submissions.id,
        revisionId: submissions.revisionId,
        packageHash: problemRevisions.packageHash,
      })
      .from(submissions)
      .innerJoin(problemRevisions, eq(problemRevisions.id, submissions.revisionId))
      .where(eq(submissions.id, id))
      .limit(1);
    // 404, not 403: admin-ness was already settled above, so this only ever
    // answers "no such submission" — the same code every other read uses.
    if (!row) throw new AppError(404, 'submission_not_found', 'No such submission.');

    const target: RejudgeTarget = {
      submissionId: row.id,
      revisionId: row.revisionId,
      packageHash: row.packageHash,
    };
    const jobIds = await this.db.transaction((tx) => this.requeueAll(tx as Db, [target]));
    const ratedContestKeys = await this.announce([target.submissionId]);
    return { submissionId: target.submissionId, jobId: jobIds[0]!, ratedContestKeys };
  }

  /**
   * Every submission of a problem, newest first, against the problem's
   * CURRENT published revision.
   *
   * "Newest first" is not decoration: it is the order competitors notice.
   * `JobStore.claim` takes the oldest `created_at`, and a re-queued row keeps
   * the `created_at` it was inserted with — which would grade the oldest
   * submission first. `requeueAll` therefore restamps `created_at` in the
   * order it is handed the targets, so the caller's ordering is the grading
   * order.
   */
  async rejudgeProblem(actor: Actor, code: string): Promise<RejudgeProblemResponseDto> {
    requireAdmin(actor);
    const [problem] = await this.db
      .select({ id: problems.id, currentRevisionId: problems.currentRevisionId })
      .from(problems)
      .where(sql`lower(${problems.code}) = lower(${code})`)
      .limit(1);
    if (!problem) throw new AppError(404, 'problem_not_found', 'No such problem.');

    const [revision] = problem.currentRevisionId
      ? await this.db
          .select({ id: problemRevisions.id, packageHash: problemRevisions.packageHash })
          .from(problemRevisions)
          .where(
            and(
              eq(problemRevisions.id, problem.currentRevisionId),
              eq(problemRevisions.state, 'published'),
            ),
          )
          .limit(1)
      : [];
    // The same 409 `POST /submissions` answers for a problem with nothing
    // gradeable behind it. Existence is already the caller's to know (they
    // are an admin), so a distinct code discloses nothing.
    if (!revision) {
      throw new AppError(409, 'problem_not_submittable', 'This problem has no published tests yet.');
    }

    const rows = await this.db
      .select({ id: submissions.id })
      .from(submissions)
      .where(eq(submissions.problemId, problem.id))
      .orderBy(desc(submissions.id));
    if (rows.length === 0) return { submissionsQueued: 0, ratedContestKeys: [] };

    const targets: RejudgeTarget[] = rows.map((row) => ({
      submissionId: row.id,
      revisionId: revision.id,
      packageHash: revision.packageHash,
    }));
    await this.db.transaction((tx) => this.requeueAll(tx as Db, targets));
    const ratedContestKeys = await this.announce(targets.map((target) => target.submissionId));
    return { submissionsQueued: targets.length, ratedContestKeys };
  }

  /**
   * The reset itself, for every target, inside ONE transaction — the same
   * invariant `create()` states: a submission must never be observable in a
   * state no job will move it out of.
   *
   * Returns the re-queued job id per target, positionally.
   */
  private async requeueAll(tx: Db, targets: RejudgeTarget[]): Promise<number[]> {
    const jobIds: number[] = [];
    for (const [index, target] of targets.entries()) {
      await tx
        .update(submissions)
        .set({
          state: 'queued',
          verdict: null,
          points: null,
          maxPoints: null,
          timeMs: null,
          memoryKb: null,
          compileOutput: null,
          judgedAt: null,
          // `submissions.revision_id` is "which tests actually graded it,
          // forever" — so it moves with the rejudge. Leaving it pinned to the
          // old revision while the job grades the new one would make the
          // column a record of something that never happened.
          revisionId: target.revisionId,
        })
        .where(eq(submissions.id, target.submissionId));

      // Deleted rather than left beside the new attempt's rows. Every reader
      // already filters to the latest attempt, so this is not required for
      // correctness — but a rejudge is the one moment where the old verdicts
      // are known to be superseded, and keeping them would grow the table
      // without ever being read again.
      await tx.delete(submissionCases).where(eq(submissionCases.submissionId, target.submissionId));

      // `now()` is the transaction's own start instant, so it is identical
      // for every row here; the microsecond offset is what puts them in the
      // caller's order. Anchoring at `now()` (rather than keeping the old
      // `created_at`) also means a bulk rejudge queues BEHIND every live
      // submission already waiting, which is the right precedence: a
      // competitor waiting on a verdict must not be stuck behind a thousand
      // re-runs of last year's contest.
      const requeued = await tx.execute<{ id: number }>(sql`
        update grading_jobs
           set state       = 'queued',
               attempt     = attempt + 1,
               worker_id   = null,
               lease_until = null,
               revision_id = ${target.revisionId},
               package_hash = ${target.packageHash},
               created_at  = now() + ${sql.raw(String(index))} * interval '1 microsecond'
         where submission_id = ${target.submissionId}
        returning id
      `);
      if (requeued.length > 0) {
        jobIds.push(Number(requeued[0]!.id));
        continue;
      }
      // No job row at all. `create()` always writes one, so this is only
      // reachable for a submission whose job was deleted out of band — but
      // "queued with nothing to grade it" is precisely the state this whole
      // method exists to avoid, so it is repaired rather than reported.
      const [inserted] = await tx
        .insert(schema.gradingJobs)
        .values({
          submissionId: target.submissionId,
          revisionId: target.revisionId,
          packageHash: target.packageHash,
        })
        .returning({ id: schema.gradingJobs.id });
      jobIds.push(inserted!.id);
    }
    return jobIds;
  }

  /**
   * Wake open pages, then name every RATED contest these submissions count
   * towards — without touching ratings.
   *
   * D4 says regrading changes rating history, and D5 says rating is applied
   * manually. The two meet here: the only moment this code runs is the
   * *queueing*, when the case rows have just been deleted and every rejudged
   * score is zero. A `replayAll()` here would fold those zeros into every
   * later rating and nothing would re-fold when grading actually finished
   * (the judged worker has no rating service). So the rejudge reports which
   * rated contests are affected and the admin re-rates them once the queue
   * drains (`POST /admin/contests/{key}/rate`, which replays). Ruled D21.
   *
   * `publish` runs strictly AFTER the requeue transaction commits: it is not
   * transactional (see `SubmissionEvents`).
   */
  private async announce(submissionIds: number[]): Promise<string[]> {
    for (const submissionId of submissionIds) {
      await this.publisher.publish(submissionId);
    }
    return this.ratedContestKeys(submissionIds);
  }

  private async ratedContestKeys(submissionIds: number[]): Promise<string[]> {
    if (submissionIds.length === 0) return [];
    const rows = await this.db
      .selectDistinct({ key: contests.key })
      .from(contestSubmissions)
      .innerJoin(
        contestParticipations,
        eq(contestParticipations.id, contestSubmissions.participationId),
      )
      .innerJoin(contests, eq(contests.id, contestParticipations.contestId))
      .where(
        and(
          eq(contests.isRated, true),
          inArray(contestSubmissions.submissionId, submissionIds),
        ),
      )
      .orderBy(contests.key);
    return rows.map((row) => row.key);
  }
}

/**
 * Admin-only, enforced here rather than by a decorator — exactly as
 * `AdminUsersService` and `RatingService` do it, so the controller carries no
 * authorization logic of its own. 403 rather than 404: the caller is asking
 * to act on the whole system, not to read one row, and there is no existence
 * to conceal in "are you an administrator?".
 */
function requireAdmin(actor: Actor): void {
  if (!isAdmin(actor)) {
    throw new AppError(403, 'admin_forbidden', 'Only an admin may rejudge.');
  }
}
