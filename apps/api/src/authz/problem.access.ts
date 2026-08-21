import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, isNotNull, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  organizations,
  problemMembers,
  problemOrgs,
  problemRevisions,
  problems,
  submissions,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { findPathCollision, parseManifest, readArchiveEntry, type PackageManifestDto } from '@duckoj/package-format';
import {
  CreateProblemRequest,
  type AttachRevisionRequestDto,
  type PaginationQueryDto,
  type ProblemDetailDto,
  type ProblemMeDto,
  type ProblemMemberDto,
  type ProblemPageDto,
  type ProblemSummaryDto,
  type RevisionSummaryDto,
  type RevisionVersionResponseDto,
  type UpdateProblemRequestDto,
} from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import { PACKAGE_STORE, type PackageStore } from '../packages/package.store.js';
import {
  canCreateProblem,
  canEditProblem,
  canViewProblem,
  canViewRevisions,
  loadProblemContext,
  visibleProblemsWhere,
  type ProblemViewContext,
  type ProblemVisibility,
} from './problem.visibility.js';
import { isAdmin, type Actor } from './actor.js';
import { loadOrgMembership, visibleOrgsWhere } from './org.visibility.js';

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

export type AttachRevisionInput = AttachRevisionRequestDto;

export type AttachRevisionResult = RevisionVersionResponseDto;

