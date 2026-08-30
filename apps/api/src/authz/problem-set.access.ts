import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNotNull, lte, sql, type SQL } from 'drizzle-orm';
import {
  orgMembers,
  problemOrgs,
  problemSetItems,
  problemSets,
  problems,
  submissions,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { csvQuote, csvSheet, csvText } from '@duckoj/contracts';
import type {
  CreateProblemSetRequestDto,
  PaginationQueryDto,
  ProblemSetAttemptDto,
  ProblemSetCellDto,
  ProblemSetDetailDto,
  ProblemSetItemInputDto,
  ProblemSetPageDto,
  ProblemSetProgressDto,
  ProblemSetProgressQueryDto,
  UpdateProblemSetRequestDto,
} from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import { isAdmin, type Actor } from './actor.js';
import { OrgAccessService, parseMemberCursor } from './org.access.js';
import { visibleProblemsWhere } from './problem.visibility.js';
import { contestWindowOpenWhere } from './submission.freeze.js';

const UNIQUE_VIOLATION = '23505';
const SET_SLUG_CONSTRAINT = 'problem_sets_org_slug_lower_idx';

/** One row of `problem_sets`, as every method here reads it. */
interface SetRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  deadline: Date | null;
  createdAt: Date;
}

interface ItemRow {
  problemId: number;
  code: string;
  name: string;
  order: number;
  points: number;
}

/** One row of the per-side "best submission" query. */
interface BestRow {
  userId: number;
  problemId: number;
  verdict: string | null;
  points: number | null;
  maxPoints: number | null;
  createdAt: Date;
}

/** A `ProblemSetCell` before its timestamps are serialised. */
interface Cell {
  onTime: ProblemSetAttemptDto | null;
  late: ProblemSetAttemptDto | null;
}

/** `${userId}:${problemId}` — the key every cell map is built on. */
function cellKey(userId: number, problemId: number): string {
  return `${String(userId)}:${String(problemId)}`;
}

/**
 * How far the CSV export walks, and in what steps (D66, amended by the F13
 * owed sweep).
 *
 * Injected rather than read as a module constant, exactly as
 * `MAX_SUBSCRIPTIONS` is: twenty thousand members cannot be built in a test,
 * and a cap nobody can reach is a cap nobody has tested.
 *
 * `pageSize` is the roster page the walk fetches at a time — it also bounds
 * the `IN` list of the per-page best-submission query, which the old
 * whole-roster branch fed the entire school. `rowCap` is where the file
 * stops and admits it stopped.
 */
export const PROGRESS_EXPORT_BOUNDS = Symbol('PROGRESS_EXPORT_BOUNDS');
export interface ProgressExportBounds {
  pageSize: number;
  rowCap: number;
}
export const DEFAULT_PROGRESS_EXPORT_BOUNDS: ProgressExportBounds = {
  pageSize: 500,
  rowCap: 20_000,
};

/**
 * Classroom problem sets — a school's homework (D66).
 *
 * Three questions decide every call here, in this order, and none of them is
 * asked twice in this file:
 *
 * 1. **May this actor see the organization?** `OrgAccessService`'s own
 *    `loadVisibleWithRole` / `loadForEdit`, never a second copy of
 *    `visibleOrgsWhere` — a school the caller may not see stays a 404 with
 *    no mention of sets at all.
 * 2. **Do they belong to it?** Homework is for the class. A non-member of a
 *    *visible* organization gets an EMPTY page from the list and a 404 from
 *    every set, rather than a 403: "no sets" is exactly what a school that
 *    has assigned none returns, and existence is what the 404-over-403 rule
 *    protects. It matters beyond tidiness — an item may name an
 *    `org`-visibility problem shared with this school alone, so a readable
 *    set is a readable list of problem codes.
 * 3. **Do they run it?** Owner or admin (or a global admin) for every write
 *    and for the progress grid, which is about other people.
 */
