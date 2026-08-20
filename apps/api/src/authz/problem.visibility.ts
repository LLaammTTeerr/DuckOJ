import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { orgMembers, problemMembers, problemOrgs, problems } from '@duckoj/db/guarded';
import type { Db } from '@duckoj/db';
import { isAdmin, type Actor } from './actor.js';

export type ProblemVisibility = 'private' | 'org' | 'public';
export type ProblemRole = 'author' | 'curator' | 'tester';

export interface ProblemViewContext {
  /** The actor's roles ON THIS PROBLEM. Empty for a non-member. */
  memberRoles: ProblemRole[];
  /** Organizations this problem is shared with. */
  sharedOrgIds: number[];
  /**
   * Organizations the actor belongs to **that this problem is also shared
   * with** — the intersection, not the actor's full membership list.
   * `loadProblemContext` computes it with a join against this problem's
   * `problem_orgs` rows, so an actor in ten unrelated organizations arrives
   * here with an empty array.
   *
   * That is exactly what `canViewProblem` needs, and it is a trap for any
   * future consumer that wants "which orgs is this user in" — that question
   * has a different answer and needs a different query.
   */
  actorOrgIds: number[];
}

/**
 * The single visibility predicate. Every read path in the codebase shares
 * this function (and its list-query twin, `visibleProblemsWhere`) so
 * visibility is never implemented twice.
 */
export function canViewProblem(
  actor: Actor | null,
  problem: { id: number; visibility: ProblemVisibility },
  ctx: ProblemViewContext,
): boolean {
  if (isAdmin(actor)) return true;
  // Membership outranks visibility: a tester exists precisely so a private
  // problem can be proofread before it is public.
  if (actor && ctx.memberRoles.length > 0) return true;
  if (problem.visibility === 'public') return true;
  if (problem.visibility === 'org' && actor) {
    return ctx.sharedOrgIds.some((id) => ctx.actorOrgIds.includes(id));
  }
  return false;
}

export function canEditProblem(actor: Actor | null, ctx: ProblemViewContext): boolean {
  if (isAdmin(actor)) return true;
  if (!actor) return false;
  return ctx.memberRoles.includes('author') || ctx.memberRoles.includes('curator');
}

export function canCreateProblem(actor: Actor | null): boolean {
  return actor?.globalRole === 'setter' || isAdmin(actor);
}

/**
 * The list-query form of `canViewProblem`. Kept in the same file as the
 * row-wise form on purpose: the two must agree, and agreement is easier to
 * audit when they are eight lines apart than when they live in two services.
 */
export function visibleProblemsWhere(db: Db, actor: Actor | null): SQL {
  if (isAdmin(actor)) return sql`true`;
  if (!actor) return eq(problems.visibility, 'public');

  const memberOf = db
    .select({ problemId: problemMembers.problemId })
    .from(problemMembers)
    .where(eq(problemMembers.userId, actor.userId));

  const sharedWithMyOrgs = db
    .select({ problemId: problemOrgs.problemId })
    .from(problemOrgs)
    .innerJoin(orgMembers, eq(orgMembers.orgId, problemOrgs.orgId))
    .where(eq(orgMembers.userId, actor.userId));

  return or(
    eq(problems.visibility, 'public'),
    inArray(problems.id, memberOf),
    and(eq(problems.visibility, 'org'), inArray(problems.id, sharedWithMyOrgs)),
  )!;
}

/**
 * Loads the context `canViewProblem`/`canEditProblem` need for a single
 * problem: the actor's roles on it, which orgs it is shared with, and which
 * orgs the actor belongs to. Lives here rather than on `ProblemAccessService`
 * so a later caller (the submission read path) can use it without depending
 * on that service — a second loader there is exactly the duplication the
 * shared predicate exists to prevent.
 */
export async function loadProblemContext(
  db: Db,
  actor: Actor | null,
  problemId: number,
): Promise<ProblemViewContext> {
  if (!actor) return { memberRoles: [], sharedOrgIds: [], actorOrgIds: [] };
  const [roles, orgs] = await Promise.all([
    db
      .select({ role: problemMembers.role })
      .from(problemMembers)
      .where(and(eq(problemMembers.problemId, problemId), eq(problemMembers.userId, actor.userId))),
    db
      .select({ shared: problemOrgs.orgId, mine: orgMembers.orgId })
      .from(problemOrgs)
      .leftJoin(
        orgMembers,
        and(eq(orgMembers.orgId, problemOrgs.orgId), eq(orgMembers.userId, actor.userId)),
      )
      .where(eq(problemOrgs.problemId, problemId)),
  ]);
  return {
    memberRoles: roles.map((r) => r.role),
    sharedOrgIds: orgs.map((o) => o.shared),
    actorOrgIds: orgs.filter((o) => o.mine !== null).map((o) => o.mine!),
  };
}
