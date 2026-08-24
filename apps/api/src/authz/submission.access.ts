import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  contestParticipations,
  contests,
  contestSubmissions,
  problems,
  problemRevisions,
  submissionCases,
  submissions,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import type {
  CreateSubmissionRequestDto,
  SubmissionDetailDto,
  SubmissionListQueryDto,
  SubmissionPageDto,
} from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import type { Actor } from './actor.js';
import { canViewProblem, loadProblemContext } from './problem.visibility.js';
import { resolveContestTarget } from './participation.js';
import { canViewContest, loadContestContext } from './contest.visibility.js';
import { canViewSubmission, loadSubmissionContext, visibleSubmissionsWhere } from './submission.visibility.js';

/**
 * The ONLY module permitted to import `@duckoj/db/guarded` for submissions,
 * exactly as `org.access.ts` is for organizations.
 */
@Injectable()
export class SubmissionAccessService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(actor: Actor, input: CreateSubmissionRequestDto): Promise<{ id: number }> {
    const problem = (
      await this.db
        .select({ id: problems.id, currentRevisionId: problems.currentRevisionId, visibility: problems.visibility })
        .from(problems)
        .where(sql`lower(${problems.code}) = lower(${input.problemCode})`)
        .limit(1)
    )[0];
    // Visibility answers FIRST, and it is the only question 404 answers.
    // "Does not exist" and "not visible to this actor" stay one
    // indistinguishable `problem_not_found` — the same 404-over-403 rule as
    // `getVisible` below — decided by the one shared predicate every problem
    // read path uses, not a private copy of the rule here.
    //
    // "No published revision" is checked only AFTER visibility, and answers a
    // distinct 409: once `canViewProblem` has passed, the problem's existence
    // is already the actor's to know — `GET /problems/{code}` answers 200 for
    // it — so the distinct code discloses nothing. (This used to be folded
    // into `problem_not_found` before the visibility check, on an
    // existence-oracle argument that only holds for problems the actor
    // CANNOT see; for a visible problem it just told the caller a problem
    // they had just read did not exist.)
    if (!problem) {
      throw new AppError(404, 'problem_not_found', 'No such problem.');
    }
    const ctx = await loadProblemContext(this.db, actor, problem.id);
    if (!canViewProblem(actor, problem, ctx)) {
      throw new AppError(404, 'problem_not_found', 'No such problem.');
    }
    if (!problem.currentRevisionId) {
      throw new AppError(409, 'problem_not_submittable', 'This problem has no published tests yet.');
    }

    const language = (
      await this.db
        .select({ id: schema.languages.id, isActive: schema.languages.isActive })
        .from(schema.languages)
        .where(eq(schema.languages.key, input.languageKey))
        .limit(1)
    )[0];
    if (!language?.isActive) {
      throw new AppError(404, 'language_not_found', 'No such language.');
    }

    const revision = (
      await this.db
        .select({
          id: problemRevisions.id,
          packageHash: problemRevisions.packageHash,
          state: problemRevisions.state,
        })
        .from(problemRevisions)
        .where(eq(problemRevisions.id, problem.currentRevisionId))
        .limit(1)
    )[0];
    // A revision that exists but is not published (e.g. mid-republish) is the
    // same client-facing situation as no revision at all: there is nothing
    // gradeable behind this problem code right now. Same answer, too —
    // visibility already passed above, so the 409 discloses nothing.
    if (!revision || revision.state !== 'published') {
      throw new AppError(409, 'problem_not_submittable', 'This problem has no published tests yet.');
    }

    // Resolved BEFORE the transaction opens, and before anything is written.
    // Every failure here — not joined, window shut, problem not in the
    // contest — must leave no submission behind: a competitor who is refused
    // has not used an attempt.
    const target = input.contestKey
      ? await this.resolveContest(actor, input.contestKey, problem.id)
      : null;

    // One transaction: a submission must never exist without a job to grade
    // it, or it would sit at `queued` forever with nothing to move it. The
    // contest row joins it for the same reason — a contest submission that
    // exists outside its contest is invisible to the scoreboard forever.
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

      if (target) {
        // No score is stored: `contest_submissions.points` was dropped in
        // 0010 because nothing read it. The scoreboard rebuilds every score
        // from `submission_cases` as grading writes them, so this row needs
        // only to say which participation and which contest problem — and
        // `judged` needs no contest awareness at all.
        await tx.insert(contestSubmissions).values({
          participationId: target.participationId,
          contestProblemId: target.contestProblemId,
          submissionId: submission!.id,
        });
      }

