import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { problemComments, problems } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import type {
  CreateCommentRequestDto,
  ProblemCommentDto,
  ProblemCommentPageDto,
  ProblemCommentThreadDto,
  UpdateCommentRequestDto,
} from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import { RateLimiter } from '../common/rate-limiter.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { isAdmin, type Actor } from './actor.js';
import {
  canViewProblem,
  contestHiddenProblemIds,
  loadProblemContext,
  type ProblemVisibility,
} from './problem.visibility.js';

/** D80's family: a per-user hourly window, counted in `rate_events`. */
const COMMENT_PURPOSE = 'problem_comment';
const COMMENT_LIMIT = 10;
const COMMENT_WINDOW_MS = 3_600_000;

/**
 * The default and the ceiling for a page of top-level threads, in id order.
 * The default is small on purpose — a discussion is read from the top and
 * "Tải thêm" pages the rest (D58) — and the ceiling matches `PaginationQuery`
 * (1..100), the schema the route advertises: a caller may ask for fewer or
 * more up to it, never for an unbounded page. Replies to the threads on a
 * page are still fetched whole (see `list`); the ceiling on top-level rows is
 * what keeps that fan-out bounded (D112).
 */
const PAGE_DEFAULT = 25;
const PAGE_MAX = 100;

/** The caller's `limit`, defaulted and clamped to the advertised range. */
function pageLimit(limit: number | undefined): number {
  if (limit === undefined) return PAGE_DEFAULT;
  return Math.min(Math.max(Math.trunc(limit), 1), PAGE_MAX);
}

interface CommentRow {
  id: number;
  parentId: number | null;
  authorId: number;
  username: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

/**
 * The problem discussion (D109) — a flat thread with exactly one level of
 * replies.
 *
 * A reader of `@duckoj/db/guarded` for problems, alongside
 * `ProblemAccessService` and `SubmissionAccessService`: it owns the
 * `problem_comments` table and reuses `problem.visibility.ts`'s predicates
 * (`canViewProblem`, `contestHiddenProblemIds`) rather than reimplementing
 * who may see a problem or who is sitting a running contest — the split
 * predicate is a bug this codebase has paid for before.
 *
 * **The spoiler rule (D109).** While a viewer is competing in a running
 * contest that uses this problem (`contestHiddenProblemIds`, D35's own
 * predicate), the discussion is withheld from them entirely — a comment can
 * leak the solution. The read returns an empty page flagged
 * `hiddenDuringContest`, and every write is refused 403: a participant who
 * cannot read the thread must not be able to post into it and leak the
 * solution to everyone outside the room. Organisers and admins are never
 * hidden anything.
 */
@Injectable()
export class ProblemCommentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  /**
   * The problem named by `code`, or the same 404 an absent one gets — a
   * distinct error would be an existence oracle for a problem the actor may
   * not see, exactly as `ProblemAccessService.loadVisible` avoids.
   */
  private async loadVisibleProblem(
    actor: Actor | null,
    code: string,
  ): Promise<{ id: number; code: string; name: string }> {
    const row = (
      await this.db
        .select({ id: problems.id, code: problems.code, name: problems.name, visibility: problems.visibility })
        .from(problems)
        .where(sql`lower(${problems.code}) = lower(${code})`)
        .limit(1)
    )[0];
    if (!row) throw new AppError(404, 'problem_not_found', 'No such problem.');
    const ctx = await loadProblemContext(this.db, actor, row.id);
    if (!canViewProblem(actor, { id: row.id, visibility: row.visibility as ProblemVisibility }, ctx)) {
      throw new AppError(404, 'problem_not_found', 'No such problem.');
    }
    return { id: row.id, code: row.code, name: row.name };
  }

  /** True when D109 hides this problem's discussion from `actor`. */
  private async isHidden(actor: Actor | null, problemId: number): Promise<boolean> {
    const hidden = await contestHiddenProblemIds(this.db, actor, [problemId]);
    return hidden.has(problemId);
  }