@Injectable()
export class ProblemSetAccessService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OrgAccessService) private readonly orgs: OrgAccessService,
    @Inject(PROGRESS_EXPORT_BOUNDS) private readonly exportBounds: ProgressExportBounds,
  ) {}

  /**
   * The sets of one organization, with the caller's own progress on each.
   *
   * A non-member sees an empty page — see the class comment. `itemCount` and
   * `solvedCount` are two grouped queries for the whole page, never one per
   * row.
   */
  async list(actor: Actor, slug: string, page: PaginationQueryDto): Promise<ProblemSetPageDto> {
    const { row: org, role } = await this.orgs.loadVisibleWithRole(actor, slug);
    if (!isMember(actor, role)) return { items: [], nextCursor: null };

    const after = parseSetCursor(page.cursor);
    const rows = await this.db
      .select({
        id: problemSets.id,
        slug: problemSets.slug,
        name: problemSets.name,
        description: problemSets.description,
        deadline: problemSets.deadline,
        createdAt: problemSets.createdAt,
      })
      .from(problemSets)
      .where(and(eq(problemSets.orgId, org.id), gt(problemSets.id, after)))
      .orderBy(asc(problemSets.id))
      .limit(page.limit + 1);

    const kept = rows.slice(0, page.limit);
    const ids = kept.map((row) => row.id);
    const [counts, solved] = await Promise.all([
      this.itemCounts(ids),
      this.solvedCounts(actor.userId, ids),
    ]);
    const items = kept.map((row) => toSummary(row, counts.get(row.id) ?? 0, solved.get(row.id) ?? 0));
    return {
      items,
      nextCursor: rows.length > page.limit ? String(kept.at(-1)!.id) : null,
    };
  }

  /** One set, with the caller's own best attempt — on time and late — per problem. */
  async get(actor: Actor, slug: string, setSlug: string): Promise<ProblemSetDetailDto> {
    const { row: org, role } = await this.orgs.loadVisibleWithRole(actor, slug);
    if (!isMember(actor, role)) throw setNotFound();
    const set = await this.findSet(org.id, setSlug);
    return this.detailOf(actor, set);
  }

  /**
   * The grid: the roster down the side, the set across the top.
   *
   * Owner or admin (`loadForEdit`, the same 404-then-403 order every other
   * organization write takes). Rows are D58's roster page — keyset on
   * `username`, the same cursor and the same 422 for one too long. The CSV
   * export walks the same pages rather than taking a different route through
   * the data: see `progressExport`.
   */
  async progress(
    actor: Actor,
    slug: string,
    setSlug: string,
    query: ProblemSetProgressQueryDto,
  ): Promise<ProblemSetProgressDto> {
    const { row: org } = await this.orgs.loadForEdit(actor, slug);
    const set = await this.findSet(org.id, setSlug);
    const items = await this.itemsOf(set.id);
    return this.gridPage(org.id, set, items, query.cursor, query.limit);
  }

  /**
   * The whole grid for the spreadsheet — walked, not slurped (D66 amended).
   *
   * The export still refuses to stop at a page: a file that ends after
   * twenty-five pupils is a file somebody would mark a class from. But
   * "every row in one query, one array, no bound" was the F9 report's own
   * concern, so the walk now pages the roster (`pageSize`), which also bounds
   * the `IN` list of each page's best-submission query, and stops at
   * `rowCap`. The caller is told it stopped — `truncated` rides back so the
   * file can say so on its last line, rather than a teacher silently marking
   * a class from a file that ended early.
   */
  async progressExport(
    actor: Actor,
    slug: string,
    setSlug: string,
  ): Promise<{ grid: ProblemSetProgressDto; truncated: boolean }> {
    const { row: org } = await this.orgs.loadForEdit(actor, slug);
    const set = await this.findSet(org.id, setSlug);
    const items = await this.itemsOf(set.id);

    const { pageSize, rowCap } = this.exportBounds;
    const rows: ProblemSetProgressDto['rows'] = [];
    let cursor: string | undefined;
    let grid = await this.gridPage(org.id, set, items, cursor, pageSize);
    for (;;) {
      // A page may overshoot the cap by up to `pageSize - 1` rows, so it is
      // cut here rather than trusted: the cap is a promise about the FILE.
      rows.push(...grid.rows.slice(0, rowCap - rows.length));
      if (rows.length >= rowCap) return { grid: { ...grid, rows, nextCursor: null }, truncated: true };
      if (grid.nextCursor === null) break;
      cursor = grid.nextCursor;
      grid = await this.gridPage(org.id, set, items, cursor, pageSize);
    }
    return { grid: { ...grid, rows, nextCursor: null }, truncated: false };
  }

  /**
   * One page of the grid, from an organization and set already authorized.
   *
   * The JSON route and the CSV export share it, so the two representations
   * cannot come to disagree about what a cell holds — the property the F9
   * controller comment claimed and the old `whole` branch quietly broke by
   * running a second, unlimited query.
   */
  private async gridPage(
    orgId: number,
    set: SetRow,
    items: Awaited<ReturnType<ProblemSetAccessService['itemsOf']>>,
    cursor: string | undefined,
    limit: number,
  ): Promise<ProblemSetProgressDto> {
    const after = parseMemberCursor(cursor);
    const members = await this.db
      .select({
        userId: orgMembers.userId,
        username: schema.users.username,
        displayName: schema.users.displayName,
        role: orgMembers.role,
      })
      .from(orgMembers)
      .innerJoin(schema.users, eq(schema.users.id, orgMembers.userId))
      .where(
        after === null
          ? eq(orgMembers.orgId, orgId)
          : and(eq(orgMembers.orgId, orgId), gt(schema.users.username, after)),
      )
      .orderBy(asc(schema.users.username))
      .limit(limit + 1);

    const kept = members.slice(0, limit);
    // D49's exclusion, and the one thing the grid does that the pupil's own
    // view does not: a submission whose contest participation window is
    // still open counts for nobody, the teacher included. Without it a set
    // that reuses a contest problem is a live scoreboard of that room.
    const best = await this.bestByUserProblem(
      kept.map((row) => row.userId),
      items.map((item) => item.problemId),
      set.deadline,
      true,
    );

    return {
      slug: set.slug,
      name: set.name,
      deadline: set.deadline?.toISOString() ?? null,
      columns: items.map((item) => ({ code: item.code, name: item.name, points: item.points })),
      rows: kept.map((member) => ({
        username: member.username,
        displayName: member.displayName,
        role: member.role,
        cells: items.map((item) => toCell(best.get(cellKey(member.userId, item.problemId)))),
      })),
      nextCursor: members.length > limit ? kept.at(-1)!.username : null,
    };
  }

  /** Assign a set. Owner or admin. */
  async create(actor: Actor, slug: string, body: CreateProblemSetRequestDto): Promise<ProblemSetDetailDto> {
    const { row: org } = await this.orgs.loadForEdit(actor, slug);
    const items = await this.resolveItems(org.id, body.problems);

    let setId: number;
    try {
      setId = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(problemSets)
          .values({
            orgId: org.id,
            slug: body.slug,
            name: body.name,
            description: body.description,
            deadline: body.deadline === null ? null : new Date(body.deadline),
            createdBy: actor.userId,
          })
          .returning({ id: problemSets.id });
        if (items.length > 0) {
          await tx.insert(problemSetItems).values(items.map((item) => ({ setId: row!.id, ...item })));
        }
        return row!.id;
      });
    } catch (error) {
      throw toSetConflict(error);
    }
    return this.detailOf(actor, await this.findSetById(setId));
  }

  /**
   * Edit a set. `problems`, when present, replaces the list — the whole list,
   * order included, which is why it is a delete-then-insert inside one
   * transaction rather than a diff: a diff of an ordered list has to decide
   * what a move means, and the client already told us the final order.
   */
  async update(
    actor: Actor,
    slug: string,
    setSlug: string,
    patch: UpdateProblemSetRequestDto,
  ): Promise<ProblemSetDetailDto> {
    const { row: org } = await this.orgs.loadForEdit(actor, slug);
    const set = await this.findSet(org.id, setSlug);
    const items = patch.problems ? await this.resolveItems(org.id, patch.problems) : undefined;

    const values: Partial<typeof problemSets.$inferInsert> = {};
    if (patch.slug !== undefined) values.slug = patch.slug;
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.deadline !== undefined) {
      values.deadline = patch.deadline === null ? null : new Date(patch.deadline);
    }

    try {
      await this.db.transaction(async (tx) => {
        if (Object.keys(values).length > 0) {
          await tx.update(problemSets).set(values).where(eq(problemSets.id, set.id));
        }
        if (items !== undefined) {
          await tx.delete(problemSetItems).where(eq(problemSetItems.setId, set.id));
          if (items.length > 0) {
            await tx.insert(problemSetItems).values(items.map((item) => ({ setId: set.id, ...item })));
          }
        }
      });
    } catch (error) {
      throw toSetConflict(error);
    }
    return this.detailOf(actor, await this.findSetById(set.id));
  }

  /** Withdraw a set. The items go with it (`ON DELETE CASCADE`). */
  async remove(actor: Actor, slug: string, setSlug: string): Promise<void> {
    const { row: org } = await this.orgs.loadForEdit(actor, slug);
    const set = await this.findSet(org.id, setSlug);
    await this.db.delete(problemSets).where(eq(problemSets.id, set.id));
  }

  /**
   * The set, its items, and the caller's own cells.
   *
   * `me` is NOT run through D49's contest exclusion, and that asymmetry with
   * the grid is deliberate: D23 exempts a submission's own author from every
   * mask this codebase has, and hiding a pupil's own result from them would
   * be a mask protecting them from themselves. The consequence, accepted: a
   * pupil sitting a contest that reuses a set problem sees their score on
   * this page before their teacher's grid does.
   */
  private async detailOf(actor: Actor, set: SetRow): Promise<ProblemSetDetailDto> {
    const items = await this.itemsOf(set.id);
    const problemIds = items.map((item) => item.problemId);
    const [visible, best] = await Promise.all([
      this.visibleProblemIds(actor, problemIds),
      this.bestByUserProblem([actor.userId], problemIds, set.deadline, false),
    ]);

    const cells = items.map((item) => toCell(best.get(cellKey(actor.userId, item.problemId))));
    const solved = cells.filter(isSolved).length;
    return {
      ...toSummary(set, items.length, solved),
      items: items.map((item, index) => ({
        code: item.code,
        name: item.name,
        order: item.order,
        points: item.points,
        visible: visible.has(item.problemId),
        me: cells[index]!,
      })),
    };
  }

  private async findSet(orgId: number, setSlug: string): Promise<SetRow> {
    const [row] = await this.db
      .select({
        id: problemSets.id,
        slug: problemSets.slug,
        name: problemSets.name,
        description: problemSets.description,
        deadline: problemSets.deadline,
        createdAt: problemSets.createdAt,
      })
      .from(problemSets)
      .where(and(eq(problemSets.orgId, orgId), sql`lower(${problemSets.slug}) = lower(${setSlug})`))
      .limit(1);
    if (!row) throw setNotFound();
    return row;
  }

  /**
   * By id, with no organization check — the caller has just created or
   * edited this exact row, so re-deriving it from a slug that may have just
   * changed underneath the read would be a second lookup, not a safer one
   * (`OrgAccessService.update`'s own reasoning).
   */
  private async findSetById(id: number): Promise<SetRow> {
    const [row] = await this.db
      .select({
        id: problemSets.id,
        slug: problemSets.slug,
        name: problemSets.name,
        description: problemSets.description,
        deadline: problemSets.deadline,
        createdAt: problemSets.createdAt,
      })
      .from(problemSets)
      .where(eq(problemSets.id, id))
      .limit(1);
    if (!row) throw setNotFound();
    return row;
  }

  private async itemsOf(setId: number): Promise<ItemRow[]> {
    return this.db
      .select({
        problemId: problemSetItems.problemId,
        code: problems.code,
        name: problems.name,
        order: problemSetItems.order,
        points: problemSetItems.points,
      })
      .from(problemSetItems)
      .innerJoin(problems, eq(problems.id, problemSetItems.problemId))
      .where(eq(problemSetItems.setId, setId))
      // `problem_id` after `order` so a set whose orders were written equal
      // still renders in one fixed sequence — a grid whose columns permute
      // between two loads is a grid a teacher cannot read across.
      .orderBy(asc(problemSetItems.order), asc(problemSetItems.problemId));
  }

  /** How many problems each set holds — one query for a whole page. */
  private async itemCounts(setIds: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (setIds.length === 0) return out;
    const rows = await this.db
      .select({ setId: problemSetItems.setId, count: sql<number>`count(*)::int` })
      .from(problemSetItems)
      .where(inArray(problemSetItems.setId, setIds))
      .groupBy(problemSetItems.setId);
    for (const row of rows) out.set(row.setId, row.count);
    return out;
  }

  /**
   * How many problems of each set this viewer holds an `AC` on — one query
   * for a whole page, and about the VIEWER only.
   *
   * Late solves count here: this is "how much of the homework have you
   * actually done", and the deadline's job is done by the cells, which say
   * which side of it each attempt fell on. `count(distinct problem_id)`
   * because a pupil with three ACs on one problem has still done one.
   */
  private async solvedCounts(userId: number, setIds: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (setIds.length === 0) return out;
    const rows = await this.db
      .select({
        setId: problemSetItems.setId,
        count: sql<number>`count(distinct ${problemSetItems.problemId})::int`,
      })
      .from(problemSetItems)
      .innerJoin(
        submissions,
        and(
          eq(submissions.problemId, problemSetItems.problemId),
          eq(submissions.userId, userId),
          eq(submissions.verdict, 'AC'),
        ),
      )
      .where(inArray(problemSetItems.setId, setIds))
      .groupBy(problemSetItems.setId);
    for (const row of rows) out.set(row.setId, row.count);
    return out;
  }

  /** Which of `problemIds` this actor may actually open. */
  private async visibleProblemIds(actor: Actor, problemIds: number[]): Promise<Set<number>> {
    if (problemIds.length === 0) return new Set();
    const rows = await this.db
      .select({ id: problems.id })
      .from(problems)
      .where(and(visibleProblemsWhere(this.db, actor), inArray(problems.id, problemIds)));
    return new Set(rows.map((row) => row.id));
  }

  /**
   * The best graded submission each of `userIds` has on each of
   * `problemIds`, **on each side of the deadline** — at most two rows per
   * pair, which is what a `ProblemSetCell` is.
   *
   * One query per side of the deadline for a whole page of pupils and a
   * whole set, never one per cell, each a `DISTINCT ON (user_id,
   * problem_id)` under the ordering that defines "best" — max `points`, ties
   * to the earliest submission, `NULLS LAST` so an unscored IE only ever
   * wins when it is the only graded attempt. That is `ProblemMe`'s rule and
   * `submissions_user_problem_points_idx`'s own order, deliberately: two
   * different answers to "your best submission" on two screens of the same
   * site is a bug report nobody can reproduce.
   *
   * `verdict IS NOT NULL` is the "graded" predicate, for the reason
   * `bestSubmissionLateral` documents at length: a CE sets `points` but not
   * `maxPoints`, and an IE sets neither, so filtering on the numbers hides
   * exactly the failures a beginner needs to see.
   *
   * The deadline is INCLUSIVE — `created_at > deadline` is late — so a
   * submission made at the stroke of the deadline is on time (D66).
   */
  private async bestByUserProblem(
    userIds: number[],
    problemIds: number[],
    deadline: Date | null,
    excludeOpenContests: boolean,
  ): Promise<Map<string, Cell>> {
    const out = new Map<string, Cell>();
    if (userIds.length === 0 || problemIds.length === 0) return out;

    const put = (rows: BestRow[], side: 'onTime' | 'late'): void => {
      for (const row of rows) {
        const key = cellKey(row.userId, row.problemId);
        const cell = out.get(key) ?? { onTime: null, late: null };
        cell[side] = {
          verdict: row.verdict as ProblemSetAttemptDto['verdict'],
          points: row.points,
          maxPoints: row.maxPoints,
          submittedAt: row.createdAt.toISOString(),
          // "Solved at" is a claim about solving it: a 40/100 partial has not.
          solvedAt: row.verdict === 'AC' ? row.createdAt.toISOString() : null,
        };
        out.set(key, cell);
      }
    };

    // Two queries, one per side of the deadline, rather than one carrying a
    // `late` flag through `DISTINCT ON`: Postgres requires the `DISTINCT ON`
    // expressions to match the leading `ORDER BY` ones, and a parameterised
    // expression repeated in both positions is two different parameters to
    // the planner even when it is one string here. A `WHERE` per side needs
    // no such agreement, and each half is then exactly the two-column
    // `DISTINCT ON` `submissions_user_problem_points_idx` already orders.
    put(
      await this.bestOneSide(
        userIds,
        problemIds,
        deadline === null ? undefined : lte(submissions.createdAt, deadline),
        excludeOpenContests,
      ),
      'onTime',
    );
    // Skipped entirely without a deadline: there is nothing to be late for,
    // and `late` must then be `null` rather than "no rows happened to match".
    if (deadline !== null) {
      put(
        await this.bestOneSide(userIds, problemIds, gt(submissions.createdAt, deadline), excludeOpenContests),
        'late',
      );
    }
    return out;
  }

  /** One side of the deadline: the best graded submission per (user, problem). */
  private async bestOneSide(
    userIds: number[],
    problemIds: number[],
    side: SQL | undefined,
    excludeOpenContests: boolean,
  ): Promise<BestRow[]> {
    const conditions = [
      inArray(submissions.userId, userIds),
      inArray(submissions.problemId, problemIds),
      isNotNull(submissions.verdict),
    ];
    if (side !== undefined) conditions.push(side);
    if (excludeOpenContests) {
      conditions.push(sql`not (${contestWindowOpenWhere(new Date())})`);
    }
    return this.db
      .selectDistinctOn([submissions.userId, submissions.problemId], {
        userId: submissions.userId,
        problemId: submissions.problemId,
        verdict: submissions.verdict,
        points: submissions.points,
        maxPoints: submissions.maxPoints,
        createdAt: submissions.createdAt,
      })
      .from(submissions)
      .where(and(...conditions))
      .orderBy(
        asc(submissions.userId),
        asc(submissions.problemId),
        sql`${submissions.points} desc nulls last`,
        asc(submissions.id),
      );
  }

  /**
   * Problem codes to rows of `problem_set_items`, refusing anything the
   * school's own members could not open.
   *
   * "Visible to the organization's members" is `public`, or `org` shared
   * with THIS organization — never `private`, and never `org` shared with a
   * different school. Refused (422) rather than quietly dropped or silently
   * assigned: homework half the class cannot read is worse than a form that
   * says no, and a setter narrowing their problem afterwards is a different
   * problem, handled by `visible` on the item.
   *
   * Every failure lands in `fields`, keyed `problems[<i>].code` with `i` the
   * position in the request, so a picker can put the message beside the row
   * that caused it. The `code` names the FIRST class of failure seen; the
   * fields name every one.
   */
  private async resolveItems(
    orgId: number,
    inputs: ProblemSetItemInputDto[],
  ): Promise<Array<{ problemId: number; order: number; points: number }>> {
    if (inputs.length === 0) return [];
    const fields: Record<string, string[]> = {};
    let failure: string | null = null;
    const fail = (index: number, code: string, message: string): void => {
      failure ??= code;
      (fields[`problems[${String(index)}].code`] ??= []).push(message);
    };

    const codes = inputs.map((input) => input.code.toLowerCase());
    const rows = await this.db
      .select({ id: problems.id, code: problems.code, visibility: problems.visibility })
      .from(problems)
      .where(inArray(sql`lower(${problems.code})`, codes));
    const byCode = new Map(rows.map((row) => [row.code.toLowerCase(), row]));

    // Skipped rather than asked with an empty `IN ()`: every code in the
    // request was unknown, so there is nothing to share with anybody.
    const sharedRows =
      rows.length === 0
        ? []
        : await this.db
            .select({ problemId: problemOrgs.problemId })
            .from(problemOrgs)
            .where(
              and(
                eq(problemOrgs.orgId, orgId),
                inArray(
                  problemOrgs.problemId,
                  rows.map((row) => row.id),
                ),
              ),
            );
    const shared = new Set(sharedRows.map((row) => row.problemId));

    const seen = new Set<string>();
    const items: Array<{ problemId: number; order: number; points: number }> = [];
    inputs.forEach((input, index) => {
      const key = input.code.toLowerCase();
      const row = byCode.get(key);
      if (!row) {
        fail(index, 'problem_set_problem_unknown', 'No problem has that code.');
        return;
      }
      if (seen.has(key)) {
        fail(index, 'problem_set_problem_duplicate', 'That problem is already in this set.');
        return;
      }
      seen.add(key);
      const assignable = row.visibility === 'public' || (row.visibility === 'org' && shared.has(row.id));
      if (!assignable) {
        fail(
          index,
          'problem_set_problem_private',
          "This organization's members cannot open that problem.",
        );
        return;
      }
      items.push({ problemId: row.id, order: index, points: input.points });
    });

    if (failure !== null) {
      throw new AppError(422, failure, 'This set names a problem it cannot use.', fields);
    }
    return items;
  }
}

