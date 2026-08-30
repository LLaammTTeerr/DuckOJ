import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
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
import { RateLimiter } from '../common/rate-limiter.js';
import type { Actor } from './actor.js';
import { canViewProblem, loadProblemContext } from './problem.visibility.js';
import { resolveContestTarget } from './participation.js';
import { canViewContest, loadContestContext } from './contest.visibility.js';
import { canViewSubmission, loadSubmissionContext, visibleSubmissionsWhere } from './submission.visibility.js';
import {
  frozenSubmissionsWhere,
  isContestSourceHidden,
  isSubmissionFrozen,
  loadSubmissionFreezeContext,
  maskFrozenDetail,
  maskFrozenSummary,
  maskHiddenSource,
} from './submission.freeze.js';

/**
 * The `contest_submissions ⋈ contest_participations ⋈ contests` chain that
 * answers "which contest was this submission made INTO", attached as a LEFT
 * JOIN to both read paths so a list row and a detail page cannot disagree.
 *
 * Aliased, not used bare: `listVisible`'s `contest=` filter builds a
 * subquery over these same three tables, and an unaliased outer join would
 * put two `contests` in one statement — legal SQL (the inner one shadows),
 * but a shadowing that only has to be read wrong once.
 *
 * A LEFT JOIN is safe against row fan-out here because
 * `contest_submissions_submission_idx` is UNIQUE on `submission_id`: at most
 * one contest row per submission, so the page size — and the keyset cursor
 * computed from it — is untouched.
 *
 * No contest-visibility predicate of its own, matching the `contest` filter
 * exactly: the key rides along on rows `visibleSubmissionsWhere` has already
 * admitted.
 */
const contestLink = alias(contestSubmissions, 'link_contest_submissions');
const contestLinkParticipation = alias(contestParticipations, 'link_contest_participations');
const contestLinkContest = alias(contests, 'link_contests');

/**
 * The submission meter (D80). Two windows, checked together, counted under
 * one purpose against one key — the user id.
 *
 * **One every ten seconds** is the burst bound. It is not about volume: it is
 * about the double-clicked button and the script in a loop, both of which
 * enqueue a container and a compile per press. Ten seconds is longer than any
 * human means to wait between two *different* solutions and shorter than any
 * human notices after a rejected one.
 *
 * **Twenty in ten minutes** is the sustained bound, and it is the one set from
 * a measurement rather than a judgement. B12's soak recorded 35.3 verdicts a
 * minute out of one judge against `tong-hai-so`, with the queue reaching 23 and
 * a p95 time-to-verdict of 39 s (`load/RESULTS.md`). Two a minute per person
 * means eighteen contestants can submit continuously before one judge is the
 * constraint, which is well past what a room does: a contestant who submits
 * twenty times in ten minutes is debugging against the judge, and the twenty-
 * first attempt is worth ten seconds of thinking.
 *
 * The number that must NOT break is the burst after a failed test — a room
 * re-submitting a fix. That is one submission per person, not twenty, and it
 * meets neither bound.
 */
export const SUBMISSION_PURPOSE = 'submission';
export const SUBMISSION_BURST_LIMIT = 1;
export const SUBMISSION_BURST_WINDOW_MS = 10_000;
export const SUBMISSION_SUSTAINED_LIMIT = 20;
export const SUBMISSION_SUSTAINED_WINDOW_MS = 600_000;

/**
 * The ONLY module permitted to import `@duckoj/db/guarded` for submissions,
 * exactly as `org.access.ts` is for organizations.
 */