  async list(
    actor: Actor | null,
    code: string,
    page: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<ProblemCommentPageDto> {
    const limit = pageLimit(page.limit);
    const problem = await this.loadVisibleProblem(actor, code);
    // Withheld whole, and signalled — the one place D109 deliberately breaks
    // D35's "blank, never distinguishable" rule, because the viewer already
    // knows they joined a contest that uses this problem (that is what let
    // them open it), so the flag discloses nothing new and the UI needs it to
    // show the note the brief requires.
    if (await this.isHidden(actor, problem.id)) {
      return { items: [], nextCursor: null, hiddenDuringContest: true };
    }

    const after = parseCursor(page.cursor);
    // Top-level comments only, keyset by id (D58). Deleted ones are fetched
    // too — a deleted parent still anchors its replies as a tombstone — and
    // dropped below only if nothing visible hangs off them.
    const topRows = await this.selectComments(
      and(eq(problemComments.problemId, problem.id), isNull(problemComments.parentId), gt(problemComments.id, after)),
      limit + 1,
    );
    const pageRows = topRows.slice(0, limit);
    const hasMore = topRows.length > limit;

    // Every visible reply for the whole page in ONE query, never one per
    // parent. Deleted replies are omitted outright: a reply anchors nothing
    // below it, so there is no thread shape a tombstone would preserve.
    const parentIds = pageRows.map((row) => row.id);
    const replyRows =
      parentIds.length === 0
        ? []
        : await this.selectComments(
            and(inArray(problemComments.parentId, parentIds), isNull(problemComments.deletedAt)),
            undefined,
          );
    const repliesByParent = new Map<number, ProblemCommentDto[]>();
    for (const reply of replyRows) {
      const list = repliesByParent.get(reply.parentId!) ?? [];
      list.push(toComment(reply));
      repliesByParent.set(reply.parentId!, list);
    }

    const items: ProblemCommentThreadDto[] = [];
    for (const row of pageRows) {
      const replies = repliesByParent.get(row.id) ?? [];
      // A deleted top-level comment with no visible reply is omitted, not
      // shown as a tombstone anchoring nothing.
      if (row.deletedAt !== null && replies.length === 0) continue;
      items.push({ ...toComment(row), replies });
    }
    // The cursor is the walk position — the last top-level row EXAMINED, not
    // the last one displayed — so an omitted tombstone never makes the next
    // page skip a comment or repeat one.
    const nextCursor = hasMore && pageRows.length > 0 ? String(pageRows.at(-1)!.id) : null;
    return { items, nextCursor, hiddenDuringContest: false };
  }

  async create(actor: Actor, code: string, body: CreateCommentRequestDto): Promise<ProblemCommentDto> {
    const problem = await this.loadVisibleProblem(actor, code);
    if (await this.isHidden(actor, problem.id)) {
      throw new AppError(403, 'comment_hidden_contest', 'This discussion is hidden while you are competing.');
    }

    // Parent validation BEFORE the rate limiter, so a malformed reply does not
    // burn the author's window; and BEFORE the insert, so it cannot half-apply.
    let parentAuthorId: number | null = null;
    if (body.parentId !== undefined) {
      const parent = (
        await this.db
          .select({
            id: problemComments.id,
            parentId: problemComments.parentId,
            problemId: problemComments.problemId,
            authorId: problemComments.authorId,
            deletedAt: problemComments.deletedAt,
          })
          .from(problemComments)
          .where(eq(problemComments.id, body.parentId))
          .limit(1)
      )[0];
      // Same problem, top-level, not deleted — anything else is not a state
      // the one-level thread has a meaning for.
      if (!parent || parent.problemId !== problem.id || parent.parentId !== null || parent.deletedAt !== null) {
        throw new AppError(422, 'comment_bad_parent', 'A reply must name a top-level comment on this problem.');
      }
      parentAuthorId = parent.authorId;
    }

    // `retryAfterSeconds` + `record`, never `allow` — D80's split, for D80's
    // reason. `allow` records the attempt it refuses, so a refused comment
    // kept an attempt row in the window; the count then stayed AT the limit
    // even as the oldest event expired, and a caller who honoured the
    // Retry-After they were handed was refused again — each refusal pushing
    // the cooldown further out. Here the window is spent by a comment that was
    // actually created (`record`, below, after the insert) and a refusal costs
    // the caller nothing. `retryAfterSeconds` writes the single D47 marker on
    // a non-null answer (one window, one key — no double-mark to avoid).
    const meterKey = `user:${String(actor.userId)}`;
    const retry = await this.limiter.retryAfterSeconds(
      COMMENT_PURPOSE,
      meterKey,
      COMMENT_LIMIT,
      COMMENT_WINDOW_MS,
    );
    if (retry !== null) {
      throw new AppError(
        429,
        'comment_rate_limited',
        `At most ${String(COMMENT_LIMIT)} comments per hour.`,
        undefined,
        { 'Retry-After': String(retry) },
      );
    }

    const created = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(problemComments)
        .values({
          problemId: problem.id,
          authorId: actor.userId,
          parentId: body.parentId ?? null,
          body: body.body,
        })
        .returning({ id: problemComments.id });
      // Notify the top-level comment's author of a reply (D14) — never on a
      // self-reply, and in the same transaction as the insert so the two land
      // together or not at all (`NotificationsService.notify`'s own contract).
      if (parentAuthorId !== null && parentAuthorId !== actor.userId) {
        await this.notifications.notify(tx as unknown as Db, parentAuthorId, 'problem_comment_reply', {
          problemCode: problem.code,
          problemName: problem.name,
          commentId: inserted!.id,
          parentId: body.parentId ?? null,
        });
      }
      return inserted!.id;
    });