/**
 * The grid as a CSV a teacher can open in a spreadsheet, plus the one line
 * that admits the export stopped at its cap.
 *
 * One column per problem, and a second `<code> (late)` column per problem
 * when the set has a deadline — a deadline nobody can see the other side of
 * buys the teacher nothing. A cell is the attempt's `points`, empty for a
 * problem never attempted.
 *
 * The BYTES are `@duckoj/contracts/spreadsheet-csv.ts` — D71's rule, which
 * was written down for the results sheet and implemented there alone. It
 * applies here in the sharpest form it takes anywhere: the person-typed
 * column is the display name of the pupil being exported, chosen by them,
 * and the person who opens the file in Excel is their teacher. A display
 * name of `=HYPERLINK("http://evil","Nguyễn Văn A")` used to reach that
 * spreadsheet as a formula. The BOM is not decoration either — a class list
 * without one is a page of mojibake in the one program it exists for.
 * Generated cells (a score, a verdict, the trailer's count) are quoted and
 * never guarded.
 */
export function progressCsv(grid: ProblemSetProgressDto, truncated = false): string {
  const dated = grid.deadline !== null;
  const header = ['username', 'displayName'];
  for (const column of grid.columns) {
    header.push(column.code);
    if (dated) header.push(`${column.code} (late)`);
  }
  const rows = [header.map(csvQuote)];
  for (const row of grid.rows) {
    const line = [csvText(row.username), csvText(row.displayName)];
    row.cells.forEach((cell) => {
      line.push(csvQuote(score(cell?.onTime ?? null)));
      if (dated) line.push(csvQuote(score(cell?.late ?? null)));
    });
    rows.push(line);
  }
  // The trailer, only when the file actually stopped early: the count beside
  // it says how many rows the file does carry, because a teacher who marks
  // from a short file must be able to see that it is short, and a script
  // must be able to. It is NOT distinguished by its first cell — `truncated`
  // is a valid username (D8) and a pupil could hold it — but by its width:
  // a data row carries a cell for every column.
  if (truncated) rows.push(['truncated', String(grid.rows.length)]);
  return csvSheet(rows);
}

