import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { problems, problemRevisions, submissionCases, submissions } from '@qhhoj/db/guarded';
import { schema, type Db } from '@qhhoj/db';
import type { CreateSubmissionRequestDto, SubmissionDetailDto } from '@qhhoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import { isAdmin, type Actor } from './actor.js';

/**
 * The ONLY module permitted to import `@qhhoj/db/guarded` for submissions,
 * exactly as `org.access.ts` is for organizations.
 */
@Injectable()
export class SubmissionAccessService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(actor: Actor, input: CreateSubmissionRequestDto): Promise<{ id: number }> {
    const problem = (
      await this.db
        .select({ id: problems.id, currentRevisionId: problems.currentRevisionId })
        .from(problems)
        .where(sql`lower(${problems.code}) = lower(${input.problemCode})`)
        .limit(1)
    )[0];
    if (!problem?.currentRevisionId) {
      throw new AppError(404, 'problem_not_found', 'No such problem.');
    }

    const language = (
      await this.db
        .select({ id: schema.languages.id })
        .from(schema.languages)
        .where(eq(schema.languages.key, input.languageKey))
        .limit(1)
    )[0];
    if (!language) {
      throw new AppError(404, 'language_not_found', 'No such language.');
    }

    const revision = (
      await this.db
        .select({ id: problemRevisions.id, packageHash: problemRevisions.packageHash })
        .from(problemRevisions)
        .where(eq(problemRevisions.id, problem.currentRevisionId))
        .limit(1)
    )[0];
    if (!revision) {
      throw new AppError(404, 'problem_not_found', 'No such problem.');
    }

    // One transaction: a submission must never exist without a job to grade
    // it, or it would sit at `queued` forever with nothing to move it.
    return this.db.transaction(async (tx) => {
      const [submission] = await tx
        .insert(submissions)
        .values({
          userId: actor.userId,
          problemId: problem.id,
          // Pinned: this records which tests actually graded it, forever.
          revisionId: revision.id,
          languageId: language.id,
          source: input.source,
        })
        .returning({ id: submissions.id });

      await tx.insert(schema.gradingJobs).values({
        submissionId: submission!.id,
        revisionId: revision.id,
        packageHash: revision.packageHash,
      });

      return { id: submission!.id };
    });
  }

  /**
   * Phase 1 visibility is simply "your own submissions". Phase 4 extends this
   * with contest rules and per-problem source visibility — which is why every
   * read goes through here rather than through a handler's own `where`.
   */
  async getVisible(actor: Actor, id: number): Promise<SubmissionDetailDto> {
    const rows = await this.db
      .select({
        id: submissions.id,
        userId: submissions.userId,
        problemCode: problems.code,
        languageKey: schema.languages.key,
        state: submissions.state,
        verdict: submissions.verdict,
        points: submissions.points,
        maxPoints: submissions.maxPoints,
        timeMs: submissions.timeMs,
        memoryKb: submissions.memoryKb,
        compileOutput: submissions.compileOutput,
        createdAt: submissions.createdAt,
        judgedAt: submissions.judgedAt,
      })
      .from(submissions)
      .innerJoin(problems, eq(problems.id, submissions.problemId))
      .innerJoin(schema.languages, eq(schema.languages.id, submissions.languageId))
      .where(eq(submissions.id, id))
      .limit(1);

    const row = rows[0];
    // 404 rather than 403: that another user's submission exists at this id is
    // itself information we do not disclose.
    if (!row || (row.userId !== actor.userId && !isAdmin(actor))) {
      throw new AppError(404, 'submission_not_found', 'No such submission.');
    }

    const cases = await this.db
      .select()
      .from(submissionCases)
      .where(eq(submissionCases.submissionId, id))
      .orderBy(asc(submissionCases.groupIndex), asc(submissionCases.caseIndex));

    return {
      id: row.id,
      problemCode: row.problemCode,
      languageKey: row.languageKey,
      state: row.state,
      verdict: row.verdict,
      points: row.points,
      maxPoints: row.maxPoints,
      timeMs: row.timeMs,
      memoryKb: row.memoryKb,
      compileOutput: row.compileOutput,
      cases: cases.map((c) => ({
        groupIndex: c.groupIndex,
        caseIndex: c.caseIndex,
        verdict: c.verdict,
        skipped: c.skipped,
        timeMs: c.timeMs,
        memoryKb: c.memoryKb,
        points: c.points,
        maxPoints: c.maxPoints,
        feedback: c.feedback,
      })),
      createdAt: row.createdAt.toISOString(),
      judgedAt: row.judgedAt ? row.judgedAt.toISOString() : null,
    };
  }
}
