import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
import { organizations, problemMembers, problemOrgs, problemRevisions, problems } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import type { PaginationQueryDto } from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import {
  canCreateProblem,
  canEditProblem,
  canViewProblem,
  loadProblemContext,
  visibleProblemsWhere,
  type ProblemRole,
  type ProblemVisibility,
} from './problem.visibility.js';
import { isAdmin, type Actor } from './actor.js';
import { loadOrgMembership } from './org.visibility.js';

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

export interface ProblemMemberInput {
  username: string;
  role: ProblemRole;
}

export interface CreateProblemInput {
  code: string;
  name: string;
  statement: string;
  visibility?: ProblemVisibility;
  orgSlugs?: string[];
}

/**
 * `code` is intentionally a member: it exists so a caller that includes it
 * still type-checks, and `update` rejects the request for it — a problem's
 * code cannot be changed once created. `members` and `orgSlugs`, when
 * present, are whole-set replacements of `problemMembers` / `problemOrgs`,
 * not merges.
 */
export interface UpdateProblemPatch {
  code?: string;
  name?: string;
  statement?: string;
  visibility?: ProblemVisibility;
  members?: ProblemMemberInput[];
  orgSlugs?: string[];
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

    const visibility = body.visibility ?? 'public';
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

    return this.loadDetailById(problemId);
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
    const row = (
      await this.db
        .select({ id: problems.id, visibility: problems.visibility })
        .from(problems)
        .where(sql`lower(${problems.code}) = lower(${code})`)
        .limit(1)
    )[0];
    if (!row) throw new AppError(404, 'problem_not_found', 'No such problem.');

    const ctx = await loadProblemContext(this.db, actor, row.id);
    if (!canViewProblem(actor, { id: row.id, visibility: row.visibility }, ctx)) {
      throw new AppError(404, 'problem_not_found', 'No such problem.');
    }
    if (!actor || !canEditProblem(actor, ctx)) {
      throw new AppError(403, 'problem_forbidden', 'You may not edit this problem.');
    }

    // --- validate the patch ---
    if ('code' in patch) {
      throw new AppError(400, 'problem_code_immutable', "A problem's code cannot be changed.");
    }

    if (patch.members && !patch.members.some((m) => m.role === 'author')) {
      throw new AppError(400, 'problem_last_author', 'A problem must always have at least one author.');
    }

    // Resolve usernames/slugs to ids before the transaction, so a bad
    // request never half-applies.
    const memberRows = patch.members ? await this.resolveMemberIds(patch.members) : undefined;
    const orgIds = patch.orgSlugs ? await this.resolveOrgIds(actor, patch.orgSlugs) : undefined;

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
    });

    return this.loadDetailById(row.id);
  }

  /**
   * Fetches a problem's detail by id with no visibility check — the caller
   * has already established the actor may act on it (as its creator, or
   * having just passed `canEditProblem`). Deliberately distinct from
   * `getVisible`: re-checking visibility here would 404 an author who just
   * removed themselves from a private problem's membership, even though
   * their own write just succeeded.
   */
  private async loadDetailById(id: number): Promise<ProblemDetailDto> {
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
          and(eq(problems.currentRevisionId, problemRevisions.id), eq(problemRevisions.state, 'published')),
        )
        .where(eq(problems.id, id))
        .limit(1)
    )[0]!;

    return {
      ...toSummary(row),
      statement: row.statement,
      testCount: row.revisionId === null ? null : row.testCount,
      totalPoints: row.revisionId === null ? null : row.totalPoints,
      checkerKind: row.revisionId === null ? null : row.checkerKind,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Resolves org slugs to ids, case-insensitively (matching
   * `organizations_slug_lower_idx`), then requires the actor to belong to
   * every one of them — in any role — before a problem may be shared with
   * it. An organization that does not exist and one the actor is not a
   * member of are indistinguishable to the caller: both throw
   * `ORG_UNKNOWN_MESSAGE`, so a slug can't be used to probe for a private
   * organization's existence or membership. Admins bypass the membership
   * requirement (the organization must still exist), consistent with every
   * other `isAdmin` bypass in this file.
   *
   * Deduplicates on the *resolved* id, not the input slug string: because
   * resolution is case-insensitive, `['org-a', 'ORG-A']` are two spellings
   * of one id, and inserting `problemOrgs` once per input string would hit
   * its `(problemId, orgId)` primary key twice and surface as a 500.
   */
  private async resolveOrgIds(actor: Actor, slugs: string[]): Promise<number[]> {
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
      const membership = await loadOrgMembership(this.db, actor, uniqueIds);
      for (const id of uniqueIds) {
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
  ): Promise<{ userId: number; role: ProblemRole }[]> {
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
    const resolved: { userId: number; role: ProblemRole }[] = [];
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