/**
 * One cell's number for the sheet: the points it scored, or the verdict when
 * the judge recorded no number at all (a CE, an IE). Empty for nothing.
 */
function score(attempt: ProblemSetAttemptDto | null): string {
  if (attempt === null) return '';
  return attempt.points === null ? attempt.verdict : String(attempt.points);
}

function isMember(actor: Actor, role: string | null): boolean {
  return isAdmin(actor) || role !== null;
}

/**
 * ONE answer to three questions: there is no such set, it is in an
 * organization you may not see, or it is in one you do not belong to. The
 * 404-over-403 rule — existence is what it protects, and a school's homework
 * list is one of the few org facts that is not public credit.
 */
function setNotFound(): AppError {
  return new AppError(404, 'problem_set_not_found', 'No such problem set.');
}

function toSummary(
  set: Omit<SetRow, 'id'>,
  itemCount: number,
  solvedCount: number,
): {
  slug: string;
  name: string;
  description: string | null;
  deadline: string | null;
  itemCount: number;
  solvedCount: number;
  createdAt: string;
} {
  return {
    slug: set.slug,
    name: set.name,
    description: set.description,
    deadline: set.deadline?.toISOString() ?? null,
    itemCount,
    solvedCount,
    createdAt: set.createdAt.toISOString(),
  };
}

/** `undefined` (nothing graded) and a cell are one shape to the client: `null`. */
function toCell(cell: Cell | undefined): ProblemSetCellDto {
  if (cell === undefined) return null;
  return { onTime: cell.onTime, late: cell.late };
}

function isSolved(cell: ProblemSetCellDto): boolean {
  return cell?.onTime?.verdict === 'AC' || cell?.late?.verdict === 'AC';
}

/**
 * A racing duplicate slug, as the 409 a SELECT-then-INSERT pre-check would
 * have produced had it won the race — `toOrgConflict`'s shape, mapping this
 * table's own constraint.
 */
function toSetConflict(error: unknown): unknown {
  const unique = asUniqueViolation(error);
  if (unique?.constraint_name === SET_SLUG_CONSTRAINT) {
    return new AppError(409, 'problem_set_slug_taken', 'This organization already has a set with that slug.');
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

/** A set list cursor is a `problem_sets.id`, like every other id cursor here. */
function parseSetCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const after = Number(cursor);
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new AppError(422, 'invalid_cursor', 'That page cursor is not valid.');
  }
  return after;
}
