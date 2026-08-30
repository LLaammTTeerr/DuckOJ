import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, max, sql } from 'drizzle-orm';
import {
  contestOrgs,
  contestParticipations,
  contestProblems,
  contestSubmissions,
  contests,
  organizations,
  problemRevisions,
  problems,
  submissionCases,
  submissions,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { CONTEST_FORMATS, computeContestScoreboard } from '@duckoj/contest-formats';
import type { Scoreboard } from '@duckoj/contest-formats';
import type {
  ContestParticipationDto,
  ContestDetailDto,
  ContestOrgDto,
  ContestPageDto,
  ContestProblemInputDto,
  ContestSummaryDto,
  ContestVisibilityDto,
  PaginationQueryDto,
} from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import { isAdmin, type Actor } from './actor.js';
import {
  canCreateContest,
  canViewContest,
  loadContestContext,
  visibleContestsWhere,
} from './contest.visibility.js';
import { mapContest, type ContestCaseRow, type ContestSubmissionRow } from './contest.mapping.js';
import {
  listParticipations,
  participationWindow,
  type ContestWindowRow,
  type ParticipationRow,
} from './participation.js';
import { loadOrgAdminships } from './org.visibility.js';
import {
  ScoreboardCache,
  scoreboardCacheKey,
  scoreboardCacheKeys,
  type ScoreboardCacheContest,
  type ScoreboardCacheState,
} from './scoreboard.cache.js';
import { canViewProblem, loadProblemContext } from './problem.visibility.js';
import {
  bookletToTypst,
  statementSection,
  type StatementLang,
} from '../statements/markdown-to-typst.js';

const UNIQUE_VIOLATION = '23505';
const CONTEST_KEY_CONSTRAINT = 'contests_key_lower_idx';
const NOT_FOUND = new AppError(404, 'contest_not_found', 'No such contest.');

/**
 * The PATCH body, as the service reads it. `Partial` is not enough on its
 * own: `formatConfig` and `timeLimitSeconds` are nullable columns, so
 * "absent" and "explicitly null" must stay distinguishable — see `hasKey`.
 */
export interface UpdateContestInput {
  name?: string | undefined;
  startTime?: string | undefined;
  endTime?: string | undefined;
  format?: string | undefined;
  formatConfig?: Record<string, unknown> | null | undefined;
  pointsPrecision?: number | undefined;
  frozenLastMinutes?: number | undefined;
  timeLimitSeconds?: number | null | undefined;
  visibility?: ContestVisibilityDto | undefined;
  /** Present replaces the whole set; absent keeps it (D56). */
  orgSlugs?: string[] | undefined;
  problems?: ContestProblemInputDto[] | undefined;
}

export interface CreateContestInput {
  key: string;
  name: string;
  startTime: string;
  endTime: string;
  format: string;
  formatConfig?: Record<string, unknown> | null | undefined;
  pointsPrecision?: number | undefined;
  frozenLastMinutes?: number | undefined;
  timeLimitSeconds?: number | null | undefined;
  visibility?: ContestVisibilityDto | undefined;
  orgSlugs?: string[] | undefined;
  problems?: ContestProblemInputDto[] | undefined;
}

/** `ContestParticipation.LIVE`. Named so the three uses below read as one rule. */
const LIVE_VIRTUAL = 0;

/** A `contests` row as `select()` returns it — what the scoreboard needs. */
type ContestRow = typeof contests.$inferSelect;

/**
 * The one service permitted to reach the contest tables, exactly as
 * `ProblemAccessService` is for problems.
 *
 * Reads answer 404 — never 403 — for a contest the actor may not see, and the
 * decision is `canViewContest`, which is `canViewVisible`, which is the same
 * function `canViewProblem` calls. There is one visibility predicate in this
 * codebase (design §5).
 */
@Injectable()
export class ContestAccessService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ScoreboardCache) private readonly scoreboards: ScoreboardCache,
  ) {}

  async listVisible(
    actor: Actor | null,
    page: Pick<PaginationQueryDto, 'limit'> & { cursor?: string | undefined; org?: string | undefined },
  ): Promise<ContestPageDto> {
    const after = parseCursor(page.cursor);
    // `?org=` (D56). A slug naming nothing — or an organization this caller
    // may not see — answers an EMPTY page rather than 404: the filter must
    // not become the existence oracle `GET /orgs/{slug}` is careful not to
    // be. Visibility is unchanged by it, so the page still shows only
    // contests the caller could have reached without the filter.
    const restrictedTo =
      page.org === undefined
        ? undefined
        : inArray(
            contests.id,
            this.db
              .select({ contestId: contestOrgs.contestId })
              .from(contestOrgs)
              .innerJoin(organizations, eq(organizations.id, contestOrgs.orgId))
              .where(sql`lower(${organizations.slug}) = lower(${page.org})`),
          );
    const rows = await this.db
      .select()
      .from(contests)
      .where(and(visibleContestsWhere(this.db, actor), gt(contests.id, after), restrictedTo))
      .orderBy(asc(contests.id))
      .limit(page.limit + 1);

    const kept = rows.slice(0, page.limit);
    // ONE query for the whole page, never one per row: a 50-contest page
    // would otherwise be 51 round trips to render a badge.
    const orgsByContest = await this.loadOrgs(kept.map((row) => row.id));
    const items = kept.map((row) => toSummary(row, orgsByContest.get(row.id) ?? []));
    const nextCursor = rows.length > page.limit ? String(items.at(-1)!.id) : null;
    return { items, nextCursor };
  }

  /**
   * Which organizations each of these contests is restricted to, slug and
   * name, ordered by slug so two reads of the same contest print the badges
   * in the same order.
   */
  private async loadOrgs(contestIds: number[]): Promise<Map<number, ContestOrgDto[]>> {
    const byContest = new Map<number, ContestOrgDto[]>();
    if (contestIds.length === 0) return byContest;
    const rows = await this.db
      .select({
        contestId: contestOrgs.contestId,
        slug: organizations.slug,
        name: organizations.name,
      })
      .from(contestOrgs)
      .innerJoin(organizations, eq(organizations.id, contestOrgs.orgId))
      .where(inArray(contestOrgs.contestId, contestIds))
      .orderBy(asc(organizations.slug));
    for (const row of rows) {
      const list = byContest.get(row.contestId) ?? [];
      list.push({ slug: row.slug, name: row.name });
      byContest.set(row.contestId, list);
    }
    return byContest;
  }

  async getVisible(actor: Actor | null, key: string): Promise<ContestDetailDto> {
    const contest = await this.loadVisible(actor, key);
    // Before the start, the problem list is CONCEALED from everyone but the
    // people who run the contest: a private problem attached to a
    // tomorrow-starting public contest must not leak its code and name today
    // through this route while `GET /problems/{code}` 404s the same caller —
    // the exact side channel `resolveProblemIds`' comment forbids. Post-start,
    // every contest viewer sees the problems (participants need them, and the
    // joined-contest grant opens the problems themselves anyway).
    //
    // "Runs it", not "is an admin", as the sweep first wrote it. The creator
    // chose these problems and passed `resolveProblemIds`' visibility check
    // for every one of them, so there is nothing here they do not already
    // know — and concealing them broke the edit screen concretely: the form
    // prefills from this response, so a creator editing an unstarted contest
    // was shown an empty problem list and would have saved it back over the
    // real one.
    // The restriction is NOT concealed pre-start, unlike the problem list:
    // "only these schools may enter" is the fact a reader needs BEFORE the
    // contest opens, and it names organizations, never problems.
    const orgs = (await this.loadOrgs([contest.id])).get(contest.id) ?? [];
    if (new Date() < contest.startTime && !canRunContest(actor, contest)) {
      return {
        ...toSummary(contest, orgs),
        formatConfig: contest.formatConfig as Record<string, unknown> | null,
        canEdit: canRunContest(actor, contest),
        problems: [],
      };
    }
    const problemRows = await this.loadProblemRows(contest.id);
    return {
      ...toSummary(contest, orgs),
      formatConfig: contest.formatConfig as Record<string, unknown> | null,
      canEdit: canRunContest(actor, contest),
      problems: problemRows.map((row) => ({
        code: row.code,
        name: row.name,
        label: row.label,
        points: row.points,
        partial: row.partial,
        order: row.order,
      })),
    };
  }

  /**
   * The scoreboard, computed by the contest's own format from rows in this
   * database. Everything interesting is in `mapContest`; this only fetches, in
   * the orders that mapping documents as load-bearing.
   */
  async getScoreboard(actor: Actor | null, key: string): Promise<Scoreboard> {
    return (await this.getScoreboardCached(actor, key)).board;
  }

  /**
   * The same board, plus where it came from — the only thing that knows, and
   * the only reason `ContestsController` needs a second method.
   *
   * `cache` reaches the client as `X-Scoreboard-Cache` and **never** as a
   * body field: the body is the goldens' snake_case shape, pinned byte for
   * byte by 23 of them, and a cache is transport metadata rather than
   * something the contest format has an opinion about.
   */
  async getScoreboardCached(
    actor: Actor | null,
    key: string,
  ): Promise<{ board: Scoreboard; cache: ScoreboardCacheState }> {
    const contest = await this.loadVisible(actor, key);
    // ONE clock for the whole request. It decides the 409 below, which cache
    // key this read lands on, and what the fold freezes against; reading it
    // twice could put a board folded on one side of a freeze boundary under a
    // key naming the other, and leave it there for a whole TTL.
    const now = new Date();
    const privileged = canRunContest(actor, contest);
    // Same pre-start concealment as `getVisible`, and the same widening: a
    // scoreboard's `problems` and `label_by_problem` carry codes and names,
    // and before the start there is nothing ranked to show anyway. 409,
    // mirroring `join`'s existing `contest_not_started`.
    // `scoreboardForSystem` (the rating replay) deliberately bypasses this —
    // it is not acting for a caller.
    if (now < contest.startTime && !privileged) {
      throw new AppError(409, 'contest_not_started', 'This contest has not started yet.');
    }
    // The freeze window, D22. `now` is what the formats judge it against, and
    // **omitting it means "no freeze"** — so the people who run the contest
    // get the live board by being handed no clock at all, rather than by a
    // second code path that could drift from this one.
    //
    // The cache (D25) wraps exactly this, and nothing else: `scoreboardForSystem`
    // stays uncached on purpose — a rating replay folding a board up to two
    // seconds stale into everybody's rating is the failure D22 was designed
    // against, and the cache must not reintroduce it by a side door.
    const { value, cache } = await this.scoreboards.through(
      scoreboardCacheKey(contest, privileged, now),
      () => this.computeScoreboard(contest, privileged ? undefined : now),
    );
    return { board: value, cache };
  }

  /**
   * The whole contest as one typst document (D48) — the source the booklet
   * route compiles, and the string its cache key is derived from.
   *
   * **Visibility is exactly the contest's problem LIST**, not the
   * scoreboard's: `getVisible` conceals the problems pre-start from everyone
   * but the people who run the contest, and this conceals the whole booklet
   * the same way. It answers 404 rather than the scoreboard's 409
   * `contest_not_started`: an empty booklet is not a thing to render, and a
   * distinct code here would say "this contest exists and starts later",
   * which is exactly what the concealment withholds. D22's freeze has no
   * bearing on a statement.
   *
   * Returns the document rather than a PDF because the caller caches on its
   * hash: the statement text lives on `problems`, not on a revision, so
   * "the revision set" is not enough to notice an edited statement. Hashing
   * what is actually about to be typeset is.
   */
  async getBookletDocument(
    actor: Actor | null,
    key: string,
    lang: StatementLang,
  ): Promise<{ contestId: number; document: string }> {
    const contest = await this.loadVisible(actor, key);
    if (new Date() < contest.startTime && !canRunContest(actor, contest)) throw NOT_FOUND;
    const rows = await this.loadBookletRows(contest.id);
    return {
      contestId: contest.id,
      document: bookletToTypst({
        name: contest.name,
        startTime: contest.startTime,
        endTime: contest.endTime,
        lang,
        problems: rows.map((row) => ({
          label: row.label,
          name: row.name,
          statement: statementSection(row.statement, lang),
          timeMs: row.revisionId === null ? null : row.timeMs,
          memoryKb: row.revisionId === null ? null : row.memoryKb,
        })),
      }),
    };
  }

  /**
   * The booklet's rows: the same order as `loadProblemRows`, plus the
   * statement text and the published revision's limits.
   *
   * A query of its own, deliberately, rather than three columns added to
   * `loadProblemRows`: that one runs inside every scoreboard fold, which
   * D25 exists to keep cheap, and dragging a statement per problem through
   * the hot path of the most-hit endpoint in the app to serve a PDF nobody
   * asked for is the regression that cache was built against.
   */
  private async loadBookletRows(contestId: number) {
    return this.db
      .select({
        name: problems.name,
        statement: problems.statement,
        label: contestProblems.label,
        revisionId: problemRevisions.id,
        timeMs: problemRevisions.timeMs,
        memoryKb: problemRevisions.memoryKb,
      })
      .from(contestProblems)
      .innerJoin(problems, eq(problems.id, contestProblems.problemId))
      .leftJoin(
        problemRevisions,
        and(
          eq(problems.currentRevisionId, problemRevisions.id),
          eq(problemRevisions.state, 'published'),
        ),
      )
      .where(eq(contestProblems.contestId, contestId))
      .orderBy(asc(contestProblems.order), asc(contestProblems.id));
  }

  /**
   * Drop every cached board for these contests. Called after a write that
   * changes what the board says — a disqualification, an edit, a rejudge.
   *
   * Best-effort by construction: the 2 s TTL is the floor, so a delete that
   * does not land costs a moment of staleness rather than a wrong board
   * forever. A verdict arriving from `judged` rides that TTL alone — the
   * event writer is a separate process that never calls into the API.
   */
  async invalidateScoreboards(...contestRows: ScoreboardCacheContest[]): Promise<void> {
    const keys = new Set(contestRows.flatMap((contest) => scoreboardCacheKeys(contest)));
    await this.scoreboards.invalidate([...keys]);
  }

  /**
   * The scoreboard of a contest already resolved, with **no visibility check**.
   *
   * For system work that is not acting on behalf of a caller — today, the
   * rating replay, which folds over every rated contest regardless of who may
   * see it. Deliberately takes a row rather than a key, so it cannot be reached
   * with user input by mistake, and deliberately named so that calling it from
   * a request path looks wrong.
   */
  async scoreboardForSystem(contestId: number): Promise<Scoreboard> {
    const contest = (
      await this.db.select().from(contests).where(eq(contests.id, contestId)).limit(1)
    )[0];
    if (!contest) throw NOT_FOUND;
    return this.computeScoreboard(contest);
  }

  /**
   * @param now The instant the freeze window is judged against, or `undefined`
   *   for the live board. `scoreboardForSystem` passes nothing: a rating
   *   replay that ran during a freeze would fold hidden scores as zeros.
   */
  private async computeScoreboard(contest: ContestRow, now?: Date): Promise<Scoreboard> {
    const [problemRows, participationRows] = await Promise.all([
      this.loadProblemRows(contest.id),
      this.db
        .select({
          id: contestParticipations.id,
          username: schema.users.username,
          startTime: contestParticipations.startTime,
          virtual: contestParticipations.virtual,
          isDisqualified: contestParticipations.isDisqualified,
        })
        .from(contestParticipations)
        .innerJoin(schema.users, eq(schema.users.id, contestParticipations.userId))
        .where(eq(contestParticipations.contestId, contest.id))
        .orderBy(asc(contestParticipations.id)),
    ]);

    // An `ioi16` problem with no published revision has no dataset, and
    // `points_scaling_factor` divides by the dataset's total. 4b throws for
    // it; a bare throw would surface as a 500, so it is named here instead.
    if (contest.format === 'ioi16') {
      // `null` (no published revision) and `0` (an all-zero dataset) are the
      // same unusable state here: `points_scaling_factor` divides by this
      // total, and 0 would make it Infinity and every score NaN.
      const missing = problemRows.find((row) => !row.datasetTotalPoints);
      if (missing) {
        throw new AppError(
          409,
          'contest_problem_missing_dataset',
          `Problem "${missing.code}" has no published revision, so this ioi16 contest cannot ` +
            'scale its points.',
        );
      }
    }

    const submissionRows = await this.loadSubmissionRows(contest.id);

    return computeContestScoreboard(
      mapContest({
        contest: {
          key: contest.key,
          name: contest.name,
          startTime: contest.startTime,
          endTime: contest.endTime,
          format: contest.format,
          formatConfig: contest.formatConfig as Record<string, unknown> | null,
          pointsPrecision: contest.pointsPrecision,
          frozenLastMinutes: contest.frozenLastMinutes,
          timeLimitSeconds: contest.timeLimitSeconds,
        },
        problems: problemRows,
        participations: participationRows,
        submissions: submissionRows,
      }),
      'duckoj',
      now?.toISOString(),
    );
  }

  /**
   * Creates a contest, its org shares and its problems in one transaction.
   *
   * Two refusals are the point of this method: a format the registry does not
   * know (design §6), and a freeze window that is not shorter than the contest
   * (D22). Both are rejected *before* anything is written — a contest that
   * stores either is a contest whose scoreboard is unreadable.
   */
  async create(actor: Actor | null, body: CreateContestInput): Promise<ContestDetailDto> {
    if (!actor || !canCreateContest(actor)) {
      throw new AppError(403, 'contest_forbidden', 'You may not create contests.');
    }

    if (!Object.prototype.hasOwnProperty.call(CONTEST_FORMATS, body.format)) {
      throw new AppError(
        400,
        'unknown_contest_format',
        `Unknown contest format "${body.format}"; expected one of ` +
          `${Object.keys(CONTEST_FORMATS).join(', ')}.`,
      );
    }

    const frozenLastMinutes = body.frozenLastMinutes ?? 0;
    const startTime = new Date(body.startTime);
    const endTime = new Date(body.endTime);
    if (endTime.getTime() <= startTime.getTime()) {
      throw new AppError(400, 'contest_window_invalid', 'A contest must end after it starts.');
    }
    assertFreezeFits(frozenLastMinutes, startTime, endTime);

    const visibility = body.visibility ?? 'private';
    const orgSlugs = body.orgSlugs ?? [];
    // `contest_org_missing`, renamed from `contest_org_required` in D56:
    // that name now belongs to the 403 `join` answers a non-member, and one
    // code meaning both "you forgot to name an organization" (400, to a
    // setter) and "you are not in one" (403, to a competitor) is a code that
    // tells a client nothing.
    if (visibility === 'org' && orgSlugs.length === 0) {
      throw new AppError(
        400,
        'contest_org_missing',
        'An org-visible contest needs at least one organization.',
      );
    }
    const orgIds = await this.resolveOrgIds(actor, orgSlugs);
    const problemInputs = body.problems ?? [];
    const problemIds = await this.resolveProblemIds(actor, problemInputs);

    try {
      await this.db.transaction(async (tx) => {
        const [contest] = await tx
          .insert(contests)
          .values({
            key: body.key,
            name: body.name,
            startTime,
            endTime,
            format: body.format,
            formatConfig: body.formatConfig ?? null,
            pointsPrecision: body.pointsPrecision ?? 3,
            frozenLastMinutes,
            timeLimitSeconds: body.timeLimitSeconds ?? null,
            visibility,
            createdBy: actor.userId,
          })
          .returning({ id: contests.id });
        if (orgIds.length > 0) {
          await tx.insert(contestOrgs).values(orgIds.map((orgId) => ({ contestId: contest!.id, orgId })));
        }
        if (problemInputs.length > 0) {
          await tx.insert(contestProblems).values(
            problemInputs.map((problem, index) => ({
              contestId: contest!.id,
              problemId: problemIds[index]!,
              label: problem.label ?? String(index + 1),
              points: problem.points,
              partial: problem.partial ?? true,
              order: index,
            })),
          );
        }
      });
    } catch (error) {
      throw toCreateConflict(error);
    }

    return this.getVisible(actor, body.key);
  }

  /**
   * Edits a contest. Its creator, or an admin — **404 for everyone else**,
   * including a signed-in caller who can see the contest perfectly well.
   *
   * That is deliberately NOT what `setDisqualified` above does (403
   * `contest_forbidden` for exactly that caller). The two came from the same
   * brief, spelled out differently for each route, and both are implemented
   * as written rather than quietly harmonised; the P1-A report records the
   * asymmetry as the one thing here worth revisiting.
   *
   * Every absent field is left alone. The validations run against the MERGED
   * state, not against the patch: a request that moves only `endTime` must
   * still be rejected if it lands before the stored `startTime`, and nothing
   * in the patch alone can tell you that.
   */
  async update(actor: Actor, key: string, body: UpdateContestInput): Promise<ContestDetailDto> {
    const contest = await this.loadVisible(actor, key);
    if (!canRunContest(actor, contest)) throw NOT_FOUND;

    const format = body.format ?? contest.format;
    if (!Object.prototype.hasOwnProperty.call(CONTEST_FORMATS, format)) {
      throw new AppError(
        400,
        'unknown_contest_format',
        `Unknown contest format "${format}"; expected one of ` +
          `${Object.keys(CONTEST_FORMATS).join(', ')}.`,
      );
    }

    const frozenLastMinutes = body.frozenLastMinutes ?? contest.frozenLastMinutes;
    const startTime = body.startTime === undefined ? contest.startTime : new Date(body.startTime);
    const endTime = body.endTime === undefined ? contest.endTime : new Date(body.endTime);
    if (endTime.getTime() <= startTime.getTime()) {
      throw new AppError(400, 'contest_window_invalid', 'A contest must end after it starts.');
    }
    // On the MERGED state, like every other check here: a patch that only
    // moves `endTime` can make a freeze window the contest already stores
    // longer than the contest itself, and nothing in the patch says so.
    assertFreezeFits(frozenLastMinutes, startTime, endTime);

    const visibility = body.visibility ?? contest.visibility;
    // The stored set, needed twice: to decide the merged state below, and as
    // `resolveOrgIds`' already-attached exemption.
    const storedOrgIds = (
      await this.db
        .select({ orgId: contestOrgs.orgId })
        .from(contestOrgs)
        .where(eq(contestOrgs.contestId, contest.id))
    ).map((row) => row.orgId);
    // Resolved before the transaction opens, exactly as the problem list is:
    // an organization the actor may not bind must refuse the whole edit
    // having written nothing.
    const nextOrgIds =
      body.orgSlugs === undefined
        ? storedOrgIds
        : await this.resolveOrgIds(actor, body.orgSlugs, new Set(storedOrgIds));
    // On the MERGED state, like every other check here: `{ visibility: 'org' }`
    // alone is legal against a contest that already names an organization, and
    // `{ orgSlugs: [] }` alone is refused on one that is already org-visible.
    // The alternative either way is an org-visible contest attached to no
    // organization, which is visible to nobody at all — its creator's own list
    // included.
    if (visibility === 'org' && nextOrgIds.length === 0) {
      throw new AppError(
        400,
        'contest_org_missing',
        'An org-visible contest needs at least one organization.',
      );
    }

    // Started is `startTime <= now`, the same instant `join` and `getVisible`
    // read it at. Only an ACTUAL change is refused: re-sending the format the
    // contest already has, or the same problem list, is a no-op — a client
    // that PATCHes the whole form back must not be told the contest started.
    const started = new Date() >= contest.startTime;
    const problemInputs = body.problems;
    if (started) {
      if (body.format !== undefined && body.format !== contest.format) {
        throw new AppError(
          409,
          'contest_started',
          'This contest has started; its format can no longer change.',
        );
      }
      // D38. `startTime` is the origin of every clock this contest has: a live
      // participation with no time limit STARTS there (`participationStartMs`),
      // `lower()` voids any submission outside that window, and `icpc` counts
      // its penalty minutes from it. Moving it on a running contest therefore
      // deletes submissions from the board and rewrites every `cumtime` — with
      // a 200 and nothing on screen — and there is no operational need it
      // serves. Compared by instant, so re-sending the stored value is the
      // no-op it looks like.
      if (startTime.getTime() !== contest.startTime.getTime()) {
        throw new AppError(
          409,
          'contest_started',
          'This contest has started; its start time can no longer change.',
        );
      }
    }

    // Resolved before the transaction opens, exactly as `create` does it: a
    // problem the actor may not see must refuse the whole edit without
    // having written anything.
    const problemIds = problemInputs ? await this.resolveProblemIds(actor, problemInputs) : [];

    // The started guard on the problem list, narrowed to what is actually
    // destructive (D28). It used to refuse ANY difference, which sounds
    // safer and was not: the no-op path fell straight through to a
    // delete-and-reinsert of the whole list, and
    // `contest_submissions.contest_problem_id` is `ON DELETE cascade`, so a
    // running contest lost every submission it had (B1). Removals stay
    // refused, because a removal is the one edit whose cascade cannot be
    // avoided by writing more carefully.
    if (started && problemInputs !== undefined) {
      const kept = new Set(problemIds);
      const current = await this.db
        .select({ problemId: contestProblems.problemId })
        .from(contestProblems)
        .where(eq(contestProblems.contestId, contest.id));
      if (current.some((row) => !kept.has(row.problemId))) {
        throw new AppError(
          409,
          'contest_started',
          'This contest has started; a problem can no longer be removed from it.',
        );
      }
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(contests)
        .set({
          ...(body.name === undefined ? {} : { name: body.name }),
          startTime,
          endTime,
          format,
          // `null` is a real value for this column, so `?? contest.x` would
          // be wrong here: `hasOwnProperty` is what separates "set it to
          // null" from "leave it alone". Same for `timeLimitSeconds`.
          ...(hasKey(body, 'formatConfig') ? { formatConfig: body.formatConfig ?? null } : {}),
          ...(hasKey(body, 'timeLimitSeconds')
            ? { timeLimitSeconds: body.timeLimitSeconds ?? null }
            : {}),
          ...(body.pointsPrecision === undefined ? {} : { pointsPrecision: body.pointsPrecision }),
          frozenLastMinutes,
          visibility,
        })
        .where(eq(contests.id, contest.id));

      if (body.orgSlugs !== undefined) {
        // DIFFED, not delete-and-reinsert. `contest_orgs` has no dependent
        // rows today, so a wholesale replace would be harmless *now* — and
        // that is exactly the reasoning B1 punished on `contest_problems`,
        // where a cascade nobody re-read deleted a running contest's
        // submissions. The diff costs three lines and cannot acquire that
        // failure later.
        const kept = new Set(nextOrgIds);
        const removed = storedOrgIds.filter((id) => !kept.has(id));
        if (removed.length > 0) {
          await tx
            .delete(contestOrgs)
            .where(and(eq(contestOrgs.contestId, contest.id), inArray(contestOrgs.orgId, removed)));
        }
        const present = new Set(storedOrgIds);
        const added = nextOrgIds.filter((id) => !present.has(id));
        if (added.length > 0) {
          await tx
            .insert(contestOrgs)
            .values(added.map((orgId) => ({ contestId: contest.id, orgId })));
        }
      }

      if (problemInputs !== undefined) {
        // DIFFED by problem id, never replaced wholesale (B1/D28).
        // `contest_submissions.contest_problem_id` is `ON DELETE cascade` on
        // these ids, so `delete` here is a data-destroying operation on a
        // running contest — including when the list being written is
        // identical to the stored one, which is exactly what the edit form
        // resubmits when an organiser only moves `endTime`. Rows that stay
        // keep their id; only genuinely removed problems are deleted, and
        // the guard above has already refused that once the contest started.
        //
        // The unique index is `(contest_id, problem_id)` and nothing
        // constrains `label` or `order`, so an in-place reorder cannot
        // collide row by row — deleting first is ordering hygiene, not a
        // workaround.
        const current = await tx
          .select({ id: contestProblems.id, problemId: contestProblems.problemId })
          .from(contestProblems)
          .where(eq(contestProblems.contestId, contest.id));
        const existingIdByProblem = new Map(current.map((row) => [row.problemId, row.id]));

        const desired = problemInputs.map((problem, index) => ({
          problemId: problemIds[index]!,
          label: problem.label ?? String(index + 1),
          points: problem.points,
          partial: problem.partial ?? true,
          order: index,
        }));
        const keptProblemIds = new Set(desired.map((row) => row.problemId));

        const removed = current.filter((row) => !keptProblemIds.has(row.problemId));
        if (removed.length > 0) {
          await tx.delete(contestProblems).where(
            inArray(
              contestProblems.id,
              removed.map((row) => row.id),
            ),
          );
        }
        for (const row of desired) {
          const existingId = existingIdByProblem.get(row.problemId);
          if (existingId === undefined) {
            await tx.insert(contestProblems).values({ contestId: contest.id, ...row });
          } else {
            await tx
              .update(contestProblems)
              .set({
                label: row.label,
                points: row.points,
                partial: row.partial,
                order: row.order,
              })
              .where(eq(contestProblems.id, existingId));
          }
        }
      }
    });

    // BOTH key sets, old and new (D25). `endTime` and `frozenLastMinutes` are
    // in the key, and this patch may have moved either — invalidating only
    // the merged state would leave the pre-edit board sitting under its old
    // boundary's key, which is exactly the board this edit made wrong.
    await this.invalidateScoreboards(contest, { id: contest.id, endTime, frozenLastMinutes });

    return this.getVisible(actor, contest.key);
  }

  /** Loads a contest by key, or 404s — for absence and invisibility alike. */
  /**
   * Join a contest: live while it runs, virtually once it has ended.
   *
   * **Idempotent for a live join.** Joining twice returns the existing
   * participation rather than creating a second or failing on
   * `UNIQUE (contest_id, user_id, virtual)`; a retrying client must not be
   * able to fork its own participation.
   *
   * A *virtual* join is deliberately not idempotent — each one is a fresh
   * attempt, which is the whole meaning of `virtual = n`. A client that
   * retries a virtual join blindly gets a second attempt, and that is the
   * correct reading of the request it made twice.
   */
  async join(actor: Actor, key: string): Promise<ContestParticipationDto> {
    const contest = await this.loadVisible(actor, key);
    const now = new Date();

    if (now < contest.startTime) {
      throw new AppError(409, 'contest_not_started', 'This contest has not started yet.');
    }
    const running = now <= contest.endTime;
    const existing = await listParticipations(this.db, contest.id, actor.userId);

    if (running) {
      const live = existing.find((participation) => participation.virtual === LIVE_VIRTUAL);
      if (live) return this.participationDto(contest, live);
    }

    // D56. The gate sits HERE — after the idempotent live short-circuit and
    // before any row is minted — so a competitor who already holds a
    // participation still reads it back on a retry, whatever the roster says
    // today. Only the CREATION of a new attempt is refused: a school that
    // removes a pupil mid-contest does not thereby delete the contest from
    // under them, and an organiser who seeded a guest does not have to
    // enrol them in a school to keep them.
    await this.assertMayJoin(actor, contest);

    // Live joins take `0`; a virtual attempt takes one past the highest the
    // caller already holds, so a second attempt is `2` even if the first was
    // made months earlier.
    const virtual = running
      ? LIVE_VIRTUAL
      : Math.max(LIVE_VIRTUAL, ...existing.map((participation) => participation.virtual)) + 1;

    // A disqualification binds the PERSON in this contest, not one attempt
    // (D37) — which is exactly what `setDisqualified` says, and it moves every
    // row this user holds together for that reason. A new attempt started
    // afterwards has to inherit it, or an expelled competitor walks back onto
    // the board with one more POST, un-struck; and `setDisqualified(false)`
    // still clears every row, this one included.
    const isDisqualified = existing.some((participation) => participation.isDisqualified);

    const [inserted] = await this.db
      .insert(contestParticipations)
      .values({ contestId: contest.id, userId: actor.userId, virtual, startTime: now, isDisqualified })
      // Concurrent live joins race to the same `(contest, user, 0)` key. The
      // loser reads the winner's row rather than surfacing a 500, which is
      // what makes the idempotency claim above true under concurrency and not
      // merely in sequence.
      .onConflictDoNothing()
      .returning({
        id: contestParticipations.id,
        virtual: contestParticipations.virtual,
        startTime: contestParticipations.startTime,
        isDisqualified: contestParticipations.isDisqualified,
      });
    if (inserted) return this.participationDto(contest, inserted);

    const raced = (await listParticipations(this.db, contest.id, actor.userId)).find(
      (participation) => participation.virtual === virtual,
    );
    if (!raced) throw new AppError(409, 'contest_join_conflict', 'Try joining again.');
    return this.participationDto(contest, raced);
  }

  /**
   * Disqualify, or reinstate, one participant. The contest's creator or a
   * global admin — nobody else.
   *
   * **Every participation that user holds in this contest moves together.**
   * The route is keyed by username, and a user can hold a live participation
   * plus any number of virtual attempts; flipping only one of them would
   * leave "is this person disqualified from this contest?" with no answer,
   * and the scoreboard showing them both struck out and not. Disqualification
   * is a judgement about the person in this contest, not about one attempt.
   *
   * 403, not 404, for a caller who can see the contest but does not run it:
   * the contest's existence is already theirs to know (they can read it, and
   * its scoreboard), so there is nothing left to conceal — the 404-over-403
   * rule applies to *existence*, and this is not that. A contest they cannot
   * see 404s from `loadVisible` before this check is ever reached.
   */
  async setDisqualified(
    actor: Actor,
    key: string,
    username: string,
    disqualified: boolean,
  ): Promise<ContestParticipationDto> {
    const contest = await this.loadVisible(actor, key);
    if (!canRunContest(actor, contest)) {
      throw new AppError(403, 'contest_forbidden', 'You do not run this contest.');
    }

    // `lower() = lower()`, like every other username resolution in this repo
    // — an exact-match `eq()` against the case-folded unique index is a bug
    // this codebase has already paid for once.
    const [user] = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`lower(${schema.users.username}) = lower(${username})`)
      .limit(1);
    if (!user) throw new AppError(404, 'user_not_found', 'No such user.');

    const existing = await listParticipations(this.db, contest.id, user.id);
    if (existing.length === 0) {
      throw new AppError(
        404,
        'participation_not_found',
        'That user has not joined this contest.',
      );
    }

    await this.db
      .update(contestParticipations)
      .set({ isDisqualified: disqualified })
      .where(
        and(
          eq(contestParticipations.contestId, contest.id),
          eq(contestParticipations.userId, user.id),
        ),
      );

    // Every ranking row moved, so every cached board for this contest is now
    // wrong (D25). Deleted after the UPDATE commits, never before: dropping
    // the entry first only opens a window for a concurrent read to refill it
    // with the pre-write board.
    await this.invalidateScoreboards(contest);

    // Re-read rather than patching the row in memory: the summary must
    // describe what is now stored, and `listParticipations`' own ordering
    // (highest `virtual` first) decides which one that is — the same one
    // `GET /contests/:key/me` would answer for that user.
    const [updated] = await listParticipations(this.db, contest.id, user.id);
    return this.participationDto(contest, updated!);
  }

  /** The caller's own participation, highest `virtual` first. */
  async myParticipation(actor: Actor, key: string): Promise<ContestParticipationDto> {
    const contest = await this.loadVisible(actor, key);
    const [participation] = await listParticipations(this.db, contest.id, actor.userId);
    // 404 for "you have not joined". The caller already passed this contest's
    // own visibility check to get here, so this conceals nothing; it is the
    // not-found shape reused for an empty result.
    if (!participation) {
      throw new AppError(404, 'participation_not_found', 'You have not joined this contest.');
    }
    return this.participationDto(contest, participation);
  }

  private participationDto(
    contest: ContestWindowRow,
    participation: ParticipationRow,
  ): ContestParticipationDto {
    // `endTime` is derived, never stored: a live participation in a contest
    // with no time limit ends when the contest does, and a virtual one runs
    // for the contest's duration from its own start.
    const { endMs } = participationWindow(contest, participation);
    return {
      id: participation.id,
      contestKey: contest.key,
      virtual: participation.virtual,
      startTime: participation.startTime.toISOString(),
      endTime: new Date(endMs).toISOString(),
      isDisqualified: participation.isDisqualified,
    };
  }

  /**
   * Public, not private, because `ContestClarificationsService` needs exactly
   * this — "the contest under this key, or 404" — and a second copy of it
   * there would be a second answer to "may this actor see this contest", which
   * is the split-predicate bug this project has found once per phase. One
   * caller outside this class is worth more than the encapsulation.
   */
  async loadVisible(actor: Actor | null, key: string) {
    const contest = (
      await this.db
        .select()
        .from(contests)
        .where(sql`lower(${contests.key}) = lower(${key})`)
        .limit(1)
    )[0];
    if (!contest) throw NOT_FOUND;

    const ctx = await loadContestContext(this.db, actor, contest);
    if (!canViewContest(actor, contest, ctx)) throw NOT_FOUND;
    return contest;
  }

  /**
   * The contest's problems, ordered by `order` then id — the order the format
   * assigns labels in. `datasetTotalPoints` comes from the **published**
   * revision (the `state` term is not redundant; see `ProblemAccessService`),
   * and is null when there is none, which is what makes
   * `points_scaling_factor` null.
   */
  private async loadProblemRows(contestId: number) {
    return this.db
      .select({
        code: problems.code,
        name: problems.name,
        label: contestProblems.label,
        points: contestProblems.points,
        partial: contestProblems.partial,
        order: contestProblems.order,
        datasetTotalPoints: problemRevisions.totalPoints,
      })
      .from(contestProblems)
      .innerJoin(problems, eq(problems.id, contestProblems.problemId))
      .leftJoin(
        problemRevisions,
        and(
          eq(problems.currentRevisionId, problemRevisions.id),
          eq(problemRevisions.state, 'published'),
        ),
      )
      .where(eq(contestProblems.contestId, contestId))
      .orderBy(asc(contestProblems.order), asc(contestProblems.id));
  }

  /**
   * Every contest submission with its cases, in `contest_submissions.id` and
   * `submission_cases.id` order — both load-bearing, per `mapContest`.
   *
   * Cases are restricted to each submission's **latest attempt**. A regrade
   * writes a second attempt's rows beside the first's (the identity index
   * makes redelivery harmless, it never deletes), and summing both would
   * double every loose case. No golden covers this — the goldens are
   * single-attempt — so it is a decision made here rather than a test result.
   */
  private async loadSubmissionRows(contestId: number): Promise<ContestSubmissionRow[]> {
    const rows = await this.db
      .select({
        id: contestSubmissions.id,
        participationId: contestSubmissions.participationId,
        problemCode: problems.code,
        submissionId: submissions.id,
        date: submissions.createdAt,
        verdict: submissions.verdict,
        state: submissions.state,
      })
      .from(contestSubmissions)
      .innerJoin(
        contestParticipations,
        eq(contestParticipations.id, contestSubmissions.participationId),
      )
      .innerJoin(contestProblems, eq(contestProblems.id, contestSubmissions.contestProblemId))
      .innerJoin(problems, eq(problems.id, contestProblems.problemId))
      .innerJoin(submissions, eq(submissions.id, contestSubmissions.submissionId))
      .where(eq(contestParticipations.contestId, contestId))
      .orderBy(asc(contestSubmissions.id));

    if (rows.length === 0) return [];

    const submissionIds = rows.map((row) => row.submissionId);
    const latestAttempt = this.db
      .select({
        submissionId: submissionCases.submissionId,
        // Aliased away from `attempt`: an `attempt` on both sides of the
        // join is an ambiguous column reference to Postgres.
        maxAttempt: max(submissionCases.attempt).as('max_attempt'),
      })
      .from(submissionCases)
      .where(inArray(submissionCases.submissionId, submissionIds))
      .groupBy(submissionCases.submissionId)
      .as('latest_attempt');

    const caseRows = await this.db
      .select({
        id: submissionCases.id,
        submissionId: submissionCases.submissionId,
        groupIndex: submissionCases.groupIndex,
        caseIndex: submissionCases.caseIndex,
        points: submissionCases.points,
        maxPoints: submissionCases.maxPoints,
        verdict: submissionCases.verdict,
      })
      .from(submissionCases)
      .innerJoin(
        latestAttempt,
        and(
          eq(latestAttempt.submissionId, submissionCases.submissionId),
          eq(latestAttempt.maxAttempt, submissionCases.attempt),
        ),
      )
      .where(inArray(submissionCases.submissionId, submissionIds))
      .orderBy(asc(submissionCases.id));

    const casesBySubmission = new Map<number, ContestCaseRow[]>();
    for (const row of caseRows) {
      const bucket = casesBySubmission.get(row.submissionId);
      const testCase: ContestCaseRow = {
        groupIndex: row.groupIndex,
        caseIndex: row.caseIndex,
        points: row.points,
        maxPoints: row.maxPoints,
        verdict: row.verdict,
      };
      if (bucket === undefined) casesBySubmission.set(row.submissionId, [testCase]);
      else bucket.push(testCase);
    }

    return rows.map((row) => ({
      participationId: row.participationId,
      problemCode: row.problemCode,
      date: row.date,
      verdict: row.verdict,
      state: row.state,
      cases: casesBySubmission.get(row.submissionId) ?? [],
    }));
  }

  /**
   * Refuses `join` when the contest is restricted to organizations the actor
   * does not belong to (D56).
   *
   * **403, not 404**, and it is the one place in this service that answers
   * 403 to a read-shaped refusal. The 404-over-403 rule protects EXISTENCE,
   * and there is no existence left to protect: `loadVisible` has already let
   * this caller see the contest, and every contest response names the
   * organizations restricting it. A 404 here would tell a competitor staring
   * at the contest page that the contest had vanished. Same reasoning
   * `setDisqualified` already uses for the same status.
   *
   * A global admin is exempt, as they are from every visibility decision in
   * this codebase. The contest's CREATOR is not: running a contest is not
   * competing in it, and a setter who wants a row on their own school's
   * board can be a member of their own school.
   */
  private async assertMayJoin(actor: Actor, contest: ContestRow): Promise<void> {
    if (isAdmin(actor)) return;
    // `loadContestContext` already computes exactly this pair — the contest's
    // organizations, and the INTERSECTION with the actor's — for
    // `canViewContest`. Asking it again here is what keeps "restricted to"
    // and "shared with" from becoming two different queries that disagree.
    const ctx = await loadContestContext(this.db, actor, contest);
    if (ctx.sharedOrgIds.length === 0) return;
    if (ctx.actorOrgIds.length > 0) return;
    throw new AppError(
      403,
      'contest_org_required',
      'This contest is restricted to members of its organizations.',
    );
  }

  /**
   * Mirrors `ProblemAccessService.resolveOrgIds`: an unknown slug and one the
   * actor may not attach are deliberately indistinguishable, so a slug cannot
   * probe for a private organization's existence.
   *
   * **Owner or admin, not merely a member** (D56). Attaching an organization
   * to a contest now decides who may COMPETE in it, which is a claim to speak
   * for that school; a pupil on its roster does not get to make it, and could
   * before this — plain membership was the whole check. Problems keep the
   * looser rule on purpose: sharing a problem with your own school is
   * publishing to a room you are in, not conscripting it.
   *
   * `alreadyAttachedIds` is exempt, the same exemption `problem.access.ts`
   * carries and for the same reason: the edit form resubmits the stored list
   * on every save, so a creator who is only a member of an organization an
   * admin attached must still be able to change the contest's NAME.
   */
  private async resolveOrgIds(
    actor: Actor,
    slugs: string[],
    alreadyAttachedIds: ReadonlySet<number> = new Set(),
  ): Promise<number[]> {
    if (slugs.length === 0) return [];
    const ids: number[] = [];
    for (const slug of [...new Set(slugs)]) {
      const row = (
        await this.db
          .select({ id: organizations.id })
          .from(organizations)
          .where(sql`lower(${organizations.slug}) = lower(${slug})`)
          .limit(1)
      )[0];
      if (!row) throw new AppError(400, 'contest_org_unknown', 'No such organization.');
      ids.push(row.id);
    }
    const uniqueIds = [...new Set(ids)];
    if (!isAdmin(actor)) {
      const addedIds = uniqueIds.filter((id) => !alreadyAttachedIds.has(id));
      const adminships = await loadOrgAdminships(this.db, actor, addedIds);
      for (const id of addedIds) {
        if (!adminships.has(id)) throw new AppError(400, 'contest_org_unknown', 'No such organization.');
      }
    }
    return uniqueIds;
  }

  /**
   * Resolves problem codes to ids, refusing any the actor may not see — a
   * contest must not become a side channel for a private problem's existence,
   * so the error is the same whether the code names nothing or names something
   * hidden. Positional: the returned ids line up with `inputs`.
   */
  private async resolveProblemIds(actor: Actor, inputs: ContestProblemInputDto[]): Promise<number[]> {
    const ids: number[] = [];
    for (const input of inputs) {
      const row = (
        await this.db
          .select({ id: problems.id, visibility: problems.visibility })
          .from(problems)
          .where(sql`lower(${problems.code}) = lower(${input.code})`)
          .limit(1)
      )[0];
      if (!row) throw new AppError(400, 'contest_problem_unknown', 'No such problem.');
      const ctx = await loadProblemContext(this.db, actor, row.id);
      if (!canViewProblem(actor, row, ctx)) {
        throw new AppError(400, 'contest_problem_unknown', 'No such problem.');
      }
      ids.push(row.id);
    }
    if (new Set(ids).size !== ids.length) {
      throw new AppError(400, 'contest_problem_duplicate', 'A problem may appear in a contest once.');
    }
    return ids;
  }
}

