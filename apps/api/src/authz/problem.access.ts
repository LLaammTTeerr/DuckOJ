import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, gt, gte, inArray, isNotNull, lte, notInArray, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  organizations,
  problemMembers,
  problemOrgs,
  problemRevisions,
  problemTags,
  problems,
  submissions,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import {
  findMissingPackageFiles,
  findPathCollision,
  parseManifest,
  readArchiveEntry,
  type PackageManifestDto,
} from '@duckoj/package-format';
import {
  CreateProblemRequest,
  type AttachRevisionRequestDto,
  type PaginationQueryDto,
  type EditorialResponseDto,
  type ProblemDetailDto,
  type ProblemMeDto,
  type ProblemMemberDto,
  type ProblemSampleDto,
  type ProblemPageDto,
  type ProblemStatsDto,
  type ProblemSummaryDto,
  type RevisionSummaryDto,
  type TagDto,
  type RevisionVersionResponseDto,
  type CloneProblemRequestDto,
  type UpdateProblemRequestDto,
} from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import { PACKAGE_STORE, type PackageStore } from '../packages/package.store.js';
import {
  readPackageSamples,
  SAMPLES_CACHE_TTL_MS,
  samplesCacheKey,
} from '../packages/samples.js';
import {
  canCreateProblem,
  canEditProblem,
  canViewProblem,
  canViewRevisions,
  contestHiddenProblemIds,
  loadProblemContext,
  visibleProblemsWhere,
  type ProblemViewContext,
  type ProblemVisibility,
} from './problem.visibility.js';
import { isAdmin, type Actor } from './actor.js';
import { loadOrgMembership, visibleOrgsWhere } from './org.visibility.js';
import { contestWindowOpenWhere } from './submission.freeze.js';
import { ScoreboardCache, type ScoreboardCacheState } from './scoreboard.cache.js';

/** Postgres SQLSTATE for a unique-constraint violation. */
const UNIQUE_VIOLATION = '23505';
const PROBLEM_CODE_CONSTRAINT = 'problems_code_lower_idx';

/**
 * Deliberately identical whether a slug names no organization at all or
 * names one the actor may not share with (not a member, in any role). Two
 * distinct messages here would be exactly the existence oracle
 * `problem_not_found` already avoids for problems themselves: a private
 * organization's existence must not leak through which error a non-member
 * gets back.
 */
const ORG_UNKNOWN_MESSAGE = 'No such organization.';

// The DTOs below are re-exported (or trivially aliased) from
// `@duckoj/contracts` rather than redeclared here, so the wire contract and
// what this service actually returns can never drift apart into two
// independent definitions of the same shape.
export type { ProblemSummaryDto, ProblemPageDto, ProblemDetailDto, RevisionSummaryDto };

export type ProblemMemberInput = ProblemMemberDto;

/**
 * `z.input`, not `z.infer` (`CreateProblemRequestDto`, the parsed *output*):
 * `visibility` and `orgSlugs` carry zod defaults, so the output type has both
 * as always-present. `create()` below still applies its own
 * `?? 'private'` / `?? []` fallback for a direct (non-HTTP) caller that
 * omits them — this input type is what lets such a caller's object literal,
 * with either field left out, still type-check. The fallback deliberately
 * matches the zod default: when the two disagreed, a direct caller silently
 * got a world-readable problem while every HTTP caller got a private one.
 */
export type CreateProblemInput = z.input<typeof CreateProblemRequest>;

/**
 * `UpdateProblemRequestDto` (the wire contract) plus a local-only `code?`
 * escape hatch: the contract itself has no `code` field at all — a stray
 * `code` in a PATCH body is rejected by `UpdateProblemRequest`'s `.strict()`
 * before it would ever reach here over HTTP — but `code` stays a member of
 * this internal type so a direct (non-HTTP) caller that includes it still
 * type-checks, and `update` below rejects the request for it — a problem's
 * code cannot be changed once created. `members` and `orgSlugs`, when
 * present, are whole-set replacements of `problemMembers` / `problemOrgs`,
 * not merges.
 */
export type UpdateProblemPatch = UpdateProblemRequestDto & { code?: string };

export type CloneProblemInput = CloneProblemRequestDto;

export type AttachRevisionInput = AttachRevisionRequestDto;

export type AttachRevisionResult = RevisionVersionResponseDto;

export type PublishRevisionResult = RevisionVersionResponseDto;

/**
 * Everything `GET /problems` narrows by, beyond the page cursor. All four are
 * independent and combine with AND; `tags` is itself an AND across its
 * members (see `ProblemListQuery`'s doc comment in `@duckoj/contracts`).
 */
export interface ProblemFilters {
  q?: string | undefined;
  tags?: string[] | undefined;
  difficultyMin?: number | undefined;
  difficultyMax?: number | undefined;
}

/**
 * Escapes Postgres `LIKE` metacharacters — the escape character itself,
 * then `%` and `_` — so a search term is matched literally rather than as a
 * pattern. Without this, a search for `100%` (or, worse, a bare `%`) would
 * be interpolated straight into the pattern and match far more than the
 * literal text the caller typed.
 */
