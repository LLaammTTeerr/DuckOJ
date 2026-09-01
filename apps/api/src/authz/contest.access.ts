import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, max, notInArray, or, sql, type SQL } from 'drizzle-orm';
import {
  contestOrgs,
  contestParticipations,
  contestProblems,
  contestSubmissions,
  contests,
  orgMembers,
  organizations,
  problemRevisions,
  problems,
  submissionCases,
  submissions,
  teamMembers,
  teams,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { CONTEST_FORMATS, computeContestScoreboard, summariseCases } from '@duckoj/contest-formats';
import { DEFAULT_MAX_TEAM_SIZE } from '@duckoj/contracts';
import type { Scoreboard, SubtaskSummary, TestCaseSpec } from '@duckoj/contest-formats';
import type {
  CloneContestRequestDto,
  ContestParticipationDto,
  ContestPhaseFilterDto,
  ContestParticipationModeDto,
  JoinContestRequestDto,
  ContestDetailDto,
  ContestOrgDto,
  ContestPageDto,
  ContestProblemInputDto,
  ContestSummaryDto,
  ContestVisibilityDto,
  PaginationQueryDto,
} from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { contestEditVersion, versionConflict } from './edit-version.js';
import { AppError } from '../common/app.error.js';
import { seat, toSeatConflict } from './contest.seats.js';
import { isAdmin, type Actor } from './actor.js';
import {
  canCreateContest,
  canViewContest,
  loadContestContext,
  visibleContestsWhere,
} from './contest.visibility.js';
import {
  mapContest,
  type ContestSubmissionRow,
  type ContestSubtaskRow,
} from './contest.mapping.js';
import {
  actingParticipations,
  listParticipations,
  participationWindow,
  type ContestWindowRow,
  type ParticipationRow,
} from './participation.js';
import {
  loadContestTeams,
  resolveContestTeam,
  teamMemberIds,
  type ContestTeam,
} from './contest.teams.js';
import { loadOrgAdminships } from './org.visibility.js';
import {
  ScoreboardCache,
  scoreboardCacheKey,
  scoreboardCacheKeys,
  type ScoreboardCacheContest,
  type ScoreboardCacheState,
} from './scoreboard.cache.js';
import { canViewProblem, loadProblemContext, visibleProblemsWhere, actingParticipationWhere } from './problem.visibility.js';
import {
  bookletToTypst,
  statementSection,
  type StatementLang,
} from '../statements/markdown-to-typst.js';

/**
 * One team as the board describes it (D99) — the sidecar `Scoreboard.teams`
 * is a record of these, keyed by the team's NAME, which is what the ranking
 * row prints.
 *
 * `captain` is the member whose account holds the participation: the
 * username `PATCH /contests/{key}/participants/{username}` takes, so a team
 * is disqualified through the route that already exists rather than one
 * invented for it. `orgName` rides along because the results sheet's `orgs`
 * column prints the team's school for a team row (D71's column, D99's
 * source: `participant-orgs.ts` is keyed by the CAPTAIN's own memberships,
 * which is the wrong answer for a team).
 */
export interface ScoreboardTeam {
  slug: string;
  name: string;
  orgSlug: string;
  orgName: string;
  captain: string;
  members: string[];
}

/**
 * The board the API serves: the format's own output, plus D99's sidecar.
 *
 * `teams` is ABSENT for an individual contest, so nothing about that
 * response changed — and the formats package produced neither field, which
 * is what keeps all 23 goldens byte-identical.
 */
export type ContestScoreboard = Scoreboard & { teams?: Record<string, ScoreboardTeam> };

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
  /** Both frozen once the contest has started (D38's rule, D99's fields). */
  participationMode?: ContestParticipationModeDto | undefined;
  maxTeamSize?: number | undefined;
  /** Present replaces the whole set; absent keeps it (D56). */
  orgSlugs?: string[] | undefined;
  problems?: ContestProblemInputDto[] | undefined;
  /** The `version` the caller read before editing; absent is unchecked (D161). */
  expectedVersion?: string | undefined;
}

export type CloneContestInput = CloneContestRequestDto;

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
  participationMode?: ContestParticipationModeDto | undefined;
  maxTeamSize?: number | undefined;
  orgSlugs?: string[] | undefined;
  problems?: ContestProblemInputDto[] | undefined;
}

/** `ContestParticipation.LIVE`. Named so the three uses below read as one rule. */
const LIVE_VIRTUAL = 0;

/**
 * The submission states in which `submissions.subtask_summary` describes the
 * submission's latest attempt (D165).
 *
 * Anything else — `queued`, `compiling`, `grading` — means an attempt is in
 * flight, its case rows are still arriving, and the board is supposed to show
 * the partial score they make. A summary written for the PREVIOUS attempt
 * would be stale in exactly that window, so it is not consulted there at all.
 * This is what makes "one lease reclaim regrades a graded submission" safe
 * without a second column to compare attempts on: the first thing a re-grade
 * does is move the state off terminal (`dispatched` -> `queued`).
 */
const TERMINAL_STATES: ReadonlySet<string> = new Set(['done', 'errored']);

function toSubtaskRow(subtask: SubtaskSummary): ContestSubtaskRow {
  return {
    groupIndex: subtask.batch,
    minPoints: subtask.minPoints,
    maxTotal: subtask.maxTotal,
    sumPoints: subtask.sumPoints,
    sumTotal: subtask.sumTotal,
  };
}

/**
 * `submissions.subtask_summary` as the fold may use it, or `null` for "ask the
 * case rows".
 *
 * Validated rather than cast. The column is `jsonb` and therefore holds
 * whatever was written into it; a shape this does not recognise falls back to
 * the per-case read, which is always correct, instead of folding `undefined`
 * into somebody's score. `Number.isFinite` is the whole check that matters —
 * a `null` or a string in one of these fields would arrive as `NaN` and
 * silently blank a whole scoreboard row.
 */
