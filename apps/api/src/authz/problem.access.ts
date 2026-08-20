import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
import { problemRevisions, problems } from '@duckoj/db/guarded';
import type { Db } from '@duckoj/db';
import type { PaginationQueryDto } from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import { canViewProblem, loadProblemContext, visibleProblemsWhere, type ProblemVisibility } from './problem.visibility.js';
import type { Actor } from './actor.js';

export interface ProblemSummaryDto {
  id: number;
  code: string;
  name: string;
  visibility: ProblemVisibility;
  hasPublishedRevision: boolean;
  timeMs: number | null;
  memoryKb: number | null;
}

export interface ProblemPageDto {
  items: ProblemSummaryDto[];
  nextCursor: string | null;
}

export interface ProblemDetailDto extends ProblemSummaryDto {
  statement: string;
  testCount: number | null;
  totalPoints: number | null;
  checkerKind: string | null;
  createdAt: string;
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
 * The ONLY module permitted to import `@duckoj/db/guarded` for problems,
 * exactly as `org.access.ts` is for organizations — with the single
 * exception carved out for `SubmissionAccessService` (spec §3).
 */
@Injectable()
export class ProblemAccessService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listVisible(
    actor: Actor | null,
    // `cursor?: string | undefined` rather than `cursor?: string`: the
    // project compiles with `exactOptionalPropertyTypes`, under which a
    // parsed `PaginationQueryDto` is not assignable to the narrower form.
    page: Pick<PaginationQueryDto, 'limit'> & { cursor?: string | undefined },
    q?: string | undefined,
  ): Promise<ProblemPageDto> {
    const after = parseCursor(page.cursor);
    const conditions = [visibleProblemsWhere(this.db, actor), gt(problems.id, after)];
    if (q) {
      const pattern = `%${likeEscape(q.toLowerCase())}%`;
      conditions.push(
        or(
          sql`lower(${problems.code}) like ${pattern}`,
          sql`lower(${problems.name}) like ${pattern}`,
        )!,
      );
    }

    const rows = await this.db
      .select({
        id: problems.id,
        code: problems.code,
        name: problems.name,
        visibility: problems.visibility,
        revisionId: problemRevisions.id,
        timeMs: problemRevisions.timeMs,
        memoryKb: problemRevisions.memoryKb,
      })
      .from(problems)
      .leftJoin(
          problemRevisions,
          // The `state` term is not redundant. Every path that sets
          // `currentRevisionId` today points it at a published revision, but
          // that is convention across three call sites, not a database
          // constraint. Without this, a future bug leaving the pointer on an
          // archived revision would report that revision's stale limits as
          // live; with it, the same bug degrades to `hasPublishedRevision:
          // false`, which is at least honest.
          and(eq(problems.currentRevisionId, problemRevisions.id), eq(problemRevisions.state, 'published')),
        )
      .where(and(...conditions))
      .orderBy(asc(problems.id))
      .limit(page.limit + 1);

    const items = rows.slice(0, page.limit).map(toSummary);
    const nextCursor = rows.length > page.limit ? String(items.at(-1)!.id) : null;
    return { items, nextCursor };
  }

  async getVisible(actor: Actor | null, code: string): Promise<ProblemDetailDto> {
    const row = (
      await this.db
        .select({
          id: problems.id,
          code: problems.code,
          name: problems.name,
          statement: problems.statement,
          visibility: problems.visibility,
          createdAt: problems.createdAt,
          revisionId: problemRevisions.id,
          timeMs: problemRevisions.timeMs,
          memoryKb: problemRevisions.memoryKb,
          testCount: problemRevisions.testCount,
          totalPoints: problemRevisions.totalPoints,
          checkerKind: problemRevisions.checkerKind,
        })
        .from(problems)
        .leftJoin(
          problemRevisions,
          // The `state` term is not redundant. Every path that sets
          // `currentRevisionId` today points it at a published revision, but
          // that is convention across three call sites, not a database
          // constraint. Without this, a future bug leaving the pointer on an
          // archived revision would report that revision's stale limits as
          // live; with it, the same bug degrades to `hasPublishedRevision:
          // false`, which is at least honest.
          and(eq(problems.currentRevisionId, problemRevisions.id), eq(problemRevisions.state, 'published')),
        )
        .where(sql`lower(${problems.code}) = lower(${code})`)
        .limit(1)
    )[0];

    // Same 404 for "absent" and "invisible" — a distinct code (or a 403)
    // would itself be an existence oracle for a problem the actor may not
    // see (spec §3, item 2).
    if (!row) throw new AppError(404, 'problem_not_found', 'No such problem.');

    const ctx = await loadProblemContext(this.db, actor, row.id);
    if (!canViewProblem(actor, { id: row.id, visibility: row.visibility }, ctx)) {
      throw new AppError(404, 'problem_not_found', 'No such problem.');
    }

    return {
      ...toSummary(row),
      statement: row.statement,
      testCount: row.revisionId === null ? null : row.testCount,
      totalPoints: row.revisionId === null ? null : row.totalPoints,
      checkerKind: row.revisionId === null ? null : row.checkerKind,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

function toSummary(row: {
  id: number;
  code: string;
  name: string;
  visibility: ProblemVisibility;
  revisionId: number | null;
  timeMs: number | null;
  memoryKb: number | null;
}): ProblemSummaryDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    visibility: row.visibility,
    hasPublishedRevision: row.revisionId !== null,
    timeMs: row.revisionId === null ? null : row.timeMs,
    memoryKb: row.revisionId === null ? null : row.memoryKb,
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