    // The window is spent only now, by a comment that was actually created.
    await this.limiter.record(COMMENT_PURPOSE, meterKey, COMMENT_WINDOW_MS);
    return this.loadOne(created);
  }

  async edit(actor: Actor, code: string, id: number, body: UpdateCommentRequestDto): Promise<ProblemCommentDto> {
    const problem = await this.loadVisibleProblem(actor, code);
    if (await this.isHidden(actor, problem.id)) {
      throw new AppError(403, 'comment_hidden_contest', 'This discussion is hidden while you are competing.');
    }
    const comment = await this.loadForWrite(problem.id, id);
    if (comment.authorId !== actor.userId) {
      throw new AppError(403, 'comment_forbidden', 'You can only edit your own comments.');
    }
    await this.db
      .update(problemComments)
      .set({ body: body.body, editedAt: new Date() })
      .where(eq(problemComments.id, id));
    return this.loadOne(id);
  }

  async remove(actor: Actor, code: string, id: number): Promise<void> {
    const problem = await this.loadVisibleProblem(actor, code);
    if (await this.isHidden(actor, problem.id)) {
      throw new AppError(403, 'comment_hidden_contest', 'This discussion is hidden while you are competing.');
    }
    const comment = await this.loadForWrite(problem.id, id);
    // Author or admin. A curator of the problem is deliberately NOT admitted:
    // a comment is its author's words, and moderation beyond the author is an
    // admin act, not an authoring one.
    if (comment.authorId !== actor.userId && !isAdmin(actor)) {
      throw new AppError(403, 'comment_forbidden', 'You can only delete your own comments.');
    }
    // Soft delete: the row stays so a reply it anchors keeps its tombstone.
    await this.db.update(problemComments).set({ deletedAt: new Date() }).where(eq(problemComments.id, id));
  }

  /**
   * A live (non-deleted) comment on this problem, for a write. Same 404 for
   * absent, deleted, and belonging-to-another-problem: a distinct error would
   * disclose which of those a comment id names.
   */
  private async loadForWrite(problemId: number, id: number): Promise<{ authorId: number }> {
    const row = (
      await this.db
        .select({ authorId: problemComments.authorId, problemId: problemComments.problemId, deletedAt: problemComments.deletedAt })
        .from(problemComments)
        .where(eq(problemComments.id, id))
        .limit(1)
    )[0];
    if (!row || row.problemId !== problemId || row.deletedAt !== null) {
      throw new AppError(404, 'comment_not_found', 'No such comment.');
    }
    return { authorId: row.authorId };
  }

  private async loadOne(id: number): Promise<ProblemCommentDto> {
    const [row] = await this.selectComments(eq(problemComments.id, id), 1);
    return toComment(row!);
  }

  /** One SELECT shape for every read here, joined to `users` for the byline. */
  private async selectComments(where: SQL | undefined, limit: number | undefined): Promise<CommentRow[]> {
    const query = this.db
      .select({
        id: problemComments.id,
        parentId: problemComments.parentId,
        authorId: problemComments.authorId,
        username: schema.users.username,
        body: problemComments.body,
        createdAt: problemComments.createdAt,
        editedAt: problemComments.editedAt,
        deletedAt: problemComments.deletedAt,
      })
      .from(problemComments)
      .innerJoin(schema.users, eq(schema.users.id, problemComments.authorId))
      .where(where)
      .orderBy(asc(problemComments.id));
    return limit === undefined ? query : query.limit(limit);
  }
}

/**
 * A row to its wire shape. A soft-deleted comment becomes a tombstone —
 * `author` and `body` blanked, `deletedAt` set — so its replies keep their
 * anchor without disclosing what it once said or who wrote it.
 */
function toComment(row: CommentRow): ProblemCommentDto {
  const deleted = row.deletedAt !== null;
  return {
    id: row.id,
    parentId: row.parentId,
    author: deleted ? null : { username: row.username },
    body: deleted ? null : row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt === null ? null : row.editedAt.toISOString(),
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
  };
}

/**
 * Cursors are opaque to clients but are ids here — the same contract every
 * sibling list makes. A non-numeric cursor is a client mistake, not a server
 * fault: 422 rather than letting `NaN` reach the driver as a 500.
 */
function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const after = Number(cursor);
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new AppError(422, 'invalid_cursor', 'That page cursor is not valid.');
  }
  return after;
}
