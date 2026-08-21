import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { problemMembers, problems, submissions } from '@duckoj/db/guarded';
import type { Db } from '@duckoj/db';
import { isAdmin, type Actor } from './actor.js';
import { canViewProblem, loadProblemContext, visibleProblemsWhere } from './problem.visibility.js';
import type { ProblemRole, ProblemVisibility } from './problem.visibility.js';

/** Mirrors the `problem_source_access` enum — see `guarded.ts` for why there is no `public`. */
export type SourceAccess = 'private' | 'solved';

/**
 * The problem roles that carry a submission grant. `tester` is absent on
 * purpose (design §2.2): a tester exists to proofread a *problem* before it
 * is public, which is not a reason to read other people's *solutions* to it.
 * Widening this tuple later is one line; un-widening it after testers have
 * already read submissions is not.
 *
 * One constant, used by both forms below, so "author or curator" cannot come
 * to mean one thing in TypeScript and another in SQL.
 */
const SUBMISSION_GRANTING_ROLES = ['author', 'curator'] as const;

/**
 * The three facts beyond ownership that `canViewSubmission` needs — the same
 * three `visibleSubmissionsWhere` expresses as subqueries. Kept as one type
 * so adding a fourth fact to the row form is a compile error at the SQL form
 * rather than a silent divergence.
 */
export interface SubmissionViewContext {
  /** The *problem's* flag, not the viewer's. */
  sourceAccess: SourceAccess;
  /** The viewer's roles ON THIS PROBLEM. Empty for a non-member. */
  memberRoles: ProblemRole[];
  /**
   * Whether the viewer holds at least one `AC` on this problem, ever — not
   * on its current revision (design §2.4). Revision-scoping this would
   * silently revoke access on every republish.
   */
  viewerHasAc: boolean;
  /**
   * `canViewProblem` for this viewer, composed rather than re-derived.
   *
   * `source_access` and `visibility` are independent columns, so a problem
   * can be open to solvers *and* private. Without this fact the solver clause
   * read the flag alone, and a problem taken private went on serving its past
   * solvers the source — the two settings composed to the more permissive
   * one, which is the wrong direction for a pair of access controls.
   */
  viewerCanSeeProblem: boolean;
}

/**
 * The one predicate for "may `actor` see a submission owned by `ownerId`",
 * per design §2's table: the submitter always, a global admin always, an
 * `author` or `curator` of the problem for every submission to it, and —
 * only where the problem opted in with `source_access = 'solved'` — anyone
 * holding an `AC` on it.
 *
 * This governs the **submission**, not just its `source` field (design §2.1).
 * A curator who could read the source but got a 404 on the submission
 * carrying it would be incoherent, so `source` simply rides along on every
 * submission the viewer is already allowed to see.
 *
 * `SubmissionAccessService.getVisible` (single-row) and `.listVisible`
 * (list, via `visibleSubmissionsWhere` below) both resolve to this same
 * function rather than each keeping its own copy of the rule — spec §4.1
 * requires the set `GET /submissions` returns to equal exactly the set of
 * ids `GET /submissions/{id}` answers 200 for, and two independently-written
 * copies of the same rule are exactly how that agreement silently breaks
 * (the Phase 2b org-visibility shape). Now that the rule needs three facts
 * beyond ownership, that sharing matters more than it did, not less: a
 * divergence here is a visibility leak, not a cosmetic inconsistency.
 */
export function canViewSubmission(actor: Actor, ownerId: number, ctx: SubmissionViewContext): boolean {
  // Ownership first, before anything context-dependent: your own submission
  // on a problem you can no longer see — a problem turned private, a
  // membership revoked — is still yours to read.
  if (ownerId === actor.userId) return true;
  if (isAdmin(actor)) return true;
  if (ctx.memberRoles.some((role) => (SUBMISSION_GRANTING_ROLES as readonly string[]).includes(role))) {
    return true;
  }
  // The only clause the per-problem flag gates. A viewer's AC buys nothing
  // on a problem that never opted in — which is what makes the migration's
  // `DEFAULT 'private'` a real closed default rather than a formality — and
  // nothing on a problem they can no longer see at all.
  //
  // Only this clause is gated on problem visibility. The three above are
  // deliberately not: your own submission survives the problem going private
  // (that is the first comment in this function), an admin sees everything,
  // and an author or curator is a *member*, whom `canViewVisible` admits to a
  // private problem anyway — gating them would be a no-op that quietly made
  // this rule depend on that coincidence.
  return ctx.sourceAccess === 'solved' && ctx.viewerHasAc && ctx.viewerCanSeeProblem;
}