export type PublishRevisionResult = RevisionVersionResponseDto;

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
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PACKAGE_STORE) private readonly store: PackageStore,
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
   * Filtered to submissions with both `points` and `maxPoints` recorded —
   * excludes a submission still in flight (both null) and the narrow case
   * of a compile error (`points` set to 0 but `maxPoints` never written,
   * `event-writer.ts`'s `compileError` branch): neither carries a real
   * `maxPoints` to report, and `me`'s contract has no null-maxPoints
   * shape. Whichever submission this picks always has `verdict` set too
   * (`event-writer.ts` never writes `points`/`maxPoints` without it).
   *
   * `desc(...) nulls last`, spelled out with raw `sql`, not the plain
   * `desc()` helper: unqualified, Postgres's `ORDER BY points DESC` sorts
   * nulls FIRST, but `submissions_user_problem_points_idx` was generated
   * (drizzle-kit's own default for every index column, regardless of
   * direction) as `points DESC NULLS LAST`. Matching the index's null
   * placement here is what lets the planner recognise the index already
   * delivers this order and skip the extra Sort node it otherwise adds —
   * confirmed by `EXPLAIN` against a few thousand rows. Harmless for
   * results either way (the `isNotNull` filter above means no row here
   * ever has a null `points` to place), so this is a planner-only fix.
   */
  private bestSubmissionLateral(userId: number) {
    return this.db
      .select({
        verdict: submissions.verdict,
        points: submissions.points,
        maxPoints: submissions.maxPoints,
      })
      .from(submissions)
      .where(
        and(
          eq(submissions.problemId, problems.id),
          eq(submissions.userId, userId),
          isNotNull(submissions.points),
          isNotNull(submissions.maxPoints),
        ),
      )
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

    const items = rows.slice(0, page.limit).map(toSummary);
    const nextCursor = rows.length > page.limit ? String(items.at(-1)!.id) : null;
    return { items, nextCursor };
  }

  async getVisible(actor: Actor | null, code: string): Promise<ProblemDetailDto> {
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
          createdAt: Date;
          revisionId: number | null;
          timeMs: number | null;
          memoryKb: number | null;
          testCount: number | null;
          totalPoints: number | null;
          checkerKind: string | null;
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
            createdAt: problems.createdAt,
            revisionId: problemRevisions.id,
            timeMs: problemRevisions.timeMs,
            memoryKb: problemRevisions.memoryKb,
            testCount: problemRevisions.testCount,
            totalPoints: problemRevisions.totalPoints,
            checkerKind: problemRevisions.checkerKind,
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
            createdAt: problems.createdAt,
            revisionId: problemRevisions.id,
            timeMs: problemRevisions.timeMs,
            memoryKb: problemRevisions.memoryKb,
            testCount: problemRevisions.testCount,
            totalPoints: problemRevisions.totalPoints,
            checkerKind: problemRevisions.checkerKind,
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

    return {
      ...toSummary(row),
      statement: row.statement,
      // Not revision-derived, so unlike the three fields below it is never
      // nulled out on a problem whose only revision is a draft: the flag
      // lives on the problem itself and is meaningful before anything is
      // published.
      sourceAccess: row.sourceAccess,
      testCount: row.revisionId === null ? null : row.testCount,
      totalPoints: row.revisionId === null ? null : row.totalPoints,
      checkerKind: row.revisionId === null ? null : row.checkerKind,
      createdAt: row.createdAt.toISOString(),
      members,
      orgSlugs,
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
   * Loads a problem's `{ id, visibility }` by code, 404ing if no problem has
   * that code (case-insensitively) — the first half of the 404-then-403
   * ordering every write path needs. Split out of `loadForEdit` so
   * `listRevisions`, which needs the same lookup but a different permission
   * check (never a 403 — spec §3, item 2), does not duplicate it.
   */
  private async findProblemRow(code: string): Promise<{ id: number; visibility: ProblemVisibility }> {
    const row = (
      await this.db
        .select({ id: problems.id, visibility: problems.visibility })
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
  ): Promise<{ problem: { id: number; visibility: ProblemVisibility }; ctx: ProblemViewContext }> {
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
      createdAt: Date;
      revisionId: number | null;
      timeMs: number | null;
      memoryKb: number | null;
      testCount: number | null;
      totalPoints: number | null;
      checkerKind: string | null;
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
            createdAt: problems.createdAt,
            revisionId: problemRevisions.id,
            timeMs: problemRevisions.timeMs,
            memoryKb: problemRevisions.memoryKb,
            testCount: problemRevisions.testCount,
            totalPoints: problemRevisions.totalPoints,
            checkerKind: problemRevisions.checkerKind,
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
            createdAt: problems.createdAt,
            revisionId: problemRevisions.id,
            timeMs: problemRevisions.timeMs,
            memoryKb: problemRevisions.memoryKb,
            testCount: problemRevisions.testCount,
            totalPoints: problemRevisions.totalPoints,
            checkerKind: problemRevisions.checkerKind,
          })
          .from(problems)
          .leftJoin(problemRevisions, revisionJoin)
          .where(eq(problems.id, id))
          .limit(1)
      )[0]!;
    }

    const { members, orgSlugs } = await this.loadMembersAndOrgs(id, actor, true);

    return {
      ...toSummary(row),
      statement: row.statement,
      // Not revision-derived, so unlike the three fields below it is never
      // nulled out on a problem whose only revision is a draft: the flag
      // lives on the problem itself and is meaningful before anything is
      // published.
      sourceAccess: row.sourceAccess,
      testCount: row.revisionId === null ? null : row.testCount,
      totalPoints: row.revisionId === null ? null : row.totalPoints,
      checkerKind: row.revisionId === null ? null : row.checkerKind,
      createdAt: row.createdAt.toISOString(),
      members,
      orgSlugs,
    };
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
}): ProblemSummaryDto {
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
  };
}

/**
 * `null` when any of the three is missing — the lateral was never joined
 * (anonymous caller) or joined but matched no row (the viewer has no
 * fully-graded submission to this problem, spec §2). `bestSubmissionLateral`
 * only ever returns a row with all three set together (`event-writer.ts`
 * never writes `points`/`maxPoints` without `verdict`, and the lateral's own
 * `WHERE` excludes the reverse — see that method's doc comment), so this
 * "all or nothing" check never actually splits a real row down the middle;
 * it is just how a `LEFT JOIN` with no match reads to TypeScript.
 */
function toBestMe(row: {
  meVerdict?: string | null;
  mePoints?: number | null;
  meMaxPoints?: number | null;
}): ProblemMeDto {
  if (row.meVerdict == null || row.mePoints == null || row.meMaxPoints == null) return null;
  return {
    verdict: row.meVerdict as NonNullable<ProblemMeDto>['verdict'],
    points: row.mePoints,
    maxPoints: row.meMaxPoints,
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