/**
 * Who may run a contest: its creator, or a global admin.
 *
 * Deliberately NOT `canCreateContest` (a setter may create contests, but a
 * setter is not thereby an organiser of everyone else's), and deliberately
 * one function rather than the same two-clause expression written out at
 * each call site — `canEdit` on the detail response and the refusals on the
 * write paths must be the same predicate, or the UI offers a button the
 * server then refuses.
 */
export function canRunContest(
  actor: Actor | null,
  contest: { createdBy: number | null },
): boolean {
  if (!actor) return false;
  return isAdmin(actor) || contest.createdBy === actor.userId;
}

/**
 * "Was this key sent at all?", as opposed to "is its value undefined?".
 *
 * The distinction is load-bearing for the two nullable columns a PATCH can
 * touch: `{ timeLimitSeconds: null }` means "remove the limit" and `{}`
 * means "leave it", and `body.timeLimitSeconds` is `undefined` for both.
 */
/**
 * The one write-time rule a freeze window has (D22): it must be **strictly
 * shorter** than the contest, in whole minutes.
 *
 * A freeze as long as the contest hides the whole thing from everyone but its
 * organisers for its entire duration, which is not a freeze — it is a private
 * scoreboard with a public URL. Equality is refused too, for the same reason.
 *
 * 422, not the 400 its neighbours use: the value is a well-formed integer that
 * the request as a whole makes impossible, which is exactly the distinction
 * 422 draws, and it is what the brief specified.
 */
