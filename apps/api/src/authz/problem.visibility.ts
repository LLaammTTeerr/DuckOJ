import { and, eq, type SQL } from 'drizzle-orm';
import { orgMembers, problemMembers, problemOrgs, problems } from '@duckoj/db/guarded';
import type { Db } from '@duckoj/db';
import { isAdmin, type Actor } from './actor.js';
import { canViewVisible, visibleRowsWhere, type Visibility } from './visibility.js';

export type ProblemVisibility = Visibility;
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
 * Whether `actor` may see `problem`. The decision itself lives in
 * `canViewVisible` (`visibility.ts`) — this only translates a problem's
 * membership model into it: any role at all counts, because a tester exists
 * precisely so a private problem can be proofread before it is public.
 *
 * Phase 4c moved the decision out of this file so contests could share it
 * rather than reimplement it. Behaviour is unchanged, which
 * `problem-visibility.spec.ts` is the proof of.
 */
export function canViewProblem(
  actor: Actor | null,
  problem: { id: number; visibility: ProblemVisibility },
  ctx: ProblemViewContext,
): boolean {
  return canViewVisible(actor, problem.visibility, {
    isMember: ctx.memberRoles.length > 0,
    sharedOrgIds: ctx.sharedOrgIds,
    actorOrgIds: ctx.actorOrgIds,
  });
}

export function canEditProblem(actor: Actor | null, ctx: ProblemViewContext): boolean {
  if (isAdmin(actor)) return true;
  if (!actor) return false;
  return ctx.memberRoles.includes('author') || ctx.memberRoles.includes('curator');
}

/**
 * Whether `actor` may see a problem's revision history, including drafts and
 * archived revisions. Deliberately narrower than `canViewProblem`: a
 * problem's public/org visibility governs whether its *published* statement
 * and limits are visible, but says nothing about draft or archived
 * revisions, which can contain unreleased tests or answer keys. Only a
 * member (any role — a tester exists precisely to review drafts) or an admin
 * gets in; every other actor, even on a public problem, is treated as if the
 * revision history does not exist (spec §3, item 2 — 404, never a distinct
 * error).
 */
export function canViewRevisions(actor: Actor | null, ctx: ProblemViewContext): boolean {
  if (isAdmin(actor)) return true;
  return !!actor && ctx.memberRoles.length > 0;
}

export function canCreateProblem(actor: Actor | null): boolean {
  return actor?.globalRole === 'setter' || isAdmin(actor);
}

/**
 * The list-query form of `canViewProblem`. The condition's *shape* is
 * `visibleRowsWhere`'s, shared with contests; this supplies the two problem
 * subqueries it cannot know about. Kept in the same file as the row-wise form
 * on purpose: the two must agree, and agreement is easier to audit when they
 * are eight lines apart than when they live in two services.
 */
export function visibleProblemsWhere(db: Db, actor: Actor | null): SQL {
  const userId = actor?.userId ?? 0;
  return visibleRowsWhere(
    actor,
    { visibility: problems.visibility, id: problems.id },
    {
      memberOf: db
        .select({ problemId: problemMembers.problemId })
        .from(problemMembers)
        .where(eq(problemMembers.userId, userId)),
      sharedWithMyOrgs: db
        .select({ problemId: problemOrgs.problemId })
        .from(problemOrgs)
        .innerJoin(orgMembers, eq(orgMembers.orgId, problemOrgs.orgId))
        .where(eq(orgMembers.userId, userId)),
    },
  );
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