function readSubtaskSummary(value: unknown): ContestSubtaskRow[] | null {
  if (!Array.isArray(value)) return null;
  const rows: ContestSubtaskRow[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') return null;
    const record = entry as Record<string, unknown>;
    const numbers = ['batch', 'minPoints', 'maxTotal', 'sumPoints', 'sumTotal'].map((key) =>
      typeof record[key] === 'number' ? record[key] : Number.NaN,
    );
    if (numbers.some((number) => !Number.isFinite(number))) return null;
    rows.push(
      toSubtaskRow({
        batch: numbers[0]!,
        minPoints: numbers[1]!,
        maxTotal: numbers[2]!,
        sumPoints: numbers[3]!,
        sumTotal: numbers[4]!,
      }),
    );
  }
  return rows;
}

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
/**
 * A team's participation, with the account that holds it.
 *
 * `ParticipationRow` deliberately carries no `user_id` — it answers "which
 * attempt is this", not "whose". A team row's holder IS load-bearing (D99's
 * captain: it decides whether a second teammate reads the row back or is
 * refused, and it is the username the disqualify control takes), so the team
 * path carries it and nothing else has to learn about it.
 */
type TeamParticipationRow = ParticipationRow & { userId: number };

@Injectable()
export class ContestAccessService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ScoreboardCache) private readonly scoreboards: ScoreboardCache,
  ) {}

  /**
   * D151 — WHY THIS ENDPOINT LEARNED TO FILTER.
   *
   * Unfiltered, this is page 1 of an **id**-ordered list: the order contests
   * were CREATED in. On a judge with a hundred and twenty-five rounds behind
   * it, the round a school created this morning is on the last page — so the
   * home panel that reads this endpoint could not see today's contest, which
   * is the one moment a pupil opens the app to find it.
   *
   * `phase` filters and, with it, ORDERS BY START TIME. The reordering is
   * scoped to the filter on purpose: the unfiltered list keeps its id cursor
   * and its id order, so no existing caller changes behaviour.
   *
   * `mine` is D56's join rule said as a filter, so a panel headed "your
   * contests" is not headlining another school's round.
   *
   * Neither filter touches VISIBILITY: both compose with
   * `visibleContestsWhere` as plain `AND`s and can only ever remove rows the
   * caller could already see. Nor do they touch concealment — D35 hides a
   * problem's tags and difficulty and D22 freezes a scoreboard, and
   * `ContestSummary` carries neither a tag nor a score. `toSummary` is
   * unchanged, which is what makes that true rather than merely believed.
   */
  async listVisible(
    actor: Actor | null,
    page: Pick<PaginationQueryDto, 'limit'> & {
      cursor?: string | undefined;
      org?: string | undefined;
      phase?: ContestPhaseFilterDto | undefined;
      mine?: boolean | undefined;
    },
  ): Promise<ContestPageDto> {
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

    // The database's clock, not this process's. The rows being compared are
    // stored by the same server; a filter that straddles a start time must
    // not depend on how far the API container's clock has drifted from the
    // one that wrote the row.
    const now = sql`now()`;
    // `active` is `upcoming ∪ running`, which — since a contest's end is
    // always after its start — is exactly "has not ended". One comparison,
    // not two OR'd, and it is the one a landing page asks.
    const inPhase =
      page.phase === undefined
        ? undefined
        : page.phase === 'running'
          ? and(sql`${contests.startTime} <= ${now}`, sql`${contests.endTime} >= ${now}`)
          : page.phase === 'upcoming'
            ? sql`${contests.startTime} > ${now}`
            : sql`${contests.endTime} >= ${now}`;

    const joinable = page.mine === true ? this.joinableWhere(actor) : undefined;

    // Two orderings, and therefore two cursor grammars. `phase` pages walk
    // `(start_time, id)`, so the cursor has to carry both: ordering by a
    // non-unique column with a single-column cursor either repeats rows or
    // skips them whenever two contests start in the same second — and two
    // rounds starting at 08:00 on the same Saturday is the normal case here,
    // not a corner one.
    const seek =
      page.phase === undefined
        ? gt(contests.id, parseCursor(page.cursor))
        : startTimeSeek(page.cursor);

    const rows = await this.db
      .select()
      .from(contests)
      .where(and(visibleContestsWhere(this.db, actor), seek, restrictedTo, inPhase, joinable))
      .orderBy(...(page.phase === undefined ? [asc(contests.id)] : [asc(contests.startTime), asc(contests.id)]))
      .limit(page.limit + 1);

    const kept = rows.slice(0, page.limit);
    // ONE query for the whole page, never one per row: a 50-contest page
    // would otherwise be 51 round trips to render a badge.
    const orgsByContest = await this.loadOrgs(kept.map((row) => row.id));
    const items = kept.map((row) => toSummary(row, orgsByContest.get(row.id) ?? []));
    const last = kept.at(-1);
    const nextCursor =
      rows.length > page.limit && last
        ? page.phase === undefined
          ? String(last.id)
          : `${last.startTime.getTime()}_${last.id}`
        : null;
    return { items, nextCursor };
  }

  /**
   * `?mine=true` — contests this caller has entered, or could enter (D151).
   *
   * The three branches are `assertMayJoin`'s rule, in list form and in its
   * order:
   *
   * 1. **A participation already held wins outright.** `assertMayJoin` sits
   *    AFTER the idempotent short-circuit precisely so that a competitor who
   *    is already in stays in whatever the roster says today; a filter that
   *    dropped their contest off their own home page would contradict the
   *    endpoint that still lets them submit to it.
   * 2. **No organizations means anyone who can see it may join** (D56).
   * 3. **Otherwise, membership of one of them.**
   *
   * An ADMIN passes them all, because `assertMayJoin` returns early for an
   * admin: "contests I may join" is every contest they can see, and saying
   * otherwise here would make this filter disagree with the endpoint it
   * describes.
   *
   * Anonymous: nothing. Joining needs an account, so the set is empty — an
   * empty page, never a 401, because a filter must not turn a public listing
   * into a guarded one.
   */
  private joinableWhere(actor: Actor | null): SQL | undefined {
    if (actor === null) return sql`false`;
    if (isAdmin(actor)) return undefined;
    const userId = actor.userId;
    return or(
      inArray(
        contests.id,
        this.db
          .select({ contestId: contestParticipations.contestId })
          .from(contestParticipations)
          // `actingParticipationWhere`, not `user_id = me` (D113). In a team
          // contest the participation row is the CAPTAIN's alone, so the bare
          // comparison hides a teammate's own running round from the home
          // panel this filter exists to fill — the D99 class B-18, B-19 and
          // B-21 each found. The invariant guard caught it here before it
          // shipped, which is the whole point of having it.
          .where(actingParticipationWhere(this.db, userId)),
      ),
      // `contest_orgs.contest_id` is NOT NULL, so this subquery yields no
      // NULLs and `NOT IN` cannot collapse to unknown for every row — the
      // trap that makes `NOT IN (subquery)` silently return nothing.
      notInArray(contests.id, this.db.select({ contestId: contestOrgs.contestId }).from(contestOrgs)),
      inArray(
        contests.id,
        this.db
          .select({ contestId: contestOrgs.contestId })
          .from(contestOrgs)
          .innerJoin(orgMembers, eq(orgMembers.orgId, contestOrgs.orgId))
          .where(eq(orgMembers.userId, userId)),
      ),
    );
  }

  /**
   * Which organizations each of these contests is restricted to, slug and
   * name, ordered by slug so two reads of the same contest print the badges
   * in the same order.
   */
  /**
   * A contest's organizations (D56), by contest id.
   *
   * Public because the results exports need the SAME contest's orgs they
   * have already loaded and gated (`ContestResultsService.certificatesDocument`
   * signs a certificate with them). The alternative there was a second
   * `getVisible`, which re-runs the whole detail read — the contest row, its
   * problem rows and their published revisions — to reach two strings.
   * `contest_orgs` and `organizations` are not guarded tables, but the join
   * shape and the `order by slug` are worth having in one place rather than
   * two.
   */
  async loadOrgs(contestIds: number[]): Promise<Map<number, ContestOrgDto[]>> {
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
        // Unreachable with a non-null token: this branch is exactly
        // `!canRunContest`, so a caller here can never PATCH (D161).
        version: null,
      };
    }
    const problemRows = await this.loadProblemRows(contest.id);
    return {
      ...toSummary(contest, orgs),
      formatConfig: contest.formatConfig as Record<string, unknown> | null,
      canEdit: canRunContest(actor, contest),
      // D161, beside `canEdit` and gated on the same predicate. Computed from
      // the STORED rows rather than from the `problems` array below it: that
      // array is empty before the start for everyone who does not run the
      // contest and populates AT THE START INSTANT with no edit at all, so a
      // token over it would move on a clock and refuse saves nobody could
      // explain.
      version: canRunContest(actor, contest)
        ? await contestEditVersion(this.db, contest.id)
        : null,
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
  async getScoreboard(actor: Actor | null, key: string): Promise<ContestScoreboard> {
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
  ): Promise<{ board: ContestScoreboard; cache: ScoreboardCacheState }> {
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
    const rows = await this.loadBookletRows(actor, contest.id);
    return {
      contestId: contest.id,
      document: bookletToTypst({
        name: contest.name,
        startTime: contest.startTime,
        endTime: contest.endTime,
        lang,
        timeZone: await this.readerTimeZone(actor),
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
   * The zone to date this reader's cover in (D64): their account's, or null.
   *
   * **The viewer's, not the organiser's, and that is the ruling.** A contest
   * carries no timezone column and inventing one would be a migration for a
   * field no screen can set — which is the exact shape D57 already rejected
   * when it made `users.locale`/`users.timezone` nullable rather than
   * defaulted: a stored preference nobody can edit is not a preference. The
   * account's zone, meanwhile, is a value the reader chose on
   * `/account/settings` and every other date in the product already honours.
   *
   * `null` for an anonymous downloader and for a token session with no user,
   * which `bookletToTypst` reads as D57's "not chosen" and prints in ICT.
   * One extra indexed read on a route that is about to fork a typesetter.
   *
   * Public rather than private since D129: the seat slips date their window
   * the same way, and they are built in `ContestResultsService`. One query,
   * not two — the fallback rule is a product ruling and a second copy is a
   * second place to get it wrong.
   */
  async readerTimeZone(actor: Actor | null): Promise<string | null> {
    if (actor === null) return null;
    const [row] = await this.db
      .select({ timezone: schema.users.timezone })
      .from(schema.users)
      .where(eq(schema.users.id, actor.userId))
      .limit(1);
    return row?.timezone ?? null;
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
   *
   * **Narrowed to the problems this actor may read (D62).** A statement is
   * governed by `canViewProblem`, whose contest clause is `inJoinedContest`
   * — a PARTICIPATION, not merely being able to see the contest — which is
   * why `GET /problems/{code}` and `GET /problems/{code}/statement.pdf` both
   * 404 a private problem for a spectator. Without this clause the booklet
   * published the same text to anyone who could see a started contest, and
   * D56 turns that from an inconsistency into a leak: an org-restricted
   * contest REFUSES `join`, so the rival school that may not enter cannot be
   * said to have "the same access by a longer route" — there is no longer
   * route. `visibleProblemsWhere` rather than a fresh predicate, so the two
   * surfaces cannot drift; the cache key hashes the finished document, so a
   * filtered booklet and a full one are different keys by construction.
   */
  private async loadBookletRows(actor: Actor | null, contestId: number) {
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
      .where(and(eq(contestProblems.contestId, contestId), visibleProblemsWhere(this.db, actor)))
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
  async scoreboardForSystem(contestId: number): Promise<ContestScoreboard> {
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
  private async computeScoreboard(contest: ContestRow, now?: Date): Promise<ContestScoreboard> {
    const [problemRows, participationRows] = await Promise.all([
      this.loadProblemRows(contest.id),
      this.db
        .select({
          id: contestParticipations.id,
          username: schema.users.username,
          startTime: contestParticipations.startTime,
          virtual: contestParticipations.virtual,
          isDisqualified: contestParticipations.isDisqualified,
          teamId: contestParticipations.teamId,
        })
        .from(contestParticipations)
        .innerJoin(schema.users, eq(schema.users.id, contestParticipations.userId))
        .where(eq(contestParticipations.contestId, contest.id))
        .orderBy(asc(contestParticipations.id)),
    ]);

    // D99. Loaded from the SAME rows the board is folded from, so the
    // sidecar cannot describe a different board than the one beside it —
    // and inside `computeScoreboard`, so it rides D25's two-second cache
    // rather than being re-derived per view.
    const teamById = await loadContestTeams(
      this.db,
      participationRows.flatMap((row) => (row.teamId === null ? [] : [row.teamId])),
    );
    const teamsByName: Record<string, ScoreboardTeam> = {};
    for (const row of participationRows) {
      if (row.teamId === null) continue;
      const team = teamById.get(row.teamId);
      if (!team) continue;
      teamsByName[team.name] = {
        slug: team.slug,
        name: team.name,
        orgSlug: team.orgSlug,
        orgName: team.orgName,
        captain: row.username,
        members: team.members,
      };
    }

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

    const board = computeContestScoreboard(
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
        participations: participationRows.map((row) => {
          const team = row.teamId === null ? undefined : teamById.get(row.teamId);
          // Spread, never `teamName: team?.name`: under
          // `exactOptionalPropertyTypes` an explicit `undefined` is not an
          // absent key, and `mapContest` keys on absence.
          return team === undefined ? row : { ...row, teamName: team.name };
        }),
        submissions: submissionRows,
      }),
      'duckoj',
      now?.toISOString(),
    );
    // Absent, not empty, for an individual contest: an always-present `{}`
    // would put a DuckOJ field on every board the goldens describe.
    return Object.keys(teamsByName).length === 0 ? board : { ...board, teams: teamsByName };
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
    const participationMode = body.participationMode ?? 'individual';
    const maxTeamSize = body.maxTeamSize ?? DEFAULT_MAX_TEAM_SIZE;
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
    assertTeamModeHasOrgs(participationMode, orgSlugs.length);
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
            participationMode,
            maxTeamSize,
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
   * Creates a new contest from an existing one (D88).
   *
   * **What is copied** is the contest as a DESIGN: the format and its
   * config, the points precision, the freeze, the time limit, the problem
   * list with its labels, points, partial flags and order, and the
   * organizations that may enter (D56). **What is not** is everything that
   * happened inside it — participations, submissions, clarifications,
   * similarity runs — and every decision about its standing: the copy is
   * `private` and unrated, whatever the source was. Next year's round is the
   * same paper at a new time; last year's results are last year's.
   *
   * **Two permissions, as the problem clone has.** `canRunContest` first —
   * 404 for everyone else, which is exactly what `update` answers a
   * signed-in caller who can see the contest perfectly well — then
   * `canCreateContest`, so an organiser whose setter role was revoked cannot
   * keep minting contests through this door.
   *
   * The window is the caller's and is validated as an edit would be: a
   * freeze the source stores can be longer than the contest being asked for,
   * and nothing in the request says so.
   *
   * Problems are copied by `problem_id`, deliberately NOT re-resolved
   * through `resolveProblemIds`: the codes are already on the source
   * contest's page in front of this organiser, and a problem whose
   * visibility narrowed since it was attached would otherwise make last
   * year's round uncopyable rather than merely uneditable. The same applies
   * to the organizations, which `resolveOrgIds` already exempts once
   * attached, and for the same reason.
   */
  async clone(actor: Actor, key: string, body: CloneContestInput): Promise<ContestDetailDto> {
    const source = await this.loadVisible(actor, key);
    if (!canRunContest(actor, source)) throw NOT_FOUND;
    if (!canCreateContest(actor)) {
      throw new AppError(403, 'contest_forbidden', 'You may not create contests.');
    }

    const startTime = new Date(body.startTime);
    const endTime = new Date(body.endTime);
    if (endTime.getTime() <= startTime.getTime()) {
      throw new AppError(400, 'contest_window_invalid', 'A contest must end after it starts.');
    }
    assertFreezeFits(source.frozenLastMinutes, startTime, endTime);

    const problemRows = await this.db
      .select({
        problemId: contestProblems.problemId,
        label: contestProblems.label,
        points: contestProblems.points,
        partial: contestProblems.partial,
        order: contestProblems.order,
      })
      .from(contestProblems)
      .where(eq(contestProblems.contestId, source.id))
      .orderBy(asc(contestProblems.order), asc(contestProblems.id));
    const orgIds = (
      await this.db
        .select({ orgId: contestOrgs.orgId })
        .from(contestOrgs)
        .where(eq(contestOrgs.contestId, source.id))
    ).map((row) => row.orgId);

    try {
      await this.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(contests)
          .values({
            key: body.newKey,
            name: body.newName,
            startTime,
            endTime,
            format: source.format,
            formatConfig: source.formatConfig,
            pointsPrecision: source.pointsPrecision,
            frozenLastMinutes: source.frozenLastMinutes,
            timeLimitSeconds: source.timeLimitSeconds,
            // `private`, never the source's own: a copy nobody has scheduled
            // yet must not appear on the public list the instant it exists.
            // An org restriction is still carried, so making it visible
            // later is one edit and not a rebuild.
            visibility: 'private',
            // Copied, like the format and the freeze: "this is a team round"
            // is part of the contest as a DESIGN, which is what a clone is
            // (D88). The org restriction is copied too, so a team clone still
            // has the schools its teams come from.
            participationMode: source.participationMode,
            maxTeamSize: source.maxTeamSize,
            createdBy: actor.userId,
          })
          .returning({ id: contests.id });
        if (orgIds.length > 0) {
          await tx.insert(contestOrgs).values(orgIds.map((orgId) => ({ contestId: created!.id, orgId })));
        }
        if (problemRows.length > 0) {
          await tx.insert(contestProblems).values(
            problemRows.map((row, index) => ({
              contestId: created!.id,
              problemId: row.problemId,
              label: row.label,
              points: row.points,
              partial: row.partial,
              // Renumbered from the read order rather than copied verbatim:
              // the source's `order` values may have gaps after an edit, and
              // what a format actually uses is the SEQUENCE.
              order: index,
            })),
          );
        }
      });
    } catch (error) {
      throw toCreateConflict(error);
    }

    return this.getVisible(actor, body.newKey);
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
    const participationMode = body.participationMode ?? contest.participationMode;
    const maxTeamSize = body.maxTeamSize ?? contest.maxTeamSize;
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
    // On the MERGED state too, and for the same reason: `{ orgSlugs: [] }`
    // alone must not strand a team contest with no school to pick a team
    // from, and `{ participationMode: 'team' }` alone must not be accepted
    // against a contest that names none.
    assertTeamModeHasOrgs(participationMode, nextOrgIds.length);

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
      // D99, on D38's rule. `participationMode` decides what a participation
      // IS and `maxTeamSize` decides who was allowed to make one, and both
      // are unanswerable over rows that already exist: flipping a running
      // team contest to `individual` leaves every row on the board naming a
      // competitor the contest no longer has. Nothing can have joined before
      // the start — `join` refuses with `contest_not_started` — so a
      // pre-start edit is always safe and is never refused here. Compared by
      // VALUE, so a form that PATCHes the whole body back is a no-op (D38).
      if (body.participationMode !== undefined && body.participationMode !== contest.participationMode) {
        throw new AppError(
          409,
          'contest_started',
          'This contest has started; individual and team entry can no longer be swapped.',
        );
      }
      if (body.maxTeamSize !== undefined && body.maxTeamSize !== contest.maxTeamSize) {
        throw new AppError(
          409,
          'contest_started',
          'This contest has started; its team size limit can no longer change.',
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
      // D161, first in the transaction and under the row's own lock — see
      // `ProblemAccessService.update`, which states the reasoning once. Read
      // outside the lock this check would only narrow the race it exists to
      // close; a throw here rolls back with nothing written, which is the
      // promise the 409 makes.
      //
      // AFTER the `contest_started` guards above, deliberately: "this contest
      // has started, its format can no longer change" is a fact about this
      // request that a reload cannot repair, and telling an organiser to load
      // a newer version first would send them round a loop that ends in the
      // same refusal.
      if (body.expectedVersion !== undefined) {
        await tx.execute(sql`select id from contests where id = ${contest.id} for update`);
        if ((await contestEditVersion(tx, contest.id)) !== body.expectedVersion) {
          throw versionConflict('contest');
        }
      }

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
          participationMode,
          maxTeamSize,
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
  async join(
    actor: Actor,
    key: string,
    body: JoinContestRequestDto = {},
  ): Promise<ContestParticipationDto> {
    const contest = await this.loadVisible(actor, key);
    const now = new Date();

    if (now < contest.startTime) {
      throw new AppError(409, 'contest_not_started', 'This contest has not started yet.');
    }
    if (contest.participationMode === 'team') {
      return this.joinAsTeam(actor, contest, now, body.teamSlug);
    }
    // REFUSED, not ignored: a competitor who named a team and was quietly
    // entered alone would find out on the scoreboard (D99).
    if (body.teamSlug !== undefined) {
      throw new AppError(
        422,
        'contest_team_unexpected',
        'This contest is entered individually, not by team.',
      );
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

    // One transaction, because of the seat (D104): the row and the seat that
    // says this person is competing here have to be one write or neither, or
    // a crash between them leaves a competitor the index does not know about.
    const inserted = await this.db
      .transaction(async (tx) => {
        const [row] = await tx
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
            teamId: contestParticipations.teamId,
          });
        // Only a LIVE row is seated; a virtual attempt is a replay, and the
        // identity index deliberately admits several of those per person.
        if (row && virtual === LIVE_VIRTUAL) {
          await seat(tx as Db, contest.id, row.id, [actor.userId]);
        }
        return row;
      })
      .catch((error: unknown) => {
        throw toSeatConflict(error);
      });
    if (inserted) return this.participationDto(contest, inserted);

    const raced = (await listParticipations(this.db, contest.id, actor.userId)).find(
      (participation) => participation.virtual === virtual,
    );
    if (!raced) throw new AppError(409, 'contest_join_conflict', 'Try joining again.');
    return this.participationDto(contest, raced);
  }

  /**
   * Entering a team contest (D99).
   *
   * **One participation per team, held by whichever member pressed the
   * button.** Everything else here follows from that single sentence: the
   * teammate who presses it second reads the row back only if they are the
   * account that made it (idempotency, `join`'s existing contract) and
   * otherwise gets 409 rather than a second row; every member's submissions
   * route to it through `actingParticipations`; and the board shows one row
   * with the team's name on it.
   *
   * **There is no virtual replay for a team.** The unique index is
   * `(team_id, contest_id)`, so a second row cannot exist at all — and that
   * is the honest shape rather than an omission: a virtual attempt is a
   * person re-sitting a finished paper, and "the team re-sits it" is a
   * different team every time its roster changes. A team that never entered
   * is therefore refused after the end rather than given `virtual = 1`.
   *
   * The refusals are ordered cheapest-and-least-revealing first: the team
   * has to exist among this contest's schools and the caller has to be on
   * it before anything about the CONTEST's roster is disclosed.
   */
  private async joinAsTeam(
    actor: Actor,
    contest: ContestRow & { id: number },
    now: Date,
    teamSlug: string | undefined,
  ): Promise<ContestParticipationDto> {
    if (teamSlug === undefined) {
      throw new AppError(
        422,
        'contest_team_required',
        'This contest is entered by team; name the team you are entering with.',
      );
    }
    // `actor.userId` disambiguates a slug two of the contest's schools share
    // (D99): the caller's OWN `doi-1` wins over a lowest-id one they are not on,
    // which would otherwise 422 them `contest_team_not_member` for a team they
    // may enter. The membership check below is still the gate for a genuine
    // non-member.
    const team = await resolveContestTeam(this.db, contest.id, teamSlug, actor.userId);
    // 422, not 404: `loadVisible` has already shown this caller the contest,
    // and the contest names its organizations in every response it serves
    // (D56) — there is no existence left to protect, and the answer a client
    // needs is "that is not a team of this contest's schools".
    if (!team) {
      throw new AppError(
        422,
        'contest_team_unknown',
        'No team with that slug belongs to this contest’s organizations.',
      );
    }
    const memberIds = await teamMemberIds(this.db, team.id);
    if (!memberIds.includes(actor.userId)) {
      throw new AppError(422, 'contest_team_not_member', 'You are not on that team.');
    }

    const [existing] = await this.db
      .select({
        id: contestParticipations.id,
        userId: contestParticipations.userId,
        virtual: contestParticipations.virtual,
        startTime: contestParticipations.startTime,
        isDisqualified: contestParticipations.isDisqualified,
        teamId: contestParticipations.teamId,
      })
      .from(contestParticipations)
      .where(
        and(
          eq(contestParticipations.contestId, contest.id),
          eq(contestParticipations.teamId, team.id),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.userId === actor.userId) return this.participationDto(contest, existing, team);
      throw new AppError(
        409,
        'contest_team_joined',
        'A teammate has already entered this team; you are competing on their row.',
      );
    }

    // D56, in the same place the individual path puts it: after the
    // idempotent read-back, before any row is minted.
    await this.assertMayJoin(actor, contest);

    if (now > contest.endTime) {
      throw new AppError(
        409,
        'contest_team_no_virtual',
        'This contest has ended, and a team contest has no virtual replay.',
      );
    }

    const entered = await this.enterTeam(contest, team, memberIds, actor.userId, now);
    if (entered.userId === actor.userId) return this.participationDto(contest, entered, team);
    throw new AppError(
      409,
      'contest_team_joined',
      'A teammate has already entered this team; you are competing on their row.',
    );
  }

  /**
   * Put ONE team on a contest's board, under a lock, or hand back the row
   * that is already there.
   *
   * **The lock is `(contest, case-folded team NAME)`, and the key is the
   * whole point.** D99 recorded a residual: two teams called the same thing
   * joining in the same instant both land, because neither check sees the
   * other's uncommitted row — and then the board's `teams` sidecar collapses
   * them into one entry, the scoreboard's disqualify control moves the WRONG
   * team, and one exported results sheet prints the wrong roster. Locking on
   * the team's ID would not close it: the racing rows belong to two
   * DIFFERENT teams, so a per-team lock never collides for them. Locking on
   * the name does, and it also serialises two teammates entering the same
   * team (same name, same lock), which is the other race this path has.
   *
   * `pg_advisory_xact_lock` rather than a row lock, because there is no row
   * to lock: the thing being made unique is a name that is not yet on the
   * board, in a table whose relevant row does not exist yet. It is held for
   * the transaction and released by the commit — which is why every check
   * below has to be INSIDE the transaction, and why the transaction exists at
   * all. `hashtext` collides across unrelated names roughly never, and a
   * collision costs one join a few milliseconds of waiting, not a wrong
   * answer.
   *
   * `startTime` is a parameter rather than `now()`: an organiser may seed a
   * team before the gun (D99 amended), and the row must not start before the
   * contest does.
   */
  private async enterTeam(
    contest: ContestRow & { id: number },
    team: ContestTeam,
    memberIds: number[],
    captainUserId: number,
    startTime: Date,
  ): Promise<TeamParticipationRow> {
    if (memberIds.length > contest.maxTeamSize) {
      throw new AppError(
        409,
        'contest_team_too_large',
        `This contest admits teams of at most ${String(contest.maxTeamSize)}.`,
      );
    }

    return this.db
      .transaction(async (tx) => {
      const db = tx as Db;
      await db.execute(
        sql`select pg_advisory_xact_lock(${contest.id}::int4, hashtext(lower(${team.name})))`,
      );

      // Re-read UNDER the lock. The caller has already read this once for
      // the idempotency answer; between then and here a teammate's join may
      // have committed, and returning their row is the same answer the
      // caller's own read would have given a moment later.
      const held = await this.teamParticipation(contest.id, team.id, db);
      if (held) return held;

      await this.assertMembersFree(contest.id, memberIds, db);
      await this.assertTeamNameFree(contest.id, team, db);

      const [inserted] = await db
        .insert(contestParticipations)
        .values({
          contestId: contest.id,
          userId: captainUserId,
          teamId: team.id,
          virtual: LIVE_VIRTUAL,
          startTime,
          isDisqualified: false,
        })
        // Belt to the lock's braces: the `(team_id, contest_id)` unique index
        // is what actually guarantees one row per team, and a process that
        // somehow skipped the lock must still not surface a 500.
        .onConflictDoNothing()
        .returning({
          id: contestParticipations.id,
          userId: contestParticipations.userId,
          virtual: contestParticipations.virtual,
          startTime: contestParticipations.startTime,
          isDisqualified: contestParticipations.isDisqualified,
          teamId: contestParticipations.teamId,
        });
      if (inserted) {
        // D104. EVERY member, not the captain alone: a team is one
        // participant and its whole roster competes on this row, which is
        // exactly what `assertMembersFree` above was asserting and what the
        // racing roster PATCH could get past.
        await seat(db, contest.id, inserted.id, memberIds);
        return inserted;
      }

      const raced = await this.teamParticipation(contest.id, team.id, db);
      if (!raced) throw new AppError(409, 'contest_join_conflict', 'Try joining again.');
      return raced;
      })
      .catch((error: unknown) => {
        // The seat's index is the only thing that can refuse here which the
        // checks above did not, and it must not read as a 500 (D104).
        throw toSeatConflict(error);
      });
  }

  /** The one participation a team holds in a contest, if it holds one. */
  private async teamParticipation(
    contestId: number,
    teamId: number,
    db: Db = this.db,
  ): Promise<TeamParticipationRow | undefined> {
    const [row] = await db
      .select({
        id: contestParticipations.id,
        userId: contestParticipations.userId,
        virtual: contestParticipations.virtual,
        startTime: contestParticipations.startTime,
        isDisqualified: contestParticipations.isDisqualified,
        teamId: contestParticipations.teamId,
      })
      .from(contestParticipations)
      .where(and(eq(contestParticipations.contestId, contestId), eq(contestParticipations.teamId, teamId)))
      .limit(1);
    return row;
  }

  /**
   * An organiser enters a team into their own contest (D99 as amended by
   * F-25) — D61's spirit, one rank up.
   *
   * On contest day the member who is supposed to press Join is a fifteen-year
   * old at a school computer whose password was issued this morning. The
   * organiser can already disqualify that team, answer its questions and
   * export its results; being unable to ENTER it is the one gap, and the way
   * that gap gets filled today is an invigilator borrowing a pupil's account.
   *
   * **Every check `join` makes, under the same lock.** The only differences
   * are the two this route has to decide for itself:
   *
   * - **who holds the row.** `contest_participations.user_id` is NOT NULL and
   *   is D99's captain — the username `PATCH .../participants/{username}`
   *   takes. Nobody pressed a button, so the choice is the LOWEST user id on
   *   the roster: deterministic, so two organisers seeding the same team
   *   twice cannot produce two different captains, and stable, so the
   *   disqualify control keeps working after a page refresh. An empty roster
   *   is refused (422) rather than given a null captain.
   * - **when it starts.** Seeding BEFORE the gun is the ordinary case — it is
   *   the whole point, an organiser preparing the room — so `join`'s
   *   `contest_not_started` refusal does not apply here; the participation
   *   starts when the CONTEST does. After the end it is refused, because a
   *   team has no virtual replay (D99) and a row minted into a finished
   *   contest would be a competitor who never competed.
   */
  async seedParticipant(
    actor: Actor,
    key: string,
    teamSlug: string,
  ): Promise<ContestParticipationDto> {
    const contest = await this.loadVisible(actor, key);
    if (!canRunContest(actor, contest)) {
      throw new AppError(403, 'contest_forbidden', 'You do not run this contest.');
    }
    if (contest.participationMode !== 'team') {
      throw new AppError(
        422,
        'contest_team_unexpected',
        'This contest is entered individually, not by team.',
      );
    }
    const team = await resolveContestTeam(this.db, contest.id, teamSlug);
    if (!team) {
      throw new AppError(
        422,
        'contest_team_unknown',
        'No team with that slug belongs to this contest’s organizations.',
      );
    }
    if (new Date() > contest.endTime) {
      throw new AppError(
        409,
        'contest_ended',
        'This contest has ended; a team cannot be entered into it now.',
      );
    }

    const memberIds = await teamMemberIds(this.db, team.id);
    if (memberIds.length === 0) {
      throw new AppError(
        422,
        'contest_team_empty',
        'This team has no members, so there is nobody to hold its entry.',
      );
    }
    const captainUserId = Math.min(...memberIds);
    // `max(now, startTime)` — never before the contest itself, and never
    // backdated for a seed made mid-round.
    const startTime = new Date(Math.max(Date.now(), contest.startTime.getTime()));

    const entered = await this.enterTeam(contest, team, memberIds, captainUserId, startTime);
    if (entered.teamId !== team.id) {
      throw new AppError(409, 'contest_join_conflict', 'Try again.');
    }
    return this.participationDto(contest, entered, team);
  }

  /**
   * Nobody on this team may already be competing in this contest — under
   * their own name, or on another team's row.
   *
   * Without it one person could hold two participations in one contest,
   * which breaks three things at once: `actingParticipations` would have to
   * choose between them for every submission, `setDisqualified` (keyed by
   * username, D37) would move both, and the board would show one competitor
   * twice with the same work counted on each.
   */
  private async assertMembersFree(
    contestId: number,
    memberIds: number[],
    db: Db = this.db,
  ): Promise<void> {
    const theirTeams = (
      await db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(inArray(teamMembers.userId, memberIds))
    ).map((row) => row.teamId);
    const mine = inArray(contestParticipations.userId, memberIds);
    const [clash] = await db
      .select({ id: contestParticipations.id })
      .from(contestParticipations)
      .where(
        and(
          eq(contestParticipations.contestId, contestId),
          theirTeams.length === 0
            ? mine
            : or(mine, inArray(contestParticipations.teamId, theirTeams)),
        ),
      )
      .limit(1);
    if (clash) {
      throw new AppError(
        409,
        'contest_already_joined',
        'Somebody on this team is already competing in this contest.',
      );
    }
  }

  /**
   * Two teams called the same thing may not compete in one contest.
   *
   * The board prints a team's NAME, and every consumer downstream of it —
   * the scoreboard's `teams` sidecar, the results sheet, a certificate, the
   * similarity report's pair links — keys on that name because the ranking
   * row carries no id (D36 declined to add one, and the goldens are why).
   * Refusing the collision at the one moment it can be created costs a
   * query; teaching five readers to disambiguate a name would cost a
   * response shape.
   *
   * Case-folded, the way every other name-ish uniqueness in this schema is:
   * two teams whose names differ only in case are one name on a printed
   * standings sheet.
   */
  private async assertTeamNameFree(
    contestId: number,
    team: ContestTeam,
    db: Db = this.db,
  ): Promise<void> {
    const [clash] = await db
      .select({ id: contestParticipations.id })
      .from(contestParticipations)
      .innerJoin(teams, eq(teams.id, contestParticipations.teamId))
      .where(
        and(
          eq(contestParticipations.contestId, contestId),
          sql`lower(${teams.name}) = lower(${team.name})`,
        ),
      )
      .limit(1);
    if (clash) {
      throw new AppError(
        409,
        'contest_team_name_taken',
        'Another team of that name is already competing in this contest.',
      );
    }
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

  /**
   * The caller's own participation, highest `virtual` first.
   *
   * `actingParticipations`, not `listParticipations`: in a team contest the
   * row belongs to whichever teammate pressed Join, and every other member
   * has to be told they are competing on it — this route is what the contest
   * page reads to decide whether to show a Join button (D99).
   */
  async myParticipation(actor: Actor, key: string): Promise<ContestParticipationDto> {
    const contest = await this.loadVisible(actor, key);
    const [participation] = await actingParticipations(this.db, contest.id, actor.userId);
    // 404 for "you have not joined". The caller already passed this contest's
    // own visibility check to get here, so this conceals nothing; it is the
    // not-found shape reused for an empty result.
    if (!participation) {
      throw new AppError(404, 'participation_not_found', 'You have not joined this contest.');
    }
    const team =
      participation.teamId === null
        ? undefined
        : (await loadContestTeams(this.db, [participation.teamId])).get(participation.teamId);
    return this.participationDto(contest, participation, team);
  }

  private participationDto(
    contest: ContestWindowRow,
    participation: ParticipationRow,
    team?: ContestTeam | undefined,
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
      // `null` for an individual entry, and for a team row whose team has
      // been deleted out from under it — which `ON DELETE RESTRICT` makes
      // impossible, so the branch is the type's, not a case that happens.
      team:
        team === undefined
          ? null
          : { slug: team.slug, name: team.name, orgSlug: team.orgSlug, members: team.members },
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
   * Every contest submission with its cases **summarised per group**, in
   * `contest_submissions.id` and first-seen group order — both load-bearing,
   * per `mapContest`.
   *
   * F-44's statement 34 was the one real hazard it found on any contest-morning
   * route: this used to read **every subtask case row of the contest** — two
   * `Parallel Seq Scan`s of `submission_cases` under a `submission_id =
   * ANY(<every submission id in the contest>)` list, an external merge sort
   * spilling ~4.5 MB, 17 650 buffers and 163 ms on a 2 000-pupil round —
   * shipping 240 000 rows to Node so that Node could reduce them per group. No
   * index fixes that: a sequential scan is already the optimal plan for reading
   * 96 % of a table. **The query was the finding.**
   *
   * D165's answer is that the reduction happens **once, at write time**, and
   * this reads it. `submissions.subtask_summary` is written by the same fenced
   * UPDATE that writes the verdict (`EventWriter.writeTerminal`), so it costs
   * this read nothing at all: it rides the statement that was already loading
   * every submission of the contest.
   *
   * **The residue is the correctness.** The summary is trusted only for a
   * submission that is `done` or `errored`; anything else — a submission
   * grading right now, whose per-case rows are still arriving and whose partial
   * score the board is supposed to show — falls back to the per-case read for
   * exactly those submissions. That fallback is what makes this an optimisation
   * rather than a second source of truth, and it cannot rot: every fold of a
   * live contest runs it.
   *
   * D166 records why the obvious alternative — summarising per fold with a
   * `GROUP BY`, which needs `sum(points ORDER BY id)` for the loose group to
   * stay bit-identical — was measured and refused.
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
        subtaskSummary: submissions.subtaskSummary,
      })
      .from(contestSubmissions)
      .innerJoin(
        contestParticipations,
        eq(contestParticipations.id, contestSubmissions.participationId),
      )
      .innerJoin(contestProblems, eq(contestProblems.id, contestSubmissions.contestProblemId))
      .innerJoin(problems, eq(problems.id, contestProblems.problemId))
      .innerJoin(submissions, eq(submissions.id, contestSubmissions.submissionId))
      .where(eq(contestParticipations.contestId, contestId));

    if (rows.length === 0) return [];

    // `contest_submissions.id` order is load-bearing — it is `groupByProblem`'s
    // first-seen order, which `ioi16` sums in — but it is ordered HERE rather
    // than by the database. Carrying `subtask_summary` makes these rows wide
    // enough that Postgres' own `ORDER BY` stopped fitting in `work_mem` and
    // spilled ~10 MB of temp per cold fold (19 ms and an in-memory quicksort
    // became 40 ms and an external merge). Sixteen thousand rows is nothing to
    // sort in Node, and the comparison is on a `bigserial` primary key, so this
    // is the same total order by a cheaper route.
    rows.sort((a, b) => a.id - b.id);

    const stored = new Map<number, ContestSubtaskRow[]>();
    const residue: number[] = [];
    for (const row of rows) {
      const summary = TERMINAL_STATES.has(row.state) ? readSubtaskSummary(row.subtaskSummary) : null;
      if (summary === null) residue.push(row.submissionId);
      else stored.set(row.submissionId, summary);
    }

    if (residue.length > 0) {
      for (const [submissionId, subtasks] of await this.loadSubtasksFromCases(residue)) {
        stored.set(submissionId, subtasks);
      }
    }

    return rows.map((row) => ({
      participationId: row.participationId,
      problemCode: row.problemCode,
      date: row.date,
      verdict: row.verdict,
      state: row.state,
      subtasks: stored.get(row.submissionId) ?? [],
    }));
  }

  /**
   * The old fold, kept for the submissions the stored summary cannot answer
   * for: one still grading, one a rejudge has re-queued, one migration 0045
   * never reached.
   *
   * It is the same two statements F-44 measured, over a list bounded by how
   * many submissions of this contest are mid-flight rather than by how many it
   * has ever taken — a judge grades about 35 a minute, so on contest morning
   * this is tens of rows against sixteen thousand. The `inArray` list is
   * therefore short by construction, which is the one thing the old shape could
   * not promise.
   */
  private async loadSubtasksFromCases(
    submissionIds: number[],
  ): Promise<Map<number, ContestSubtaskRow[]>> {
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
        submissionId: submissionCases.submissionId,
        groupIndex: submissionCases.groupIndex,
        points: submissionCases.points,
        maxPoints: submissionCases.maxPoints,
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

    const casesBySubmission = new Map<number, TestCaseSpec[]>();
    for (const row of caseRows) {
      const bucket = casesBySubmission.get(row.submissionId) ?? [];
      bucket.push({
        batch: row.groupIndex,
        // `case` and `status` are required by `TestCaseSpec` and read by
        // nothing — the summariser only ever looks at the batch and the two
        // point values — so filling them with constants is honest here in a
        // way it would not be if anything downstream read them.
        case: 0,
        points: row.points,
        total: row.maxPoints,
        status: 'AC',
      });
      casesBySubmission.set(row.submissionId, bucket);
    }

    // Every id asked for gets an answer, so a submission with no case rows at
    // all is an empty summary rather than a missing one.
    const out = new Map<number, ContestSubtaskRow[]>(
      submissionIds.map((submissionId) => [submissionId, []]),
    );
    for (const [submissionId, cases] of casesBySubmission) {
      out.set(submissionId, summariseCases(cases).map(toSubtaskRow));
    }
    return out;
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

/**
 * A team contest needs at least one organization (D99).
 *
 * Teams are org-scoped — `teams.slug` is unique per organization and
 * `resolveContestTeam` searches only the contest's own schools — so a team
 * contest attached to none is one nobody can name a team for. 422 rather
 * than the 400 `contest_org_missing` uses: the value is well-formed and the
 * request as a whole makes it impossible, which is the distinction 422
 * draws and the one `contest_freeze_too_long` already takes.
 */
function assertTeamModeHasOrgs(mode: ContestParticipationModeDto, orgCount: number): void {
  if (mode === 'team' && orgCount === 0) {
    throw new AppError(
      422,
      'contest_team_orgs_required',
      'A team contest must name at least one organization for its teams to come from.',
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
    participationMode: ContestParticipationModeDto;
    maxTeamSize: number;
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
    participationMode: row.participationMode,
    maxTeamSize: row.maxTeamSize,
    orgs,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The `phase` page's cursor (D151): `<start-time-in-ms>_<id>`.
 *
 * A keyset seek on `(start_time, id)`, not an offset — the same shape the id
 * cursor already has, extended by one column because start time is not
 * unique. Two rounds beginning at 08:00 on the same Saturday is the normal
 * case on this judge, and a single-column seek over a non-unique key either
 * repeats one of them on the next page or loses it.
 *
 * Garbage is 422 `invalid_cursor` — the same refusal the id cursor gives,
 * because a client that hands back a cursor from the OTHER ordering has made
 * exactly that mistake and should hear about it rather than silently read
 * page 1 again.
 */
function startTimeSeek(cursor: string | undefined): SQL | undefined {
  if (cursor === undefined) return undefined;
  const [millis, id, ...rest] = cursor.split('_');
  const after = Number(millis);
  const afterId = Number(id);
  if (
    rest.length > 0 ||
    id === undefined ||
    !Number.isSafeInteger(after) ||
    !Number.isSafeInteger(afterId) ||
    afterId < 0
  ) {
    throw new AppError(422, 'invalid_cursor', 'That page cursor is not valid.');
  }
  const at = new Date(after);
  return or(
    gt(contests.startTime, at),
    and(eq(contests.startTime, at), gt(contests.id, afterId)),
  );
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