      return { id: submission!.id };
    });
  }

  /**
   * Resolves `contestKey` to a participation and contest problem, or throws.
   *
   * The contest's own visibility is checked first and answers 404, exactly as
   * `ContestAccessService` does: submitting must not become a way to discover
   * that a private contest exists.
   */
  private async resolveContest(actor: Actor, key: string, problemId: number) {
    const contest = (
      await this.db
        .select({
          id: contests.id,
          key: contests.key,
          visibility: contests.visibility,
          createdBy: contests.createdBy,
          startTime: contests.startTime,
          endTime: contests.endTime,
          timeLimitSeconds: contests.timeLimitSeconds,
        })
        .from(contests)
        .where(sql`lower(${contests.key}) = lower(${key})`)
        .limit(1)
    )[0];
    const notFound = new AppError(404, 'contest_not_found', 'No such contest.');
    if (!contest) throw notFound;
    const ctx = await loadContestContext(this.db, actor, contest);
    if (!canViewContest(actor, contest, ctx)) throw notFound;

    return resolveContestTarget(this.db, contest, actor.userId, problemId, new Date());
  }

  /**
   * Keyset-paginated on `submissions.id`, **descending** — newest first,
   * unlike `ProblemAccessService.listVisible`/`OrgAccessService.listVisible`,
   * which page ascending. That inversion flips the cursor comparison too:
   * ascending pages forward with `gt(id, after)`, defaulting `after` to `0`
   * (a bound that costs nothing, since no real id is ever `<= 0`); descending
   * pages forward with `lt(id, before)`, and there is no equivalently cheap
   * default for "before infinity" — an unbounded upper end is not a sentinel
   * value, it is the *absence* of the condition. `parseCursor` below returns
   * `undefined` for "no cursor", and that `undefined` is threaded through to
   * mean "omit the `lt` condition entirely" rather than coerced into some
   * numeric stand-in for infinity. `nextCursor` is still `items.at(-1).id`
   * exactly as the ascending services compute it — but because rows are
   * sorted descending, that is now the *smallest* id on the page, and the
   * next page resumes strictly below it.
   *
   * The property that matters most here (spec §4.1): this must produce
   * exactly the ids `getVisible` would answer 200 for, one at a time — no
   * more. `visibleSubmissionsWhere` is the SQL twin of the very predicate
   * `getVisible`'s `canViewSubmission` check applies, written clause for
   * clause beside it, so the two cannot silently diverge the way two
   * independently-written copies of the rule could. That mattered when the
   * rule was "yours or admin"; it matters more now that it also turns on a
   * problem's `source_access`, the viewer's roles on that problem, and
   * whether the viewer holds an AC — three facts either form could get
   * subtly wrong on its own.
   *
   * Those three facts arrive as uncorrelated subqueries inside
   * `visibleSubmissionsWhere`, not as a lookup per row: this stays ONE
   * query no matter how large the page or the corpus.
   *
   * `user=` is resolved via a join on `schema.users`, not a separate
   * username-to-id lookup: an unknown username, or a real one that simply
   * has no visible submissions to this actor, both fall out of the same
   * join as "no matching rows" — an empty page, never an error. A 403 for
   * "that user exists but isn't you" would itself be an existence oracle.
   */
  async listVisible(actor: Actor, filters: SubmissionListQueryDto): Promise<SubmissionPageDto> {
    const conditions = [visibleSubmissionsWhere(this.db, actor)];
    if (filters.problem) {
      conditions.push(sql`lower(${problems.code}) = lower(${filters.problem})`);
    }
    if (filters.user) {
      conditions.push(sql`lower(${schema.users.username}) = lower(${filters.user})`);
    }
    if (filters.verdict) {
      conditions.push(eq(submissions.verdict, filters.verdict));
    }
    if (filters.contest) {
      // Submissions made INTO the contest — rows in `contest_submissions` —
      // not practice submissions that merely target its problems. Which of
      // them the caller may actually see is still `visibleSubmissionsWhere`
      // above; this only narrows, so a private contest's key leaks nothing
      // the caller could not already list.
      const inContest = this.db
        .select({ id: contestSubmissions.submissionId })
        .from(contestSubmissions)
        .innerJoin(
          contestParticipations,
          eq(contestParticipations.id, contestSubmissions.participationId),
        )
        .innerJoin(contests, eq(contests.id, contestParticipations.contestId))
        .where(sql`lower(${contests.key}) = lower(${filters.contest})`);
      conditions.push(inArray(submissions.id, inContest));
    }
    const before = parseCursor(filters.cursor);
    if (before !== undefined) {
      conditions.push(lt(submissions.id, before));
    }

    const rows = await this.db
      .select({
        id: submissions.id,
        problemCode: problems.code,
        username: schema.users.username,
        languageKey: schema.languages.key,
        state: submissions.state,
        verdict: submissions.verdict,
        points: submissions.points,
        maxPoints: submissions.maxPoints,
        createdAt: submissions.createdAt,
      })
      .from(submissions)
      .innerJoin(problems, eq(problems.id, submissions.problemId))
      .innerJoin(schema.languages, eq(schema.languages.id, submissions.languageId))
      .innerJoin(schema.users, eq(schema.users.id, submissions.userId))
      .where(and(...conditions))
      .orderBy(desc(submissions.id))
      .limit(filters.limit + 1);

    const items = rows.slice(0, filters.limit).map((row) => ({
      id: row.id,
      problemCode: row.problemCode,
      username: row.username,
      languageKey: row.languageKey,
      state: row.state,
      verdict: row.verdict,
      points: row.points,
      maxPoints: row.maxPoints,
      createdAt: row.createdAt.toISOString(),
    }));
    const nextCursor = rows.length > filters.limit ? String(items.at(-1)!.id) : null;
    return { items, nextCursor };
  }

  /**
   * Visibility is design §2's table — the submitter, an admin, the problem's
   * authors/curators, and (only where the problem set `source_access =
   * 'solved'`) anyone holding an `AC` on it. Every read goes through the one
   * shared predicate rather than a handler's own `where`, so this and
   * `listVisible` cannot answer differently; see `submission.visibility.ts`.
   *
   * `source` is returned on every submission this answers 200 for. That is
   * not a separate rule with its own check (design §2.1): the widened
   * predicate decides whether the *submission* is visible, and the source is
   * part of the submission. A 200 that withheld the source would mean the
   * viewer was allowed to see the submission but not what it was, which is
   * not a state any row of the table describes.
   */
  async getVisible(actor: Actor, id: number): Promise<SubmissionDetailDto> {
    const rows = await this.db
      .select({
        id: submissions.id,
        userId: submissions.userId,
        problemId: submissions.problemId,
        problemCode: problems.code,
        problemSourceAccess: problems.sourceAccess,
        problemVisibility: problems.visibility,
        source: submissions.source,
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
    // itself information we do not disclose. `canViewSubmission` is the same
    // predicate `listVisible` above applies as a `WHERE` clause — see
    // `submission.visibility.ts` for why that sharing is load-bearing, not
    // stylistic.
    if (!row) {
      throw new AppError(404, 'submission_not_found', 'No such submission.');
    }
    // Loaded unconditionally, including for the actor's own row, rather than
    // short-circuited on "is this mine or am I admin?" first. Those two
    // clauses live inside `canViewSubmission`; restating either here to skip
    // two indexed lookups would put half the rule in this file, which is the
    // one thing this predicate's whole shape exists to prevent.
    const ctx = await loadSubmissionContext(this.db, actor, {
      id: row.problemId,
      visibility: row.problemVisibility,
      sourceAccess: row.problemSourceAccess,
    });
    if (!canViewSubmission(actor, row.userId, ctx)) {
      throw new AppError(404, 'submission_not_found', 'No such submission.');
    }

    // `submission_cases` is keyed by (submissionId, attempt, groupIndex,
    // caseIndex): `JobStore.claim` bumps `attempt` on every claim, so a
    // submission whose lease lapsed and was re-claimed has rows for more than
    // one attempt. Filtering on `submissionId` alone — as this used to — mixes
    // a stale attempt's verdicts in with the current one. Restrict to the
    // latest attempt actually present.
    const maxAttemptRows = await this.db
      .select({ max: sql<number | null>`max(${submissionCases.attempt})` })
      .from(submissionCases)
      .where(eq(submissionCases.submissionId, id));
    const maxAttempt = maxAttemptRows[0]?.max ?? null;

    // No case rows yet (still queued, or grading hasn't reported a case):
    // `max()` over zero rows is NULL, which matches nothing — return `[]`
    // directly rather than issuing a second query that can only come back empty.
    const cases =
      maxAttempt === null
        ? []
        : await this.db
            .select({
              groupIndex: submissionCases.groupIndex,
              caseIndex: submissionCases.caseIndex,
              verdict: submissionCases.verdict,
              skipped: submissionCases.skipped,
              timeMs: submissionCases.timeMs,
              memoryKb: submissionCases.memoryKb,
              points: submissionCases.points,
              maxPoints: submissionCases.maxPoints,
              feedback: submissionCases.feedback,
            })
            .from(submissionCases)
            .where(and(eq(submissionCases.submissionId, id), eq(submissionCases.attempt, maxAttempt)))
            .orderBy(
              asc(submissionCases.groupIndex),
              asc(submissionCases.caseIndex),
              asc(submissionCases.attempt),
            );

    return {
      id: row.id,
      problemCode: row.problemCode,
      languageKey: row.languageKey,
      source: row.source,
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

/**
 * The descending-order counterpart of `problem.access.ts`/`org.access.ts`'s
 * `parseCursor`: those default an absent cursor to `0` because `gt(id, 0)`
 * costs nothing (no real id is ever `<= 0`) and return a plain `number`.
 * Descending has no equivalent cheap default for "no upper bound" — `undefined`
 * is the return value for "no cursor", read by `listVisible` as "omit the
 * `lt` condition", not as some numeric stand-in for infinity.
 */
function parseCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined;
  const before = Number(cursor);
  if (!Number.isSafeInteger(before) || before < 0) {
    throw new AppError(422, 'invalid_cursor', 'That page cursor is not valid.');
  }
  return before;
}