export function likeEscape(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * The primary reader of `@duckoj/db/guarded` for problems, exactly as
 * `org.access.ts` is for organizations — with two carve-outs: the submission
 * read path (`SubmissionAccessService`, spec §3), and the problem discussion
 * (`ProblemCommentsService`, D109), which reads and writes its own
 * `problem_comments` table and reuses this file's visibility predicates
 * rather than reimplementing them.
 */
@Injectable()
export class ProblemAccessService {
  private readonly logger = new Logger(ProblemAccessService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PACKAGE_STORE) private readonly store: PackageStore,
    // The same read-through cache the scoreboard uses (D25, generic since
    // D48). The statistics are viewer-independent by construction — that is
    // the whole point of D49's uniform exclusion — so one key per problem
    // serves everybody.
    @Inject(ScoreboardCache) private readonly cache: ScoreboardCache,
  ) {}

  /**
   * A `LEFT JOIN LATERAL`-ready subquery: `userId`'s single best submission
   * to whichever problem row it is correlated against (`problems.id`,
   * referenced here even though `problems` is not this query's own `FROM`
   * — valid only because a caller attaches this as a lateral join, where
   * the outer `problems` row is already in scope). "Best" is spec §3: max
   * `points`, ties broken by the earliest (smallest) `id`; `points DESC,
   * id` is exactly `submissions_user_problem_points_idx`'s trailing order,
   * so this is served by the index with no extra sort.
   *
   * Filtered to `verdict IS NOT NULL` — "has finished grading" — not to
   * `points`/`maxPoints` being set. Coordinator review (2026-08-21) caught
   * that the earlier `isNotNull(points) AND isNotNull(maxPoints)` filter
   * excluded CE and IE from `me` entirely: `event-writer.ts`'s
   * `compileError` branch sets `points: 0` but never `maxPoints`, and its
   * `internalError`/`terminated` branches set neither — so a viewer whose
   * only submission to a problem was a CE or IE saw an empty cell,
   * indistinguishable from never having attempted it, which actively
   * misinforms exactly the beginners who hit CE most. `verdict IS NOT
   * NULL` is the correct "graded" predicate instead: every terminal state
   * (`done` or `errored`) sets it, and only an in-flight submission
   * (`queued`/`compiling`/`grading`) leaves it null.
   *
   * `desc(...) nulls last`, spelled out with raw `sql`, not the plain
   * `desc()` helper: unqualified, Postgres's `ORDER BY points DESC` sorts
   * nulls FIRST, but `submissions_user_problem_points_idx` was generated
   * (drizzle-kit's own default for every index column, regardless of
   * direction) as `points DESC NULLS LAST`. Matching the index's null
   * placement here is what lets the planner recognise the index already
   * delivers this order and skip the extra Sort node it otherwise adds —
   * confirmed by `EXPLAIN` against a few thousand rows. It also does real
   * work now that IE (`points: null`) is a candidate: NULLS LAST means an
   * unscored IE always sorts behind every submission that has a real
   * score, including a CE's 0 — an IE can only ever win the "best" slot
   * when it is the viewer's only graded submission to the problem.
   */
  private bestSubmissionLateral(userId: number) {
    return this.db
      .select({
        verdict: submissions.verdict,
        points: submissions.points,
        maxPoints: submissions.maxPoints,
      })
      .from(submissions)
      .where(and(eq(submissions.problemId, problems.id), eq(submissions.userId, userId), isNotNull(submissions.verdict)))
      .orderBy(sql`${submissions.points} desc nulls last`, asc(submissions.id))
      .limit(1)
      .as('me_best');
  }

  async listVisible(
    actor: Actor | null,
    // `cursor?: string | undefined` rather than `cursor?: string`: the
    // project compiles with `exactOptionalPropertyTypes`, under which a
    // parsed `PaginationQueryDto` is not assignable to the narrower form.
    page: Pick<PaginationQueryDto, 'limit'> & { cursor?: string | undefined },
    filters: ProblemFilters = {},
  ): Promise<ProblemPageDto> {
    const after = parseCursor(page.cursor);
    const conditions = [visibleProblemsWhere(this.db, actor), gt(problems.id, after)];
    if (filters.q) {
      const pattern = `%${likeEscape(filters.q.toLowerCase())}%`;
      conditions.push(
        or(
          sql`lower(${problems.code}) like ${pattern}`,
          sql`lower(${problems.name}) like ${pattern}`,
        )!,
      );
    }

    // Deduplicated on the way in: `?tag=cay&tag=cay` names one tag, and the
    // `HAVING` below counts against this length — so leaving the duplicate
    // in would demand a problem carry `cay` twice, which its primary key
    // makes impossible, and answer an empty page to a harmless request.
    const tagSlugs = [...new Set(filters.tags ?? [])];
    if (tagSlugs.length > 0) {
      // `count(distinct slug) = <how many were REQUESTED>` — deliberately
      // not `= <how many resolved>`. An unknown slug then makes the whole
      // conjunction unsatisfiable and the page empty, which is the honest
      // answer; counting resolved ids instead would let a typo silently drop
      // out of the AND and widen the result to whatever the rest matched.
      const carryingAll = this.db
        .select({ problemId: problemTags.problemId })
        .from(problemTags)
        .innerJoin(schema.tags, eq(schema.tags.id, problemTags.tagId))
        .where(inArray(schema.tags.slug, tagSlugs))
        .groupBy(problemTags.problemId)
        .having(sql`count(distinct ${schema.tags.slug}) = ${tagSlugs.length}`);
      conditions.push(inArray(problems.id, carryingAll));
    }
    // A null difficulty never satisfies either bound — SQL's own null
    // semantics, and the right answer: "between 3 and 7" is a claim about a
    // number, and "nobody has said" is not a number in that range.
    if (filters.difficultyMin !== undefined) conditions.push(gte(problems.difficulty, filters.difficultyMin));
    if (filters.difficultyMax !== undefined) conditions.push(lte(problems.difficulty, filters.difficultyMax));

    const hidden = await this.contestHiddenProblemIds(actor);
    const filtering =
      tagSlugs.length > 0 || filters.difficultyMin !== undefined || filters.difficultyMax !== undefined;
    // The filter runs over the MASKED view, not under it. Blanking `tags` on
    // the row while still letting `?tag=do-thi` match it would leave the
    // filter as an oracle answering exactly the question the blank refused
    // — so a problem whose hint is hidden from this viewer drops out of a
    // tag- or difficulty-filtered page entirely. An unfiltered page still
    // lists it, blanked: hiding the hint must not hide the problem.
    if (filtering && hidden.size > 0) conditions.push(notInArray(problems.id, [...hidden]));

    // The `state` term on the revision join is not redundant. Every path
    // that sets `currentRevisionId` today points it at a published
    // revision, but that is convention across three call sites, not a
    // database constraint. Without this, a future bug leaving the pointer
    // on an archived revision would report that revision's stale limits as
    // live; with it, the same bug degrades to `hasPublishedRevision: false`,
    // which is at least honest.
    const revisionJoin = and(eq(problems.currentRevisionId, problemRevisions.id), eq(problemRevisions.state, 'published'));

    // Two full query shapes rather than one query with a conditionally
    // built select list: for an anonymous caller the lateral is omitted
    // entirely (spec §5) rather than joined against a null user id — a
    // query that filters on `user_id = NULL` returns no rows but still
    // costs the join. Either way this is ONE statement to Postgres; the
    // branch only decides whether that one statement carries a third join.
    let rows: Array<{
      id: number;
      code: string;
      name: string;
      visibility: ProblemVisibility;
      difficulty: number | null;
      revisionId: number | null;
      timeMs: number | null;
      memoryKb: number | null;
      testCount: number | null;
      meVerdict?: string | null;
      mePoints?: number | null;
      meMaxPoints?: number | null;
    }>;
    if (actor) {
      // Built once, not once per referencing column below: each call to
      // `bestSubmissionLateral` constructs a fresh subquery aliased
      // `me_best`, so calling it more than once here would either
      // alias-collide or attach unjoined copies instead of referencing the
      // one that is actually joined in.
      const meBest = this.bestSubmissionLateral(actor.userId);
      rows = await this.db
        .select({
          id: problems.id,
          code: problems.code,
          name: problems.name,
          visibility: problems.visibility,
          difficulty: problems.difficulty,
          revisionId: problemRevisions.id,
          timeMs: problemRevisions.timeMs,
          memoryKb: problemRevisions.memoryKb,
          testCount: problemRevisions.testCount,
          meVerdict: meBest.verdict,
          mePoints: meBest.points,
          meMaxPoints: meBest.maxPoints,
        })
        .from(problems)
        .leftJoin(problemRevisions, revisionJoin)
        .leftJoinLateral(meBest, sql`true`)
        .where(and(...conditions))
        .orderBy(asc(problems.id))
        .limit(page.limit + 1);
    } else {
      rows = await this.db
        .select({
          id: problems.id,
          code: problems.code,
          name: problems.name,
          visibility: problems.visibility,
          difficulty: problems.difficulty,
          revisionId: problemRevisions.id,
          timeMs: problemRevisions.timeMs,
          memoryKb: problemRevisions.memoryKb,
          testCount: problemRevisions.testCount,
        })
        .from(problems)
        .leftJoin(problemRevisions, revisionJoin)
        .where(and(...conditions))
        .orderBy(asc(problems.id))
        .limit(page.limit + 1);
    }

    const pageRows = rows.slice(0, page.limit);
    const shown = pageRows.map((row) => row.id).filter((id) => !hidden.has(id));
    // One query each for the whole page — never one per row. Exactly the N+1
    // `testCount` was hoisted onto the summary to avoid, and the reason
    // `tags` and D49's counters live there too.
    const [tagsByProblem, countsByProblem] = await Promise.all([
      this.loadTagsByProblem(shown),
      this.loadCountsByProblem(shown),
    ]);
    const items = pageRows.map((row) =>
      hidden.has(row.id)
        ? toSummary(row, BLANK_HINT, BLANK_COUNTS)
        : toSummary(
            row,
            { tags: tagsByProblem.get(row.id) ?? [], difficulty: row.difficulty },
            countsByProblem.get(row.id) ?? BLANK_COUNTS,
          ),
    );
    const nextCursor = rows.length > page.limit ? String(items.at(-1)!.id) : null;
    return { items, nextCursor };
  }

  /**
   * The problem itself, and the package hash whose samples belong to it —
   * everything a `ProblemDetail` needs EXCEPT the samples.
   *
   * Split out of `getVisible` because `getStats` and `getEditorial` are both
   * built on it (each needs the 404 this route already decides, and the
   * cheapest way for two surfaces to agree about who may read a problem is
   * for one of them to BE the other). Neither renders a sample, and neither
   * should pay a Redis round trip — or, on a cold key, an archive inflate —
   * to answer a question about submission counts.
   */
  private async loadVisible(
    actor: Actor | null,
    code: string,
  ): Promise<{ detail: Omit<ProblemDetailDto, 'samples'>; packageHash: string | null }> {
    const revisionJoin = and(eq(problems.currentRevisionId, problemRevisions.id), eq(problemRevisions.state, 'published'));

    // Same shape as `listVisible`: one statement either way, the lateral
    // omitted entirely (not joined against a null user id) for an
    // anonymous caller.
    let row:
      | {
          id: number;
          code: string;
          name: string;
          statement: string;
          visibility: ProblemVisibility;
          sourceAccess: 'private' | 'solved';
          difficulty: number | null;
          editorial: string | null;
          editorialPublishedAt: Date | null;
          createdAt: Date;
          revisionId: number | null;
          publishedVersion: number | null;
          timeMs: number | null;
          memoryKb: number | null;
          testCount: number | null;
          totalPoints: number | null;
          checkerKind: string | null;
          packageHash: string | null;
          meVerdict?: string | null;
          mePoints?: number | null;
          meMaxPoints?: number | null;
        }
      | undefined;
    if (actor) {
      const meBest = this.bestSubmissionLateral(actor.userId);
      row = (
        await this.db
          .select({
            id: problems.id,
            code: problems.code,
            name: problems.name,
            statement: problems.statement,
            visibility: problems.visibility,
            sourceAccess: problems.sourceAccess,
            difficulty: problems.difficulty,
            editorial: problems.editorial,
            editorialPublishedAt: problems.editorialPublishedAt,
            createdAt: problems.createdAt,
            revisionId: problemRevisions.id,
            publishedVersion: problemRevisions.version,
            timeMs: problemRevisions.timeMs,
            memoryKb: problemRevisions.memoryKb,
            testCount: problemRevisions.testCount,
            totalPoints: problemRevisions.totalPoints,
            checkerKind: problemRevisions.checkerKind,
            packageHash: problemRevisions.packageHash,
            meVerdict: meBest.verdict,
            mePoints: meBest.points,
            meMaxPoints: meBest.maxPoints,
          })
          .from(problems)
          .leftJoin(problemRevisions, revisionJoin)
          .leftJoinLateral(meBest, sql`true`)
          .where(sql`lower(${problems.code}) = lower(${code})`)
          .limit(1)
      )[0];
    } else {
      row = (
        await this.db
          .select({
            id: problems.id,
            code: problems.code,
            name: problems.name,
            statement: problems.statement,
            visibility: problems.visibility,
            sourceAccess: problems.sourceAccess,
            difficulty: problems.difficulty,
            editorial: problems.editorial,
            editorialPublishedAt: problems.editorialPublishedAt,
            createdAt: problems.createdAt,
            revisionId: problemRevisions.id,
            publishedVersion: problemRevisions.version,
            timeMs: problemRevisions.timeMs,
            memoryKb: problemRevisions.memoryKb,
            testCount: problemRevisions.testCount,
            totalPoints: problemRevisions.totalPoints,
            checkerKind: problemRevisions.checkerKind,
            packageHash: problemRevisions.packageHash,
          })
          .from(problems)
          .leftJoin(problemRevisions, revisionJoin)
          .where(sql`lower(${problems.code}) = lower(${code})`)
          .limit(1)
      )[0];
    }

    // Same 404 for "absent" and "invisible" — a distinct code (or a 403)
    // would itself be an existence oracle for a problem the actor may not
    // see (spec §3, item 2).
    if (!row) throw new AppError(404, 'problem_not_found', 'No such problem.');

    const ctx = await loadProblemContext(this.db, actor, row.id);
    if (!canViewProblem(actor, { id: row.id, visibility: row.visibility }, ctx)) {
      throw new AppError(404, 'problem_not_found', 'No such problem.');
    }

    const { members, orgSlugs } = await this.loadMembersAndOrgs(row.id, actor, canEditProblem(actor, ctx));

    // D35: a tag is a hint, so both it and the difficulty are withheld from
    // a viewer sitting a running contest that uses this problem. Blanked to
    // `[]`/`null` — the same values an untagged, unrated problem returns —
    // rather than signalled, because a distinguishable "hidden" state would
    // itself confirm the problem is in the contest they are sitting.
    const hidden = await this.contestHiddenProblemIds(actor, [row.id]);
    const hint = hidden.has(row.id)
      ? BLANK_HINT
      : { tags: (await this.loadTagsByProblem([row.id])).get(row.id) ?? [], difficulty: row.difficulty };
    const counts = hidden.has(row.id)
      ? BLANK_COUNTS
      : ((await this.loadCountsByProblem([row.id])).get(row.id) ?? BLANK_COUNTS);
    const editorial = await this.resolveEditorial(actor, row, canEditProblem(actor, ctx), hidden.has(row.id));

    return {
      detail: {
        ...toSummary(row, hint, counts),
        ...editorial,
        statement: row.statement,
        // Not revision-derived, so unlike the three fields below it is never
        // nulled out on a problem whose only revision is a draft: the flag
        // lives on the problem itself and is meaningful before anything is
        // published.
        sourceAccess: row.sourceAccess,
        testCount: row.revisionId === null ? null : row.testCount,
        totalPoints: row.revisionId === null ? null : row.totalPoints,
        checkerKind: row.revisionId === null ? null : row.checkerKind,
        // Same guard, same reason (D92): the join carries `state = 'published'`,
        // so a pointer parked on an archived revision reads NULL here too.
        publishedVersion: row.revisionId === null ? null : row.publishedVersion,
        createdAt: row.createdAt.toISOString(),
        members,
        orgSlugs,
      },
      packageHash: row.revisionId === null ? null : row.packageHash,
    };
  }

  async getVisible(actor: Actor | null, code: string): Promise<ProblemDetailDto> {
    const { detail, packageHash } = await this.loadVisible(actor, code);
    return { ...detail, samples: await this.loadSamples(packageHash) };
  }

  /**
   * The published revision's samples (D94), folded once per package and
   * cached under its hash.
   *
   * **Every failure answers `[]`.** A missing blob, a package whose manifest
   * this build cannot parse, a Redis that is down — none of them are reasons
   * to fail the request that renders the problem statement. The samples are a
   * convenience laid on top of the statement, which still carries its own
   * example table; a problem page that 500s because a volume was unhappy
   * would be a strictly worse outcome than one whose extra section is
   * missing. The throw happens INSIDE `through`'s fold, so a failed read is
   * never written to the cache and the next request tries again.
   */
  private async loadSamples(packageHash: string | null): Promise<ProblemSampleDto[]> {
    if (packageHash === null) return [];
    try {
      const { value } = await this.cache.through(
        samplesCacheKey(packageHash),
        async () => readPackageSamples(await this.store.get(packageHash)),
        SAMPLES_CACHE_TTL_MS,
      );
      return value;
    } catch (error) {
      this.logger.warn(
        `could not read samples from package ${packageHash}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return [];
    }
  }

  /**
   * `GET /problems/{code}/stats` — D49.
   *
   * Built on `getVisible`, like `getEditorial` and for the same reason: the
   * two surfaces must agree about who may read this problem at all, and the
   * cheapest way to guarantee that is for one of them to BE the other. The
   * problem's own 404 therefore lands first, so this route is no more of an
   * existence oracle than the detail route already is.
   *
   * The cached object is the TRUE one and the D35 mask is applied on the way
   * out. Caching the masked version would need the viewer in the key; masking
   * after the read keeps one key per problem and still hands a viewer sitting
   * a running contest exactly the shape a problem nobody has attempted
   * returns — blanked, never signalled.
   */
  async getStats(
    actor: Actor | null,
    code: string,
  ): Promise<{ stats: ProblemStatsDto; cache: ScoreboardCacheState }> {
    const { detail } = await this.loadVisible(actor, code);
    const hidden = await this.contestHiddenProblemIds(actor, [detail.id]);
    const { value, cache } = await this.cache.through(
      `${STATS_CACHE_PREFIX}:${String(detail.id)}`,
      () => this.computeStats(detail.id),
      STATS_CACHE_TTL_MS,
    );
    // Read first, mask second — even for a viewer who will be handed
    // nothing. Short-circuiting ahead of the cache would make the
    // `X-Stats-Cache` header lie about a read that did not happen, and it
    // would let the D35 mask decide what is stored, which is how a masked
    // answer ends up cached for everybody.
    return { stats: hidden.has(detail.id) ? blankStats() : value, cache };
  }

  /**
   * Five aggregates over one problem's submissions, all filtered by the same
   * D49 predicate: a submission counts only once its contest participation
   * window has closed.
   *
   * Every one of them is served by `submissions_problem_user_verdict_idx`
   * (migration 0022) — `(problem_id, user_id, verdict)`, which is the group
   * key, the DISTINCT key and the filter, in that order.
   */
  private async computeStats(problemId: number): Promise<ProblemStatsDto> {
    // ONE clock for the whole computation: five queries asking "is that
    // window still open" of five different instants could disagree at a
    // boundary, and the entry they are cached under would be internally
    // inconsistent for a full TTL.
    const settled = and(
      eq(submissions.problemId, problemId),
      sql`not ${contestWindowOpenWhere(new Date())}`,
    );

    const totalsQuery = this.db
      .select({
        total: sql<number>`count(*)::int`,
        accepted: sql<number>`count(*) filter (where ${submissions.verdict} = 'AC')::int`,
        attempted: sql<number>`count(distinct ${submissions.userId})::int`,
        solved: sql<number>`count(distinct ${submissions.userId}) filter (where ${submissions.verdict} = 'AC')::int`,
      })
      .from(submissions)
      .where(settled);

    const verdictsQuery = this.db
      .select({ key: submissions.verdict, count: sql<number>`count(*)::int` })
      .from(submissions)
      .where(and(settled, isNotNull(submissions.verdict)))
      .groupBy(submissions.verdict)
      .orderBy(sql`count(*) desc`, asc(submissions.verdict));

    const languagesQuery = this.db
      .select({ key: schema.languages.key, count: sql<number>`count(*)::int` })
      .from(submissions)
      .innerJoin(schema.languages, eq(schema.languages.id, submissions.languageId))
      .where(settled)
      .groupBy(schema.languages.key)
      .orderBy(sql`count(*) desc`, asc(schema.languages.key));

    // One row per person — their own fastest AC — so a student who submits
    // the same solution eleven times cannot own the whole table. `DISTINCT
    // ON` picks that row inside, and the outer select re-sorts the winners
    // against each other; doing the second sort in JavaScript would drag
    // every solver's best row out of the database to keep ten of them.
    const best = this.db
      .selectDistinctOn([submissions.userId], {
        id: submissions.id,
        username: schema.users.username,
        timeMs: submissions.timeMs,
        memoryKb: submissions.memoryKb,
        createdAt: submissions.createdAt,
      })
      .from(submissions)
      .innerJoin(schema.users, eq(schema.users.id, submissions.userId))
      .where(and(settled, eq(submissions.verdict, 'AC'), isNotNull(submissions.timeMs)))
      .orderBy(asc(submissions.userId), asc(submissions.timeMs), asc(submissions.id))
      .as('best');
    const fastestQuery = this.db
      .select()
      .from(best)
      .orderBy(asc(best.timeMs), asc(best.id))
      .limit(FASTEST_LIMIT);

    const firstQuery = this.db
      .select({
        id: submissions.id,
        username: schema.users.username,
        createdAt: submissions.createdAt,
      })
      .from(submissions)
      .innerJoin(schema.users, eq(schema.users.id, submissions.userId))
      .where(and(settled, eq(submissions.verdict, 'AC')))
      .orderBy(asc(submissions.createdAt), asc(submissions.id))
      .limit(1);

    const [totals, verdicts, languages, fastest, first] = await Promise.all([
      totalsQuery,
      verdictsQuery,
      languagesQuery,
      fastestQuery,
      firstQuery,
    ]);
    const totalsRow = totals[0] ?? { total: 0, accepted: 0, attempted: 0, solved: 0 };
    const firstRow = first[0];

    return {
      totalSubmissions: totalsRow.total,
      attemptedUsers: totalsRow.attempted,
      solvedUsers: totalsRow.solved,
      // `null`, never `0`: "nobody has tried" is not "nobody succeeded", and
      // a 0 % on an untouched problem reads as a warning it has not earned.
      acceptanceRate: totalsRow.total === 0 ? null : totalsRow.accepted / totalsRow.total,
      verdicts: verdicts.map((row) => ({ key: row.key!, count: row.count })),
      languages: languages.map((row) => ({ key: row.key, count: row.count })),
      fastest: fastest.map((row) => ({
        submissionId: row.id,
        username: row.username,
        timeMs: row.timeMs!,
        memoryKb: row.memoryKb,
        createdAt: row.createdAt.toISOString(),
      })),
      firstSolver:
        firstRow === undefined
          ? null
          : {
              submissionId: firstRow.id,
              username: firstRow.username,
              createdAt: firstRow.createdAt.toISOString(),
            },
    };
  }

  /**
   * `attemptedCount`/`solvedCount`, one cached entry per problem (D49 as
   * amended by B-9).
   *
   * **Why this is no longer one grouped query, and no longer uncached.** D49
   * ruled it out on the reasoning that "a page's ids differ from request to
   * request, so a cache would be keyed on the set rather than on a problem
   * and would miss almost always". The premise is exactly right; the
   * conclusion only follows for a key over the SET. Keyed on a PROBLEM, a
   * page of fifty problems nobody has ever requested together is still fifty
   * hits, and the detail route and the list route warm each other's entries.
   *
   * The cost D49 could not see, because it is invisible at fixture scale:
   * with 200 000 submissions against one problem the aggregate reads 200 000
   * index rows and 201 620 buffers in **126 ms**, uncached, on the two most
   * public routes in the app — and that measurement had no contests, so the
   * `NOT EXISTS` below collapsed instead of probing once per row. It is a
   * floor. Migration 0022's index is what keeps this an index scan rather
   * than a sequential one; nothing keeps it from being an index scan over
   * every submission the problem has ever had.
   *
   * **The statement count did not go up — it went down.** Caching a page by
   * calling a read-through helper once per row would turn D49's single
   * grouped aggregate into one round trip per problem, which is precisely
   * the N+1 the catalogue endpoints exist to avoid and which
   * `problem-me-verdict.spec.ts` pins against. So `throughMany` gathers the
   * misses and computes them TOGETHER: one aggregate on a cold page, none on
   * a warm one, never one per row.
   *
   * **No `X-…-Cache` header**, unlike D25's precedent and `getStats`. A page
   * mixes hits and misses per problem, so a single boolean would have to lie
   * about one of them; a header per problem is not a thing HTTP offers.
   *
   * The mask stays outside: every caller checks `contestHiddenProblemIds`
   * and hands back `BLANK_COUNTS` without reaching this method, so what is
   * stored is always the TRUE count — D49's own rule for the stats cache,
   * and the reason a masked answer can never be cached for everybody.
   */
  private async loadCountsByProblem(problemIds: number[]): Promise<Map<number, ProblemCounts>> {
    if (problemIds.length === 0) return new Map();
    // ONE clock for the page, for `computeStats`'s reason: two problems on
    // the same screen asking "is that window still open" of two different
    // instants could disagree at a boundary.
    const now = new Date();
    return this.cache.throughMany(
      problemIds,
      (id) => `${COUNTS_CACHE_PREFIX}:${String(id)}`,
      (missing) => this.computeCounts(missing, now),
      COUNTS_CACHE_TTL_MS,
    );
  }

  /**
   * D49's two counters for a set of problems, in one grouped aggregate,
   * filtered by the same predicate the statistics use: a submission counts
   * only once its contest participation window has closed.
   *
   * **Every id asked about gets a row, including the ones with no
   * submissions at all.** The aggregate cannot return a group for a problem
   * with no rows, and an absent id would never be cached — so the one
   * problem a setter reloads constantly, the empty one they are still
   * writing, would be the only problem in the catalogue that recomputes on
   * every read. Zeros are an answer, and they are cached like any other.
   */
  private async computeCounts(problemIds: number[], now: Date): Promise<Map<number, ProblemCounts>> {
    const rows = await this.db
      .select({
        problemId: submissions.problemId,
        attempted: sql<number>`count(distinct ${submissions.userId})::int`,
        solved: sql<number>`count(distinct ${submissions.userId}) filter (where ${submissions.verdict} = 'AC')::int`,
      })
      .from(submissions)
      .where(and(inArray(submissions.problemId, problemIds), sql`not ${contestWindowOpenWhere(now)}`))
      .groupBy(submissions.problemId);
    const counted = new Map<number, ProblemCounts>(
      problemIds.map((id) => [id, { attemptedCount: 0, solvedCount: 0 }]),
    );
    for (const row of rows) {
      counted.set(row.problemId, { attemptedCount: row.attempted, solvedCount: row.solved });
    }
    return counted;
  }

  /**
   * `GET /problems/{code}/editorial` — the editorial as Markdown, or 404.
   *
   * Deliberately built on `getVisible` rather than on its own query: the two
   * surfaces must agree about who may read an editorial, and the cheapest
   * way to guarantee that is for one of them to BE the other. It also fixes
   * the gate order for free — the problem's own visibility is decided first
   * and answers `problem_not_found`, so this route is no more of an
   * existence oracle than `GET /problems/{code}` already is.
   *
   * `editorial_not_found` is a distinct code from `problem_not_found`, and
   * that leaks nothing: reaching it means the caller can already see the
   * problem, which they could confirm from the detail route anyway. What
   * would leak is distinguishing *within* this refusal — absent,
   * unpublished and withheld share one code and one message.
   */
  async getEditorial(actor: Actor | null, code: string): Promise<EditorialResponseDto> {
    const { detail } = await this.loadVisible(actor, code);
    if (detail.editorial === null) {
      throw new AppError(404, 'editorial_not_found', 'This problem has no editorial you can read.');
    }
    return { markdown: detail.editorial };
  }

  /**
   * Inserts the problem, its creator as `author`, and any `orgSlugs`, all in
   * one transaction. `orgSlugs` are resolved to ids *before* the transaction
   * opens so an unknown slug fails the whole request rather than half-apply.
   * A racing duplicate `code` (case-insensitively) is caught as the unique
   * violation on `problems_code_lower_idx` and rethrown as
   * `problem_code_taken` — never pre-checked with a SELECT, which races.
   */
  async create(actor: Actor | null, body: CreateProblemInput): Promise<ProblemDetailDto> {
    if (!actor || !canCreateProblem(actor)) {
      throw new AppError(403, 'problem_forbidden', 'You may not create problems.');
    }

    // `private`, matching `CreateProblemRequest`'s zod default. These two
    // defaults must agree: over HTTP the zod default always wins and this
    // fallback is unreachable, but a direct caller — a test, a seed script, a
    // future import tool — reaches it, and the two disagreeing meant such a
    // caller silently published a problem to the world. Deny-by-default is
    // the direction to be wrong in.
    const visibility = body.visibility ?? 'private';
    if (visibility === 'org' && !(body.orgSlugs && body.orgSlugs.length > 0)) {
      throw new AppError(400, 'problem_org_required', 'An org-visible problem needs at least one organization.');
    }

    const orgIds = await this.resolveOrgIds(actor, body.orgSlugs ?? []);

    let problemId: number;
    try {
      problemId = await this.db.transaction(async (tx) => {
        const [problem] = await tx
          .insert(problems)
          .values({
            code: body.code,
            name: body.name,
            statement: body.statement,
            visibility,
            createdBy: actor.userId,
          })
          .returning({ id: problems.id });
        await tx.insert(problemMembers).values({ problemId: problem!.id, userId: actor.userId, role: 'author' });
        if (orgIds.length > 0) {
          await tx.insert(problemOrgs).values(orgIds.map((orgId) => ({ problemId: problem!.id, orgId })));
        }
        return problem!.id;
      });
    } catch (error) {
      throw toCreateConflict(error);
    }

    return this.loadDetailById(problemId, actor);
  }

  /**
   * Creates a new problem seeded from an existing one (D88).
   *
   * **What is copied** is what makes the next problem: the statement, the
   * editorial, the tags, the difficulty, and the current PUBLISHED
   * revision's package as revision 1. **What is not** is everything that
   * describes how the source has been used or who else is involved with it —
   * submissions, statistics, membership, organization shares — and every
   * publication decision: the copy is `private`, its revision is a `draft`,
   * and its editorial is unpublished no matter what the source's was. A
   * clone is the first draft of a new problem, not a second copy of a live
   * one.
   *
   * **Two permissions, not one.** `loadForEdit` first, so the caller must be
   * able to EDIT the source: a clone hands them its unpublished editorial
   * and the whole test set, and a mere reader of a public problem may see
   * neither. Then `canCreateProblem`, because this mints a problem and a
   * setter who was demoted must not keep a side door that does. Both answer
   * `problem_forbidden`, and an invisible source still 404s first.
   *
   * Revision 1 is the source ROW copied, not an `attachRevision` call: a
   * package is content-addressed, so the new revision points at the very
   * same stored bytes and there is nothing to upload, re-hash or re-verify.
   * A source with no published revision simply clones without one.
   */
  async clone(actor: Actor | null, code: string, input: CloneProblemInput): Promise<ProblemDetailDto> {
    const { problem: row } = await this.loadForEdit(actor, code);
    if (!actor || !canCreateProblem(actor)) {
      throw new AppError(403, 'problem_forbidden', 'You may not create problems.');
    }

    const source = (
      await this.db
        .select({
          name: problems.name,
          statement: problems.statement,
          editorial: problems.editorial,
          difficulty: problems.difficulty,
        })
        .from(problems)
        .where(eq(problems.id, row.id))
        .limit(1)
    )[0]!;

    const tagIds = (
      await this.db.select({ tagId: problemTags.tagId }).from(problemTags).where(eq(problemTags.problemId, row.id))
    ).map((t) => t.tagId);

    // The PUBLISHED revision, by state rather than through
    // `currentRevisionId`: the two agree, and `state` is the column the rest
    // of this service treats as authoritative (see `loadProblemRows`).
    const published = (
      await this.db
        .select({
          packageHash: problemRevisions.packageHash,
          timeMs: problemRevisions.timeMs,
          memoryKb: problemRevisions.memoryKb,
          testCount: problemRevisions.testCount,
          totalPoints: problemRevisions.totalPoints,
          checkerKind: problemRevisions.checkerKind,
        })
        .from(problemRevisions)
        .where(and(eq(problemRevisions.problemId, row.id), eq(problemRevisions.state, 'published')))
        .limit(1)
    )[0];

    let cloneId: number;
    try {
      cloneId = await this.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(problems)
          .values({
            code: input.newCode,
            name: input.newName ?? source.name,
            statement: source.statement,
            // Carried, but never carried as PUBLISHED: the source's readers
            // were let in by its author, and cloning is not that decision
            // being made again by someone else.
            editorial: source.editorial,
            difficulty: source.difficulty,
            visibility: 'private',
            createdBy: actor.userId,
          })
          .returning({ id: problems.id });
        await tx.insert(problemMembers).values({ problemId: created!.id, userId: actor.userId, role: 'author' });
        if (tagIds.length > 0) {
          await tx.insert(problemTags).values(tagIds.map((tagId) => ({ problemId: created!.id, tagId })));
        }
        if (published) {
          await tx.insert(problemRevisions).values({
            problemId: created!.id,
            version: 1,
            packageHash: published.packageHash,
            state: 'draft',
            createdBy: actor.userId,
            notes: null,
            timeMs: published.timeMs,
            memoryKb: published.memoryKb,
            testCount: published.testCount,
            totalPoints: published.totalPoints,
            checkerKind: published.checkerKind,
          });
        }
        return created!.id;
      });
    } catch (error) {
      // The same unique violation on `problems_code_lower_idx` `create`
      // turns into 409 `problem_code_taken` — never pre-checked with a
      // SELECT, which races.
      throw toCreateConflict(error);
    }

    return this.loadDetailById(cloneId, actor);
  }

  /**
   * Loads the problem, then — in this exact order — (1) `canViewProblem`
   * false → 404 (an invisible problem never discloses existence, not even
   * via a distinct error for a malformed patch), (2) `canEditProblem` false
   * → 403, (3) validates the patch, (4) applies it in one transaction.
   * `members` and `orgSlugs`, when present in the patch, replace the whole
   * set rather than merging with what is already there.
   */
  async update(actor: Actor | null, code: string, patch: UpdateProblemPatch): Promise<ProblemDetailDto> {
    const { problem: row, ctx } = await this.loadForEdit(actor, code);

    // --- validate the patch ---
    if ('code' in patch) {
      throw new AppError(400, 'problem_code_immutable', "A problem's code cannot be changed.");
    }

    if (patch.members && !patch.members.some((m) => m.role === 'author')) {
      throw new AppError(400, 'problem_last_author', 'A problem must always have at least one author.');
    }

    // Resolve usernames/slugs to ids before the transaction, so a bad
    // request never half-applies. `actor!`: `loadForEdit` already threw 403
    // for a null actor before returning, so this is non-null past that
    // point — TypeScript just can't see that across the method boundary.
    //
    // `resolveOrgIds`'s third argument — `ctx.sharedOrgIds`, the problem's
    // CURRENT org ids, already loaded by `loadForEdit` — is what makes this
    // a whole-set *replacement* rather than a whole-set *re-grant*. Two
    // rules were once wrongly fused into one membership check applied to
    // every requested slug: "you may not SHARE with a group you don't
    // belong to" (security) and "you may not silently UNSHARE a group you
    // can't see" (safety). Only the first is actually about membership. An
    // org already attached may always be retained by any editor, member or
    // not — see `resolveOrgIds`'s doc comment for why requiring membership
    // on retention made the only PATCH a locked-out editor could get
    // accepted the one that silently dropped an org they never chose to
    // remove.
    const memberRows = patch.members ? await this.resolveMemberIds(patch.members) : undefined;
    const orgIds = patch.orgSlugs
      ? await this.resolveOrgIds(actor!, patch.orgSlugs, new Set(ctx.sharedOrgIds))
      : undefined;
    // Resolved here, outside the transaction, for the same reason the two
    // above are: an unknown slug must fail the whole PATCH rather than let
    // the name change land and the tags not.
    const tagIds = patch.tags ? await this.resolveTagIds(patch.tags) : undefined;

    // The text this PATCH leaves behind: what it carries if it says
    // anything about the editorial, otherwise what is already stored.
    // Publishing is a claim that there is something to read, so it is
    // refused when there would not be — including for whitespace, which
    // renders as an empty page rather than as a solution. The database's
    // `problems_editorial_published_ck` is the backstop for a writer that
    // never passes through here; this is the error a setter can act on.
    const effectiveEditorial = patch.editorial !== undefined ? patch.editorial : row.editorial;
    if (patch.editorialPublished === true && (effectiveEditorial === null || effectiveEditorial.trim() === '')) {
      throw new AppError(
        422,
        'problem_editorial_empty',
        'There is no editorial to publish. Send `editorial` with the write-up in the same request.',
      );
    }

    const effectiveVisibility = patch.visibility ?? row.visibility;
    if (effectiveVisibility === 'org') {
      const orgCount =
        orgIds !== undefined
          ? orgIds.length
          : (
              await this.db
                .select({ orgId: problemOrgs.orgId })
                .from(problemOrgs)
                .where(eq(problemOrgs.problemId, row.id))
            ).length;
      if (orgCount === 0) {
        throw new AppError(400, 'problem_org_required', 'An org-visible problem needs at least one organization.');
      }
    }

    // --- apply ---
    await this.db.transaction(async (tx) => {
      const set: Partial<typeof problems.$inferInsert> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.statement !== undefined) set.statement = patch.statement;
      if (patch.visibility !== undefined) set.visibility = patch.visibility;
      // No extra authorization of its own: reaching here already required
      // `canEditProblem` (an author, a curator or an admin), which is
      // exactly the set design §2 lets read the problem's submissions
      // anyway. A separate rule for who may OPEN source access would let
      // someone edit a problem they cannot read the submissions of, or the
      // reverse — neither is a state the table describes.
      if (patch.sourceAccess !== undefined) set.sourceAccess = patch.sourceAccess;
      // `!== undefined`, not a truthiness test: `difficulty: null` is a
      // request to CLEAR the estimate and an omitted key is a request to
      // leave it, and `!patch.difficulty` would collapse the two (and treat
      // a hypothetical 0 as absent besides).
      if (patch.difficulty !== undefined) set.difficulty = patch.difficulty;
      if (patch.editorial !== undefined) {
        set.editorial = patch.editorial;
        // Clearing the text takes the publication with it, in the same
        // UPDATE. Not a convenience: the CHECK forbids the alternative
        // outright, and a publish date pointing at nothing would mean an
        // `editorialAvailable: true` promising a page that renders empty.
        if (patch.editorial === null) set.editorialPublishedAt = null;
      }
      // After the `editorial` branch, so an explicit `editorialPublished`
      // wins over the implicit unpublish above. The one combination where
      // they genuinely conflict — clearing the text while publishing it —
      // was already refused as `problem_editorial_empty`.
      if (patch.editorialPublished !== undefined) {
        // `?? new Date()`, not a fresh timestamp every time: re-publishing
        // what is already published is not a new publication, and moving
        // the date would rewrite when readers were first allowed in.
        set.editorialPublishedAt = patch.editorialPublished ? (row.editorialPublishedAt ?? new Date()) : null;
      }
      if (Object.keys(set).length > 0) {
        await tx.update(problems).set(set).where(eq(problems.id, row.id));
      }

      if (memberRows) {
        await tx.delete(problemMembers).where(eq(problemMembers.problemId, row.id));
        if (memberRows.length > 0) {
          await tx
            .insert(problemMembers)
            .values(memberRows.map((m) => ({ problemId: row.id, userId: m.userId, role: m.role })));
        }
      }

      if (orgIds) {
        await tx.delete(problemOrgs).where(eq(problemOrgs.problemId, row.id));
        if (orgIds.length > 0) {
          await tx.insert(problemOrgs).values(orgIds.map((orgId) => ({ problemId: row.id, orgId })));
        }
      }

      // Whole-set replacement, like `members` and `orgSlugs` above — never a
      // merge. `tags: []` therefore means "carry no tags", which is the only
      // way to remove the last one.
      if (tagIds) {
        await tx.delete(problemTags).where(eq(problemTags.problemId, row.id));
        if (tagIds.length > 0) {
          await tx.insert(problemTags).values(tagIds.map((tagId) => ({ problemId: row.id, tagId })));
        }
      }
    });

    return this.loadDetailById(row.id, actor);
  }

  /**
   * Attaches an already-uploaded package to a problem as a new draft
   * revision, denormalising the manifest's grading-relevant fields onto the
   * revision row (spec §5.1) so every read of a revision's limits is a plain
   * column, never a re-parse of the archive.
   *
   * `package_files` (not the archive, and not `PackageStore.has`) is the
   * authority on whether the package exists: a hash with no rows is
   * `package_not_found` even if orphaned bytes happen to survive in the
   * store, and the collision check below runs over the exact list the hash
   * was computed over — no unpack, no scratch directory. The manifest,
   * though, is genuinely not in the database, so that one file's bytes are
   * read straight out of the archive with `readArchiveEntry`.
   */
  async attachRevision(
    actor: Actor | null,
    code: string,
    input: AttachRevisionInput,
  ): Promise<AttachRevisionResult> {
    const { problem } = await this.loadForEdit(actor, code);
    // `loadForEdit` throws 403 for a null actor before returning, so `actor`
    // is guaranteed non-null past this point — TypeScript just can't see
    // that across the method boundary.
    const authorId = actor!.userId;

    const paths = await this.db
      .select({ path: schema.packageFiles.path })
      .from(schema.packageFiles)
      .where(eq(schema.packageFiles.packageHash, input.packageHash));
    if (paths.length === 0) {
      throw new AppError(404, 'package_not_found', 'No such package.');
    }
    const collision = findPathCollision(paths);
    if (collision) {
      const [a, b] = collision;
      throw new AppError(
        422,
        'package_path_collision',
        `Paths "${a}" and "${b}" collide on a case-insensitive or normalising filesystem.`,
      );
    }

    const entry = await readArchiveEntry(await this.store.get(input.packageHash), 'manifest.json');
    if (!entry) {
      throw new AppError(400, 'package_invalid', 'Package has no manifest.json.');
    }
    let manifest: PackageManifestDto;
    try {
      manifest = parseManifest(JSON.parse(entry.toString('utf8')));
    } catch (error) {
      throw new AppError(400, 'package_invalid', error instanceof Error ? error.message : 'Invalid package manifest.');
    }

    // Does the manifest describe THIS package? `parseManifest` validates the
    // shape of a path and can say nothing about whether it names anything;
    // `paths` above is the authoritative list of what the package actually
    // holds, and the two were never compared. A revision whose manifest
    // points at a test answer or a checker source that was never shipped is
    // not a revision that grades badly — it is one that cannot grade, and it
    // discovers this on a judge, mid-grade, against a submission that did
    // nothing wrong. Refused here, it is a message the setter can act on.
    const missing = findMissingPackageFiles(manifest, paths);
    if (missing.length > 0) {
      throw new AppError(
        400,
        'package_invalid',
        `The manifest names files this package does not contain: ${missing.join(', ')}.`,
      );
    }

    // Two concurrent attaches can both read the same `max(version)` and both
    // try to insert the same next version. Catching the unique-violation
    // Postgres would raise on `problem_revisions_version_idx` (Task 1) would
    // work, but it aborts the enclosing transaction — poisoning every
    // statement after it on the same connection, including the retry's own
    // `maxVersion` read (this matters for tests, which run inside one
    // transaction via `withTestDb`; it is also just simpler in production).
    // `onConflictDoNothing` sidesteps that: it never raises, so a lost race
    // is just an empty `returning()`, and the loop reads a fresh version and
    // tries again.
    for (let attempt = 0; attempt < 5; attempt++) {
      const next = (await this.maxVersion(problem.id)) + 1;
      const inserted = await this.db
        .insert(problemRevisions)
        .values({
          problemId: problem.id,
          version: next,
          packageHash: input.packageHash,
          state: 'draft',
          createdBy: authorId,
          notes: input.notes ?? null,
          timeMs: manifest.limits.timeMs,
          memoryKb: manifest.limits.memoryKb,
          testCount: manifest.tests.length,
          totalPoints: manifest.tests.reduce((sum, t) => sum + t.points, 0),
          checkerKind: manifest.checker.kind,
        })
        .onConflictDoNothing({ target: [problemRevisions.problemId, problemRevisions.version] })
        .returning({ version: problemRevisions.version });
      if (inserted.length > 0) {
        return { version: inserted[0]!.version };
      }
    }
    throw new AppError(409, 'revision_conflict', 'Too many concurrent attaches.');
  }

  /**
   * Publishes a revision by version, archiving whatever was previously
   * published and repointing `problems.currentRevisionId` at it — all in one
   * transaction. Reuses `loadForEdit` for the 404-then-403 ordering: an
   * invisible problem 404s, a visible-but-uneditable one (a tester, say)
   * 403s, exactly as `attachRevision` does.
   *
   * The target lookup and every write live inside the transaction, including
   * the 404 for an unknown version: throwing there rolls the transaction
   * back and rethrows, so a bad version never leaves a half-applied archive.
   *
   * Archiving the previously-published revision (if any) is unconditional
   * except when the target is *already* published, which makes re-publishing
   * the current revision a no-op rather than a special case: nothing to
   * archive, nothing to flip, `currentRevisionId` gets set to the value it
   * already had. Publishing an `archived` revision is exactly "publish a
   * revision that happens to have `state: 'archived'`" — the same branch
   * that handles a `draft` runs, archiving whatever is currently published
   * (including the revision that was published a moment ago) and republishing
   * the target. This is the rollback path.
   *
   * Safe to archive the previous revision because `submissions.revisionId`
   * pins the revision that graded each submission at creation time — an
   * archived row stays referenced and readable forever, never touched here.
   *
   * The `SELECT ... FOR UPDATE` on the problem row is load-bearing, not
   * decorative: under READ COMMITTED (this project's default, unmodified
   * anywhere), two concurrent publishes targeting *different* not-yet-
   * published revisions of the same problem would otherwise see no lock
   * contention at all — each transaction's archive step only matches rows
   * already published in its own snapshot, so neither sees the other's
   * uncommitted target, and both could commit with two revisions left
   * `published`. The lock serialises publishes per problem so that race
   * cannot happen; `problem_revisions_one_published_idx` (a partial unique
   * index on `problem_id` where `state = 'published'`) is the second half of
   * the pairing, guarding the invariant even if some future caller forgets
   * the lock — the same belt-and-suspenders Task 1 used for
   * `(problemId, version)`. Archive-then-publish ordering below matters for
   * that index: Postgres checks a unique index per-statement, not at commit,
   * so archiving the old row before publishing the new one means there is
   * never a moment inside this transaction where two rows are `published`
   * for one problem.
   */
  async publishRevision(actor: Actor | null, code: string, version: number): Promise<PublishRevisionResult> {
    const { problem } = await this.loadForEdit(actor, code);

    return this.db.transaction(async (tx) => {
      // Locks the problem row so a concurrent publish on the same problem
      // blocks here until this transaction commits or rolls back — see the
      // method doc for why this is required, not optional.
      await tx.select({ id: problems.id }).from(problems).where(eq(problems.id, problem.id)).for('update');

      const target = (
        await tx
          .select({ id: problemRevisions.id, state: problemRevisions.state })
          .from(problemRevisions)
          .where(and(eq(problemRevisions.problemId, problem.id), eq(problemRevisions.version, version)))
          .limit(1)
      )[0];
      if (!target) throw new AppError(404, 'revision_not_found', 'No such revision.');

      if (target.state !== 'published') {
        // Archive before publish: a unique index enforces "at most one
        // published revision per problem" per-statement, so this order never
        // has both rows published inside the same statement.
        await tx
          .update(problemRevisions)
          .set({ state: 'archived' })
          .where(and(eq(problemRevisions.problemId, problem.id), eq(problemRevisions.state, 'published')));
        await tx.update(problemRevisions).set({ state: 'published' }).where(eq(problemRevisions.id, target.id));
      }
      await tx.update(problems).set({ currentRevisionId: target.id }).where(eq(problems.id, problem.id));
      return { version };
    });
  }

  /**
   * Lists every revision of a problem — draft, published and archived alike
   * — for a member (any role) or an admin. Everyone else gets 404, the same
   * code `getVisible` uses for an invisible problem: unlike `canViewProblem`,
   * `canViewRevisions` does not grant access on public/org visibility alone,
   * so a plain user 404s here even on a problem whose statement they can
   * read (spec §3, item 2 — a read never 403s, it 404s).
   */
  async listRevisions(actor: Actor | null, code: string): Promise<RevisionSummaryDto[]> {
    const row = await this.findProblemRow(code);
    const ctx = await loadProblemContext(this.db, actor, row.id);
    if (!canViewRevisions(actor, ctx)) {
      throw new AppError(404, 'problem_not_found', 'No such problem.');
    }

    const rows = await this.db
      .select({
        id: problemRevisions.id,
        version: problemRevisions.version,
        state: problemRevisions.state,
        packageHash: problemRevisions.packageHash,
        notes: problemRevisions.notes,
        timeMs: problemRevisions.timeMs,
        memoryKb: problemRevisions.memoryKb,
        testCount: problemRevisions.testCount,
        totalPoints: problemRevisions.totalPoints,
        checkerKind: problemRevisions.checkerKind,
        createdBy: problemRevisions.createdBy,
        createdAt: problemRevisions.createdAt,
      })
      .from(problemRevisions)
      .where(eq(problemRevisions.problemId, row.id))
      .orderBy(asc(problemRevisions.version));

    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  }

  /**
   * The public face of `loadForEdit`: the problem row, once the actor has
   * been shown to be allowed to edit it — 404 for a problem they may not
   * see, 403 for one they may see but not edit, in that order.
   *
   * Exists for D87's draft endpoints, which are authoring surface on a
   * problem but do not themselves touch a revision, so they have no other
   * call into this service to inherit the ordering from. A second
   * hand-rolled copy of "may this actor edit this problem" is exactly how
   * `PATCH /problems/{code}` and a sibling route come to disagree.
   */
  async loadEditableProblem(actor: Actor | null, code: string): Promise<{ id: number }> {
    const { problem } = await this.loadForEdit(actor, code);
    return { id: problem.id };
  }

  /**
   * One revision of a problem the actor may edit, by version — the package
   * hash and nothing else.
   *
   * Beside `loadEditableProblem` and for the same reason (D88): reading a
   * revision's test data BACK into a draft is authoring surface, so it needs
   * `PATCH /problems/{code}`'s exact 404-then-403 ordering, and a second
   * hand-rolled copy of it is how two authoring routes come to disagree
   * about who may see a private problem's tests.
   *
   * Any version, not only the published one. The revisions screen already
   * lists draft and archived revisions to exactly this set of people, and
   * "start from the version before the one I broke" is the rollback story
   * `publishRevision` already supports from the other end.
   */
  async loadEditableRevision(
    actor: Actor | null,
    code: string,
    version: number,
  ): Promise<{ problemId: number; packageHash: string }> {
    const { problem } = await this.loadForEdit(actor, code);
    const row = (
      await this.db
        .select({ packageHash: problemRevisions.packageHash })
        .from(problemRevisions)
        .where(and(eq(problemRevisions.problemId, problem.id), eq(problemRevisions.version, version)))
        .limit(1)
    )[0];
    if (!row) throw new AppError(404, 'revision_not_found', 'No such revision.');
    return { problemId: problem.id, packageHash: row.packageHash };
  }

  /**
   * Loads a problem's `{ id, visibility }` by code, 404ing if no problem has
   * that code (case-insensitively) — the first half of the 404-then-403
   * ordering every write path needs. Split out of `loadForEdit` so
   * `listRevisions`, which needs the same lookup but a different permission
   * check (never a 403 — spec §3, item 2), does not duplicate it.
   */
  private async findProblemRow(code: string): Promise<EditableProblemRow> {
    const row = (
      await this.db
        .select({
          id: problems.id,
          visibility: problems.visibility,
          // Carried on every edit path, not fetched separately: `update`
          // needs the STORED editorial to decide whether a patch that only
          // says `editorialPublished: true` has any text to publish, and a
          // second SELECT for it would be a second answer to the same
          // question one statement later.
          editorial: problems.editorial,
          editorialPublishedAt: problems.editorialPublishedAt,
        })
        .from(problems)
        .where(sql`lower(${problems.code}) = lower(${code})`)
        .limit(1)
    )[0];
    if (!row) throw new AppError(404, 'problem_not_found', 'No such problem.');
    return row;
  }

  /**
   * Loads a problem by code and applies the shared 404-then-403 ordering
   * every write path against an existing problem needs: an invisible problem
   * 404s (spec §3, item 2 — never a distinct error for "exists but you may
   * not act on it"), then a visible-but-uneditable problem 403s. Shared by
   * `update`, `attachRevision` and `publishRevision` so the ordering can only
   * drift by editing one place.
   */
  private async loadForEdit(
    actor: Actor | null,
    code: string,
  ): Promise<{ problem: EditableProblemRow; ctx: ProblemViewContext }> {
    const row = await this.findProblemRow(code);

    const ctx = await loadProblemContext(this.db, actor, row.id);
    if (!canViewProblem(actor, { id: row.id, visibility: row.visibility }, ctx)) {
      throw new AppError(404, 'problem_not_found', 'No such problem.');
    }
    if (!actor || !canEditProblem(actor, ctx)) {
      throw new AppError(403, 'problem_forbidden', 'You may not edit this problem.');
    }
    return { problem: row, ctx };
  }

  /** The highest existing revision version for a problem, or 0 if it has none. */
  private async maxVersion(problemId: number): Promise<number> {
    const [row] = await this.db
      .select({ max: sql<number | null>`max(${problemRevisions.version})` })
      .from(problemRevisions)
      .where(eq(problemRevisions.problemId, problemId));
    return row?.max ?? 0;
  }

  /**
   * Fetches a problem's detail by id with no visibility check — the caller
   * has already established the actor may act on it (as its creator, or
   * having just passed `canEditProblem`). Deliberately distinct from
   * `getVisible`: re-checking visibility here would 404 an author who just
   * removed themselves from a private problem's membership, even though
   * their own write just succeeded.
   *
   * Both callers (`create`, just after inserting `actor` as `author`, and
   * `update`, only reachable after `loadForEdit` has already required
   * `canEditProblem`) always act on behalf of an editor of this exact
   * problem — so `orgSlugs` below is always the unfiltered, editor view
   * (`loadMembersAndOrgs`'s `isEditor: true`), never the visibility-filtered
   * one a plain viewer gets from `getVisible`.
   */
  private async loadDetailById(id: number, actor: Actor | null): Promise<ProblemDetailDto> {
    // Same `me` treatment as `getVisible` (and for the same reason): this
    // backs the response of both `POST /problems` and `PATCH /problems/:code`
    // (both answer with a `ProblemDetail`), and a `create`/`update` call
    // that skipped the lateral would report `me: null` to an editor who
    // already has a best submission on the problem being patched — a
    // genuine drift from what the very next `GET /problems/:code` for the
    // same actor would say, not just a missing feature.
    const revisionJoin = and(eq(problems.currentRevisionId, problemRevisions.id), eq(problemRevisions.state, 'published'));
    let row: {
      id: number;
      code: string;
      name: string;
      statement: string;
      visibility: ProblemVisibility;
      sourceAccess: 'private' | 'solved';
      difficulty: number | null;
      editorial: string | null;
      editorialPublishedAt: Date | null;
      createdAt: Date;
      revisionId: number | null;
      publishedVersion: number | null;
      timeMs: number | null;
      memoryKb: number | null;
      testCount: number | null;
      totalPoints: number | null;
      checkerKind: string | null;
      packageHash: string | null;
      meVerdict?: string | null;
      mePoints?: number | null;
      meMaxPoints?: number | null;
    };
    if (actor) {
      const meBest = this.bestSubmissionLateral(actor.userId);
      row = (
        await this.db
          .select({
            id: problems.id,
            code: problems.code,
            name: problems.name,
            statement: problems.statement,
            visibility: problems.visibility,
            sourceAccess: problems.sourceAccess,
            difficulty: problems.difficulty,
            editorial: problems.editorial,
            editorialPublishedAt: problems.editorialPublishedAt,
            createdAt: problems.createdAt,
            revisionId: problemRevisions.id,
            publishedVersion: problemRevisions.version,
            timeMs: problemRevisions.timeMs,
            memoryKb: problemRevisions.memoryKb,
            testCount: problemRevisions.testCount,
            totalPoints: problemRevisions.totalPoints,
            checkerKind: problemRevisions.checkerKind,
            packageHash: problemRevisions.packageHash,
            meVerdict: meBest.verdict,
            mePoints: meBest.points,
            meMaxPoints: meBest.maxPoints,
          })
          .from(problems)
          .leftJoin(problemRevisions, revisionJoin)
          .leftJoinLateral(meBest, sql`true`)
          .where(eq(problems.id, id))
          .limit(1)
      )[0]!;
    } else {
      row = (
        await this.db
          .select({
            id: problems.id,
            code: problems.code,
            name: problems.name,
            statement: problems.statement,
            visibility: problems.visibility,
            sourceAccess: problems.sourceAccess,
            difficulty: problems.difficulty,
            editorial: problems.editorial,
            editorialPublishedAt: problems.editorialPublishedAt,
            createdAt: problems.createdAt,
            revisionId: problemRevisions.id,
            publishedVersion: problemRevisions.version,
            timeMs: problemRevisions.timeMs,
            memoryKb: problemRevisions.memoryKb,
            testCount: problemRevisions.testCount,
            totalPoints: problemRevisions.totalPoints,
            checkerKind: problemRevisions.checkerKind,
            packageHash: problemRevisions.packageHash,
          })
          .from(problems)
          .leftJoin(problemRevisions, revisionJoin)
          .where(eq(problems.id, id))
          .limit(1)
      )[0]!;
    }

    const { members, orgSlugs } = await this.loadMembersAndOrgs(id, actor, true);

    // Deliberately NOT masked by D35, unlike `getVisible`: both callers are
    // editors of this exact problem (see this method's doc comment), and a
    // PATCH that set `tags` must echo back what it just stored — a masked
    // response would tell the author their write vanished.
    const tags = (await this.loadTagsByProblem([id])).get(id) ?? [];
    // `isEditor: true` for the same reason `loadMembersAndOrgs` gets it: both
    // callers act for an editor of this exact problem, so the draft comes
    // back — a PATCH that stored an editorial must echo it, or the author is
    // told their write vanished.
    const editorial = await this.resolveEditorial(actor, row, true, false);

    // The counts are NOT masked here, for the same reason the tags are not:
    // both callers act for an editor of this exact problem.
    const counts = (await this.loadCountsByProblem([id])).get(id) ?? BLANK_COUNTS;

    return {
      ...toSummary(row, { tags, difficulty: row.difficulty }, counts),
      ...editorial,
      statement: row.statement,
      // Not revision-derived, so unlike the three fields below it is never
      // nulled out on a problem whose only revision is a draft: the flag
      // lives on the problem itself and is meaningful before anything is
      // published.
      sourceAccess: row.sourceAccess,
      testCount: row.revisionId === null ? null : row.testCount,
      totalPoints: row.revisionId === null ? null : row.totalPoints,
      checkerKind: row.revisionId === null ? null : row.checkerKind,
      // Same guard as the three above, for the same reason: the join already
      // carries `state = 'published'`, so a pointer parked on an archived
      // revision matches nothing and every one of these reads SQL NULL.
      // Stated rather than assumed — this is the field a client uses to
      // decide WHICH revision it is looking at, and a stale number here is
      // worse than no number at all.
      publishedVersion: row.revisionId === null ? null : row.publishedVersion,
      createdAt: row.createdAt.toISOString(),
      members,
      orgSlugs,
      samples: await this.loadSamples(row.revisionId === null ? null : row.packageHash),
    };
  }

  /**
   * D43 — the two editorial fields of a `ProblemDetail`, for THIS viewer.
   *
   * An editorial is a spoiler, so it is withheld from exactly the person a
   * spoiler would rob: someone still trying to solve the problem in a live
   * contest. Everyone else — including anyone reading outside a contest at
   * all — gets it as soon as its author publishes it.
   *
   * The order below is the ruling, in the order it is decided:
   * 1. **No text at all** → `null` / `false`. The one answer that is also
   *    what every branch below collapses to when it refuses, which is the
   *    point: "there is none", "there is an unpublished draft" and "there
   *    is one you may not read yet" are indistinguishable to a reader.
   *    Telling them apart would leak a setter's work in progress, and —
   *    during a contest — the very fact that a solution is sitting there.
   * 2. **An editor** (author, curator, admin) gets the text unconditionally,
   *    draft included: the edit form seeds its textarea from this field, and
   *    a form that cannot load what it is about to overwrite is a way to
   *    lose an editorial rather than a way to write one.
   *    `editorialAvailable` still reports the publish state, so this is the
   *    one case where a non-null `editorial` comes back `false` — which is
   *    exactly what the publish toggle needs to seed from.
   * 3. **Unpublished** → refused. A draft is not a publication.
   * 4. **Not sitting a running contest that uses this problem** → served.
   *    `hidden` is D35's own set, computed by the caller and passed in
   *    rather than recomputed: the two rules must agree about who is
   *    "in the room", and agreement is easier to hold when there is one
   *    query answering it.
   * 5. **Sitting it, but already holding an AC** → served. Someone who has
   *    solved the problem cannot be spoiled by the solution, and refusing
   *    them would make the room's best readers the last to learn anything.
   * 6. Otherwise refused, until the clock runs out on the contest.
   */
  private async resolveEditorial(
    actor: Actor | null,
    row: { id: number; editorial: string | null; editorialPublishedAt: Date | null },
    isEditor: boolean,
    hiddenByContest: boolean,
  ): Promise<{ editorial: string | null; editorialAvailable: boolean }> {
    if (row.editorial === null) return NO_EDITORIAL;
    const published = row.editorialPublishedAt !== null;
    if (isEditor) return { editorial: row.editorial, editorialAvailable: published };
    if (!published) return NO_EDITORIAL;
    if (!hiddenByContest) return { editorial: row.editorial, editorialAvailable: true };
    // Only asked once the contest branch has already refused — a query per
    // problem read would otherwise buy nothing for the overwhelming majority
    // of readers, who are not sitting a contest at all.
    if (await this.hasAccepted(actor, row.id)) {
      return { editorial: row.editorial, editorialAvailable: true };
    }
    return NO_EDITORIAL;
  }

  /**
   * Whether `actor` holds an accepted submission to `problemId`.
   *
   * An explicit `verdict = 'AC'` existence check rather than a reading of
   * the `me` lateral's best verdict: "best" is a `points` ordering with its
   * own null handling, and D43 turns on the plain fact that an AC exists.
   * One question, answered by the question rather than by a proxy for it.
   */
  private async hasAccepted(actor: Actor | null, problemId: number): Promise<boolean> {
    if (!actor) return false;
    const rows = await this.db
      .select({ id: submissions.id })
      .from(submissions)
      .where(
        and(
          eq(submissions.userId, actor.userId),
          eq(submissions.problemId, problemId),
          eq(submissions.verdict, 'AC'),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Which problems this actor must not be shown tags or a difficulty for
   * (D35) — the ids of every problem attached to a contest that is running
   * RIGHT NOW and that the actor holds a participation in, minus the ones
   * they organise.
   *
   * A tag is a hint. "This is a segment tree problem" is a third of the work
   * on the hardest problem in the room, and a scoreboard that rewards
   * reading the tag list rewards the wrong thing. Once the contest ends the
   * hint comes back on its own — nothing is stored, this is a clock
   * question.
   *
   * Deliberate simplifications, each the safe direction:
   * - The **contest's** window, not the participant's own virtual one. A
   *   virtual attempt begun after `end_time` sees the tags; the hint is
   *   withheld from the live room, which is what the ranking depends on.
   * - **Every** participation counts, spectators (`virtual = -1`) and
   *   disqualified entries included. Hiding a hint from someone who is only
   *   watching costs them a chip; showing it to someone who is quietly
   *   competing costs the contest.
   * - An anonymous viewer is hidden nothing, because they hold no
   *   participation. Signing out therefore defeats this — accepted: the
   *   ruling is about not putting a hint in front of a competitor, not about
   *   making the tag list unobtainable.
   * - An admin, and the contest's own organiser (`created_by`), see
   *   everything. Both already read the problem's edit screen.
   *
   * `problemIds`, when given, narrows the scan to the ids a caller is about
   * to render — `getVisible` needs one row's answer, not the whole set.
   */
  private contestHiddenProblemIds(
    actor: Actor | null,
    problemIds?: number[],
  ): Promise<ReadonlySet<number>> {
    // Delegates to the shared predicate in `problem.visibility.ts` (D35, and
    // D109's discussion hiding). Kept as a thin method so every call site here
    // reads unchanged, but the query itself lives in one place so this masking
    // and `ProblemCommentsService`'s can never drift apart.
    return contestHiddenProblemIds(this.db, actor, problemIds);
  }

  /**
   * Every given problem's tags, expanded and ordered by slug, in ONE query.
   * Callers pass only the ids they intend to show — a problem masked by D35
   * is left out here rather than fetched and then discarded, so the hint
   * never enters the process at all.
   */
  private async loadTagsByProblem(problemIds: number[]): Promise<Map<number, TagDto[]>> {
    const byProblem = new Map<number, TagDto[]>();
    if (problemIds.length === 0) return byProblem;
    const rows = await this.db
      .select({
        problemId: problemTags.problemId,
        slug: schema.tags.slug,
        nameVi: schema.tags.nameVi,
        nameEn: schema.tags.nameEn,
      })
      .from(problemTags)
      .innerJoin(schema.tags, eq(schema.tags.id, problemTags.tagId))
      .where(inArray(problemTags.problemId, problemIds))
      // By slug, not by insertion order: a chip row that reshuffles between
      // two renders of the same problem is noise, and nothing else here
      // defines an order for a set.
      .orderBy(asc(problemTags.problemId), asc(schema.tags.slug));
    for (const row of rows) {
      const list = byProblem.get(row.problemId) ?? [];
      list.push({ slug: row.slug, nameVi: row.nameVi, nameEn: row.nameEn });
      byProblem.set(row.problemId, list);
    }
    return byProblem;
  }

  /**
   * Slugs to tag ids, exact-match and deduplicated on the resolved id.
   *
   * Unlike `resolveOrgIds`, an unknown slug is NAMED: 422
   * `problem_tag_unknown` carrying the offending slugs. Blurring it would
   * protect nothing — `GET /tags` is `@Public()` and hands the whole
   * vocabulary to anyone who asks — while costing a setter the one piece of
   * information that turns a rejected PATCH into a fixed one.
   *
   * Exact match, not `lower(...)`: every seeded slug is already lowercase
   * and URL-safe, and a case-insensitive lookup here would accept
   * `Do-Thi` from a PATCH while `?tag=Do-Thi` (a plain `IN`, served by
   * `tags_slug_idx`) matched nothing — two spellings that disagree about
   * which one is the identity.
   */
  private async resolveTagIds(slugs: string[]): Promise<number[]> {
    const unique = [...new Set(slugs)];
    if (unique.length === 0) return [];
    const rows = await this.db
      .select({ id: schema.tags.id, slug: schema.tags.slug })
      .from(schema.tags)
      .where(inArray(schema.tags.slug, unique));
    const idBySlug = new Map(rows.map((row) => [row.slug, row.id]));
    const unknown = unique.filter((slug) => !idBySlug.has(slug));
    if (unknown.length > 0) {
      throw new AppError(
        422,
        'problem_tag_unknown',
        `No such tag: ${unknown.join(', ')}. GET /tags lists every tag a problem can carry.`,
      );
    }
    return unique.map((slug) => idBySlug.get(slug)!);
  }

  /**
   * Loads a problem's members and shared-organization slugs for
   * `ProblemDetail` (spec §4.1). The two fields are deliberately NOT
   * symmetric:
   *
   * - `members` is credit, not a secret — the spec makes it visible to
   *   anyone who can see the problem at all (DMOJ displays authorship
   *   publicly too), so it is always the full, unfiltered set.
   * - `orgSlugs` names organizations, and an organization can be private.
   *   Returning the full list to every viewer would let anyone probe which
   *   private organizations a problem is shared with — the same leak class
   *   Task 4's org-injection fix addressed, flagged there as a loose end
   *   for this exact read path. So a non-editor only gets the subset
   *   already visible to them via the shared `visibleOrgsWhere` predicate
   *   (public organizations, plus ones they belong to) — never a bespoke
   *   rule of its own.
   *
   *   An editor (author/curator on this problem, or an admin) always gets
   *   the FULL set, bypassing that filter entirely. This is not generosity:
   *   `update`'s `orgSlugs` is a whole-set *replacement* (see its doc
   *   comment), so an editor who could only see a partial list and then
   *   submitted it back would silently unshare every organization they
   *   could not see — e.g. one a co-author attached before the editor
   *   joined, or one they have since left.
   */
  private async loadMembersAndOrgs(
    problemId: number,
    actor: Actor | null,
    isEditor: boolean,
  ): Promise<{ members: ProblemMemberInput[]; orgSlugs: string[] }> {
    const [memberRows, orgRows] = await Promise.all([
      this.db
        .select({ username: schema.users.username, role: problemMembers.role })
        .from(problemMembers)
        .innerJoin(schema.users, eq(schema.users.id, problemMembers.userId))
        .where(eq(problemMembers.problemId, problemId))
        .orderBy(asc(schema.users.username)),
      this.db
        .select({ slug: organizations.slug })
        .from(problemOrgs)
        .innerJoin(organizations, eq(organizations.id, problemOrgs.orgId))
        .where(and(eq(problemOrgs.problemId, problemId), isEditor ? sql`true` : visibleOrgsWhere(this.db, actor)))
        .orderBy(asc(organizations.slug)),
    ]);
    return { members: memberRows, orgSlugs: orgRows.map((o) => o.slug) };
  }

  /**
   * Resolves org slugs to ids, case-insensitively (matching
   * `organizations_slug_lower_idx`), then requires the actor to belong to
   * every one of them being newly ADDED — in any role — before a problem
   * may be shared with it. An organization that does not exist and one the
   * actor is not a member of are indistinguishable to the caller: both
   * throw `ORG_UNKNOWN_MESSAGE`, so a slug can't be used to probe for a
   * private organization's existence or membership. Admins bypass the
   * membership requirement (the organization must still exist), consistent
   * with every other `isAdmin` bypass in this file.
   *
   * `alreadyAttachedIds` (empty for `create`, where every org is
   * necessarily an addition; the problem's current `problemOrgs` ids for
   * `update`) is what keeps two rules that were once wrongly fused apart:
   * "you may not SHARE a problem with a group you don't belong to"
   * (security — membership is still required for every id NOT in this set)
   * versus "you may not silently UNSHARE a group you happen not to belong
   * to" (safety — membership is never required for an id already here).
   * Before this distinction existed, an editor who could see (spec §4.1)
   * but not join a private org the problem was already shared with had NO
   * way to PATCH without dropping it: resubmitting the full set they were
   * shown was rejected outright, and the only request that could succeed
   * was the one omitting that org — which silently unshared it. This
   * parameter closes that hole without weakening the security rule: an id
   * only skips the membership check because it was already attached to
   * THIS problem, not because the caller merely claims it should be exempt.
   *
   * Deduplicates on the *resolved* id, not the input slug string: because
   * resolution is case-insensitive, `['org-a', 'ORG-A']` are two spellings
   * of one id, and inserting `problemOrgs` once per input string would hit
   * its `(problemId, orgId)` primary key twice and surface as a 500.
   */
  private async resolveOrgIds(
    actor: Actor,
    slugs: string[],
    alreadyAttachedIds: ReadonlySet<number> = new Set(),
  ): Promise<number[]> {
    if (slugs.length === 0) return [];
    const uniqueSlugs = [...new Set(slugs)];
    const ids: number[] = [];
    for (const slug of uniqueSlugs) {
      const row = (
        await this.db
          .select({ id: organizations.id })
          .from(organizations)
          .where(sql`lower(${organizations.slug}) = lower(${slug})`)
          .limit(1)
      )[0];
      if (!row) throw new AppError(400, 'problem_org_unknown', ORG_UNKNOWN_MESSAGE);
      ids.push(row.id);
    }
    const uniqueIds = [...new Set(ids)];
    if (!isAdmin(actor)) {
      const addedIds = uniqueIds.filter((id) => !alreadyAttachedIds.has(id));
      const membership = await loadOrgMembership(this.db, actor, addedIds);
      for (const id of addedIds) {
        if (!membership.has(id)) {
          throw new AppError(400, 'problem_org_unknown', ORG_UNKNOWN_MESSAGE);
        }
      }
    }
    return uniqueIds;
  }

  /**
   * Resolves member usernames to ids, case-insensitively (matching
   * `users_username_lower_idx`), failing on the first username that names no
   * user. Deduplicates on the *resolved* `(userId, role)` pair, not the
   * input `(username, role)` pair: because resolution is case-insensitive,
   * `{alice, author}` and `{ALICE, author}` resolve to the same row, and
   * inserting it twice would hit `problemMembers`'s `(problemId, userId,
   * role)` primary key and surface as a 500. `{alice, author}` plus
   * `{alice, curator}` still both survive: `role` is part of the key they
   * are deduplicated on, so the two are legitimately distinct rows.
   */
  private async resolveMemberIds(
    members: ProblemMemberInput[],
  ): Promise<{ userId: number; role: ProblemMemberInput['role'] }[]> {
    const idByUsername = new Map<string, number>();
    for (const username of new Set(members.map((m) => m.username))) {
      const row = (
        await this.db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(sql`lower(${schema.users.username}) = lower(${username})`)
          .limit(1)
      )[0];
      if (!row) throw new AppError(400, 'problem_member_unknown', `No such user: ${username}.`);
      idByUsername.set(username, row.id);
    }

    const seen = new Set<string>();
    const resolved: { userId: number; role: ProblemMemberInput['role'] }[] = [];
    for (const m of members) {
      const userId = idByUsername.get(m.username)!;
      const key = `${userId}\u0000${m.role}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push({ userId, role: m.role });
    }
    return resolved;
  }
}

/**
 * Translates a Postgres unique-violation raised by a racing INSERT into the
 * same 409 a SELECT-then-INSERT pre-check would have produced had it won the
 * race, so a concurrent duplicate `code` still surfaces `problem_code_taken`
 * instead of an opaque 500. Mirrors `auth.service.ts`'s
 * `toRegistrationConflict`; duplicated rather than shared because the two
 * live in different layers and each maps a different constraint name.
 */
function toCreateConflict(error: unknown): unknown {
  const pgError = asUniqueViolation(error);
  if (pgError?.constraint_name === PROBLEM_CODE_CONSTRAINT) {
    return new AppError(409, 'problem_code_taken', 'That problem code is already taken.');
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

/**
 * What a viewer sees where D35 withholds the hint: exactly what an untagged,
 * unrated problem returns. One frozen object rather than a literal per call
 * site, so "hidden" and "has none" cannot drift into two distinguishable
 * shapes.
 */
const BLANK_HINT: ProblemHint = Object.freeze({ tags: [] as TagDto[], difficulty: null });

/** D49's two per-problem counters, blanked exactly as `BLANK_HINT` blanks a hint. */
export interface ProblemCounts {
  attemptedCount: number;
  solvedCount: number;
}
const BLANK_COUNTS: ProblemCounts = Object.freeze({ attemptedCount: 0, solvedCount: 0 });

const STATS_CACHE_PREFIX = 'duckoj:pstats:v1';
/** One entry per problem, holding D49's two list counters (D49 amended). */
const COUNTS_CACHE_PREFIX = 'duckoj:pcounts:v1';
/**
 * Thirty seconds, the same as the statistics beside it and for the same
 * reason: these two numbers are a difficulty hint on a catalogue page, not a
 * live board, and the window exists to collapse the burst of a class opening
 * the same problem at once. A solve shows up within half a minute.
 */
const COUNTS_CACHE_TTL_MS = 30_000;
/**
 * Thirty seconds. A problem page is not a live board — nobody is watching the
 * acceptance rate tick — and the window exists to collapse the burst of a
 * class opening the same problem at once.
 */
const STATS_CACHE_TTL_MS = 30_000;
/** Ten, per D49: a leaderboard, not a listing. */
const FASTEST_LIMIT = 10;

/** The shape a problem nobody has attempted returns — and D35's mask. */
function blankStats(): ProblemStatsDto {
  return {
    totalSubmissions: 0,
    attemptedUsers: 0,
    solvedUsers: 0,
    acceptanceRate: null,
    verdicts: [],
    languages: [],
    fastest: [],
    firstSolver: null,
  };
}

/**
 * The single refusal every editorial branch collapses to — absent,
 * unpublished, and withheld are one answer, not three (D43). Frozen and
 * shared for `BLANK_HINT`'s reason: two literals in two branches are two
 * shapes that can drift into being told apart.
 */
const NO_EDITORIAL = Object.freeze({ editorial: null, editorialAvailable: false }) as {
  editorial: string | null;
  editorialAvailable: boolean;
};

/**
 * What every write path loads before it decides anything: the problem's id
 * and visibility (for the 404-then-403 ordering) plus its stored editorial,
 * which `update` needs in hand to rule on `editorialPublished: true`.
 */
interface EditableProblemRow {
  id: number;
  visibility: ProblemVisibility;
  editorial: string | null;
  editorialPublishedAt: Date | null;
}

interface ProblemHint {
  tags: TagDto[];
  difficulty: number | null;
}

function toSummary(row: {
  id: number;
  code: string;
  name: string;
  visibility: ProblemVisibility;
  revisionId: number | null;
  timeMs: number | null;
  memoryKb: number | null;
  testCount: number | null;
  // Absent entirely for an anonymous caller's query (no lateral joined in),
  // rather than present-but-null — `toBestMe` treats the two identically,
  // both read as "no `me` to report".
  meVerdict?: string | null;
  mePoints?: number | null;
  meMaxPoints?: number | null;
}, hint: ProblemHint, counts: ProblemCounts): ProblemSummaryDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    visibility: row.visibility,
    hasPublishedRevision: row.revisionId !== null,
    timeMs: row.revisionId === null ? null : row.timeMs,
    memoryKb: row.revisionId === null ? null : row.memoryKb,
    // Guarded on `revisionId` like the two limits above, not returned raw: the
    // leftJoin is `and(currentRevisionId = id, state = 'published')`, so a
    // problem whose only revision is a draft joins to nothing and every
    // revision-derived field must read null rather than a stale value.
    testCount: row.revisionId === null ? null : row.testCount,
    me: toBestMe(row),
    // Not revision-derived, so unlike the three fields above these are never
    // nulled out on a draft-only problem — a problem is tagged and rated
    // before it has anything published, and that is exactly when a curator
    // needs to see it. `hint` is where D35's masking has already been
    // applied (or not); this function never decides visibility itself.
    tags: hint.tags,
    difficulty: hint.difficulty,
    // D49, masked by the same rule and in the same place as the hint above:
    // `counts` is where the caller has already decided whether this viewer
    // is sitting a contest that uses the problem.
    attemptedCount: counts.attemptedCount,
    solvedCount: counts.solvedCount,
  };
}

/**
 * `null` exactly when `meVerdict` is — the lateral was never joined
 * (anonymous caller) or joined but matched no row (the viewer has no
 * GRADED submission to this problem at all, spec §2). Once `meVerdict` is
 * present, `points`/`maxPoints` are reported as-is, null included: CE
 * carries `points: 0, maxPoints: null` and IE carries `points: null,
 * maxPoints: null` (`event-writer.ts` never sets either for IE, and never
 * sets `maxPoints` for CE) — see `bestSubmissionLateral`'s doc comment for
 * why both are still valid "best" candidates rather than excluded. Unlike
 * an earlier version of this function, `points`/`maxPoints` being null is
 * NOT treated as "no `me`" — only a missing `verdict` is.
 */
function toBestMe(row: {
  meVerdict?: string | null;
  mePoints?: number | null;
  meMaxPoints?: number | null;
}): ProblemMeDto {
  if (row.meVerdict == null) return null;
  return {
    verdict: row.meVerdict as NonNullable<ProblemMeDto>['verdict'],
    points: row.mePoints ?? null,
    maxPoints: row.meMaxPoints ?? null,
  };
}

/**
 * Cursors are opaque to clients but are ids here. A non-numeric cursor is a
 * client mistake, not a server fault: reject it as a validation problem
 * rather than letting `NaN` reach the driver and surface as a 500.
 */
function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const after = Number(cursor);
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new AppError(422, 'invalid_cursor', 'That page cursor is not valid.');
  }
  return after;
}