@Injectable()
export class SubmissionAccessService {
  private readonly limiter: RateLimiter;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RateLimiter) limiter?: RateLimiter,
    ) {
    // Defaulted rather than required so the dozens of specs that construct
    // this service by hand keep doing so — and they get the REAL limiter, not
    // a bypass, which is the point: a test that submits repeatedly as one
    // person is a test of behaviour this meter now changes, and it should be
    // the one to say so.
    this.limiter = limiter ?? new RateLimiter(db);
  }

  /**
   * How long until this actor may submit again, or `null` when they may now
   * (D80).
   *
   * Both windows are asked, even when the first already refuses, so the
   * `Retry-After` is the honest one: a caller who has spent both budgets must
   * not be told ten seconds when the real answer is nine minutes, or they will
   * come back nine times to be refused again.
   *
   * `retryAfterSeconds` + `record`, never `allow` — login's split, for
   * login's reason turned around. `allow` records the attempt it refuses, so
   * with a limit of ONE a double-clicked button would extend its own cooldown
   * every time it was refused, and a contestant leaning on the key would never
   * be allowed to submit at all. Here the window is spent by a submission that
   * was actually created, and a refusal costs nothing.
   */
  private async submissionRetryAfter(actor: Actor): Promise<number | null> {
    const key = meterKeyFor(actor);
    const burst = await this.limiter.retryAfterSeconds(
      SUBMISSION_PURPOSE,
      key,
      SUBMISSION_BURST_LIMIT,
      SUBMISSION_BURST_WINDOW_MS,
    );
    const sustained = await this.limiter.retryAfterSeconds(
      SUBMISSION_PURPOSE,
      key,
      SUBMISSION_SUSTAINED_LIMIT,
      SUBMISSION_SUSTAINED_WINDOW_MS,
    );
    if (burst === null && sustained === null) return null;
    return Math.max(burst ?? 0, sustained ?? 0);
  }

  async create(actor: Actor, input: CreateSubmissionRequestDto): Promise<{ id: number }> {
    // FIRST, before a single row is read: a refused caller must cost this
    // process nothing, which is D26's rule for `register` and the reason the
    // check there runs ahead of the hash. It also means the 429 is answered
    // without consulting the problem at all, so it can leak nothing about one.
    //
    // No exemption for organisers or admins (D80). The cost being metered is
    // a grading container, and a container costs the same whoever enqueued it
    // — an admin looping on `/submissions` starves a contest exactly as a
    // contestant would. Anyone who genuinely needs to grade in bulk has
    // `POST /admin/rejudge`, which is metered as its own thing.
    const retryAfter = await this.submissionRetryAfter(actor);
    if (retryAfter !== null) {
      throw new AppError(
        429,
        'submission_rate_limited',
        'You are submitting too quickly. Wait a moment and try again.',
        undefined,
        { 'Retry-After': String(retryAfter) },
      );
    }

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

    // The window is spent HERE — after every refusal above and before
    // anything is written (D80). After validation, so a mistyped problem code
    // does not cost a contestant ten seconds of cooldown for a submission the
    // judge never saw; before the transaction, so a failure to record cannot
    // leave a created submission that this meter never counted.
    //
    // `SUBMISSION_SUSTAINED_WINDOW_MS`, never the burst window: `record`
    // deletes this key's rows older than the window it is handed, so passing
    // ten seconds would sweep away the very rows the twenty-in-ten-minutes
    // count is made of, and the sustained bound would silently never fire.
    await this.limiter.record(SUBMISSION_PURPOSE, meterKeyFor(actor), SUBMISSION_SUSTAINED_WINDOW_MS);

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
    // One clock for the whole page: two rows of the same contest must not land
    // on opposite sides of a freeze instant that ticked past between them.
    const now = new Date();
    const frozen = frozenSubmissionsWhere(actor, now);
    const conditions = [visibleSubmissionsWhere(this.db, actor)];
    if (filters.problem) {
      conditions.push(sql`lower(${problems.code}) = lower(${filters.problem})`);
    }
    if (filters.user) {
      conditions.push(sql`lower(${schema.users.username}) = lower(${filters.user})`);
    }
    if (filters.verdict) {
      conditions.push(eq(submissions.verdict, filters.verdict));
      // The one place the freeze *filters* rather than masks (D23). A verdict
      // filter is a question about the verdict, and a masked row that still
      // answered it would hand the whole hidden verdict back in nine probes —
      // the mask below would be decorative. Excluded here, in SQL, rather than
      // dropped from `items` afterwards: `nextCursor` is `items.at(-1).id`,
      // so a page thinned after the fact skips rows on the next one.
      conditions.push(sql`not ${frozen}`);
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
        contestKey: contestLinkContest.key,
        contestLabel: contestLinkContest.name,
        createdAt: submissions.createdAt,
        // The SQL form of the freeze predicate, as a computed column. The
        // list cannot use the row form: it would need this submission's
        // participation, one query per row.
        frozen,
      })
      .from(submissions)
      .innerJoin(problems, eq(problems.id, submissions.problemId))
      .innerJoin(schema.languages, eq(schema.languages.id, submissions.languageId))
      .innerJoin(schema.users, eq(schema.users.id, submissions.userId))
      .leftJoin(contestLink, eq(contestLink.submissionId, submissions.id))
      .leftJoin(contestLinkParticipation, eq(contestLinkParticipation.id, contestLink.participationId))
      .leftJoin(contestLinkContest, eq(contestLinkContest.id, contestLinkParticipation.contestId))
      .where(and(...conditions))
      .orderBy(desc(submissions.id))
      .limit(filters.limit + 1);

    const items = rows.slice(0, filters.limit).map((row) => {
      const item = {
        id: row.id,
        problemCode: row.problemCode,
        username: row.username,
        languageKey: row.languageKey,
        state: row.state,
        verdict: row.verdict,
        points: row.points,
        maxPoints: row.maxPoints,
        contestKey: row.contestKey,
        contestLabel: row.contestLabel,
        createdAt: row.createdAt.toISOString(),
        frozen: false,
      };
      return row.frozen ? maskFrozenSummary(item) : item;
    });
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
   * `source` rides along on every submission this answers 200 for, with ONE
   * exception (D27): a submission whose contest participation window is still
   * open serves `source: null, sourceHidden: true` to everyone but its
   * submitter, the contest's creator and a global admin. That is a contest
   * rule, not a `source_access` rule — `source_access = 'solved'` decides who
   * may read a practice solution, and reading a rival's solution *during a
   * contest* is a different question it was never asked.
   *
   * Everywhere else the original reasoning stands (design §2.1): the widened
   * predicate decides whether the *submission* is visible, and the source is
   * part of the submission.
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
        contestKey: contestLinkContest.key,
        contestLabel: contestLinkContest.name,
        createdAt: submissions.createdAt,
        judgedAt: submissions.judgedAt,
      })
      .from(submissions)
      .innerJoin(problems, eq(problems.id, submissions.problemId))
      .innerJoin(schema.languages, eq(schema.languages.id, submissions.languageId))
      .leftJoin(contestLink, eq(contestLink.submissionId, submissions.id))
      .leftJoin(contestLinkParticipation, eq(contestLinkParticipation.id, contestLink.participationId))
      .leftJoin(contestLinkContest, eq(contestLinkContest.id, contestLinkParticipation.contestId))
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

    // The freeze (D23), applied last, over a fully-built response. Building
    // the masked shape by NOT fetching would put half of "what a freeze
    // hides" in this method's control flow; masking a finished DTO keeps the
    // whole answer in one place, beside the SQL form the list uses.
    const detail: SubmissionDetailDto = {
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
      contestKey: row.contestKey,
      contestLabel: row.contestLabel,
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
      frozen: false,
      sourceHidden: false,
    };

    // One context, one clock, two independent contest rules (D23 and D27).
    // Reading the clock twice could put the two masks on opposite sides of a
    // participation end that ticked between them.
    const now = new Date();
    const freezeCtx = await loadSubmissionFreezeContext(this.db, id);
    const shown = isContestSourceHidden(actor, row, freezeCtx, now)
      ? maskHiddenSource(detail)
      : detail;
    return isSubmissionFrozen(actor, row, freezeCtx, now) ? maskFrozenDetail(shown) : shown;
  }
}

/**
 * The submission meter's key: the USER, never the session, the token or the
 * IP (D80).
 *
 * The session is wrong because signing out and in again would buy a fresh
 * budget. The token is wrong because `POST /auth/tokens` mints them freely, so
 * the meter would bound how fast one token can submit and nothing else. The IP
 * is wrong in the direction that matters most here: a school computer room is
 * one address, and metering it would refuse thirty pupils for the actions of
 * one — the exact failure D16 pairs its per-IP window with a per-identifier one
 * to avoid, and there is no second window to pair with here because there is
 * only ever one identity behind an authenticated submission.
 */
function meterKeyFor(actor: Actor): string {
  return `user:${String(actor.userId)}`;
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