/**
 * The list-query form of `canViewSubmission`, for a `WHERE` clause rather
 * than a row already in hand. Kept in the same file as the row-wise form
 * because the two must agree, clause for clause:
 *
 * | row form                                | SQL form                                      |
 * |-----------------------------------------|-----------------------------------------------|
 * | `ownerId === actor.userId`              | `submissions.user_id = :me`                   |
 * | `isAdmin(actor)`                        | `true` (the whole predicate collapses)        |
 * | `ctx.memberRoles` ∩ author/curator      | `problem_id IN (authoredOrCurated)`           |
 * | `ctx.sourceAccess === 'solved'`         | `problem_id IN (openToSolvers)`               |
 * | `ctx.viewerHasAc`                       | `problem_id IN (solvedByMe)`                  |
 * | `ctx.viewerCanSeeProblem`               | `problem_id IN (visibleProblems)`             |
 *
 * All three subqueries are **uncorrelated** — none references the outer
 * `submissions` row — so this is one query, not one per row: Postgres
 * evaluates each once (typically as a hash semi-join) regardless of how many
 * submissions the page scans. The list must not degrade with corpus size,
 * and an `EXISTS (... WHERE s.problem_id = outer.problem_id)` phrasing of
 * the same rule would have been the N+1 shape in query-planner clothing.
 *
 * Deliberately self-contained: every fact is fetched by its own subquery
 * rather than read off a column the *caller* happened to join. Phrasing the
 * flag as `eq(problems.sourceAccess, 'solved')` would have been shorter, but
 * it would silently require every caller to join `problems` — and a caller
 * that joined it differently (a `leftJoin`, say) would change what this
 * predicate means without touching this file. That is precisely the
 * divergence the shared predicate exists to prevent.
 */
export function visibleSubmissionsWhere(db: Db, actor: Actor): SQL {
  if (isAdmin(actor)) return sql`true`;

  // Fact 2: the viewer's roles on the problem. `tester` is excluded by the
  // `inArray` itself, not by a filter downstream of it.
  const authoredOrCurated = db
    .select({ problemId: problemMembers.problemId })
    .from(problemMembers)
    .where(
      and(
        eq(problemMembers.userId, actor.userId),
        inArray(problemMembers.role, [...SUBMISSION_GRANTING_ROLES]),
      ),
    );

  // Fact 1: the problem's flag.
  const openToSolvers = db.select({ id: problems.id }).from(problems).where(eq(problems.sourceAccess, 'solved'));

  // Fact 4: the problems this viewer may see at all, straight from the
  // problem predicate rather than restated here. `source_access` and
  // `visibility` are independent columns and must compose to the *narrower*
  // of the two, so a problem opened to solvers and later taken private stops
  // serving its source.
  const visibleProblems = db.select({ id: problems.id }).from(problems).where(visibleProblemsWhere(db, actor));

  // Fact 3: the viewer's ACs. Aliased because this is a self-reference —
  // `submissions` is also the outer query's table, and an unaliased inner
  // reference would bind to the inner scope by Postgres' scoping rules but
  // read, to anyone auditing this, as though it might not.
  const myAc = alias(submissions, 'my_ac');
  const solvedByMe = db
    .select({ problemId: myAc.problemId })
    .from(myAc)
    .where(and(eq(myAc.userId, actor.userId), eq(myAc.verdict, 'AC')));

  return or(
    eq(submissions.userId, actor.userId),
    inArray(submissions.problemId, authoredOrCurated),
    and(
      inArray(submissions.problemId, openToSolvers),
      inArray(submissions.problemId, solvedByMe),
      inArray(submissions.problemId, visibleProblems),
    ),
  )!;
}

/**
 * Loads the per-viewer facts `canViewSubmission` needs for a single
 * submission. The problem's own columns — `source_access`, `visibility` — are passed in
 * rather than fetched: `getVisible` already joins `problems` to resolve the
 * problem code, so re-reading the flag here would be a third round trip for
 * a column that query already has in hand.
 *
 * Two indexed lookups, both bounded to one problem and one user; nothing
 * here scales with the number of submissions to the problem (the AC probe
 * is `LIMIT 1` — "does one exist", never "how many").
 */
export async function loadSubmissionContext(
  db: Db,
  actor: Actor,
  problem: { id: number; visibility: ProblemVisibility; sourceAccess: SourceAccess },
): Promise<SubmissionViewContext> {
  const [problemCtx, acs] = await Promise.all([
    // The problem predicate's own loader, not a second copy of it. Its doc
    // comment anticipated this caller by name; taking it also removes the
    // duplicate `problem_members` query this function used to run.
    loadProblemContext(db, actor, problem.id),
    db
      .select({ id: submissions.id })
      .from(submissions)
      .where(
        and(
          eq(submissions.problemId, problem.id),
          eq(submissions.userId, actor.userId),
          eq(submissions.verdict, 'AC'),
        ),
      )
      .limit(1),
  ]);
  return {
    sourceAccess: problem.sourceAccess,
    memberRoles: problemCtx.memberRoles,
    viewerHasAc: acs.length > 0,
    viewerCanSeeProblem: canViewProblem(actor, problem, problemCtx),
  };
}