function assertFreezeFits(frozenLastMinutes: number, startTime: Date, endTime: Date): void {
  if (frozenLastMinutes === 0) return;
  const durationMinutes = (endTime.getTime() - startTime.getTime()) / 60_000;
  if (frozenLastMinutes >= durationMinutes) {
    throw new AppError(
      422,
      'contest_freeze_too_long',
      `A freeze window of ${String(frozenLastMinutes)} minutes is not shorter than the ` +
        `contest, which runs ${String(durationMinutes)} minutes.`,
    );
  }
}

function hasKey<T extends object>(body: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

/**
 * `orgs` is a REQUIRED second argument rather than one defaulting to `[]`.
 *
 * A default would make "this contest is open to everyone" the answer a caller
 * gets by forgetting to load the restriction — the failure mode D56 cannot
 * afford, because that shape is what the join button on the web reads.
 */
function toSummary(
  row: {
    id: number;
    key: string;
    name: string;
    startTime: Date;
    endTime: Date;
    format: string;
    visibility: ContestVisibilityDto;
    pointsPrecision: number;
    frozenLastMinutes: number;
    timeLimitSeconds: number | null;
    isRated: boolean;
    createdAt: Date;
  },
  orgs: ContestOrgDto[],
): ContestSummaryDto {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    startTime: row.startTime.toISOString(),
    endTime: row.endTime.toISOString(),
    isRated: row.isRated,
    format: row.format,
    visibility: row.visibility,
    pointsPrecision: row.pointsPrecision,
    frozenLastMinutes: row.frozenLastMinutes,
    timeLimitSeconds: row.timeLimitSeconds,
    orgs,
    createdAt: row.createdAt.toISOString(),
  };
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const after = Number(cursor);
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new AppError(422, 'invalid_cursor', 'That page cursor is not valid.');
  }
  return after;
}

/** A racing duplicate key surfaces as the unique violation, never a pre-check SELECT. */
function toCreateConflict(error: unknown): unknown {
  const violation = asUniqueViolation(error);
  if (violation && (violation.constraint_name ?? '') === CONTEST_KEY_CONSTRAINT) {
    return new AppError(409, 'contest_key_taken', 'That contest key is already taken.');
  }
  return error;
}

function asUniqueViolation(error: unknown): { code: string; constraint_name?: string } | undefined {
  if (isUniqueViolationShape(error)) return error;
  const cause = error instanceof Error ? error.cause : undefined;
  return isUniqueViolationShape(cause) ? cause : undefined;
}

function isUniqueViolationShape(value: unknown): value is { code: string; constraint_name?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    (value as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}
