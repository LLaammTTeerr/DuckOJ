import { and, eq, type SQL } from 'drizzle-orm';
import { contestOrgs, contests, orgMembers } from '@duckoj/db/guarded';
import type { Db } from '@duckoj/db';
import type { Actor } from './actor.js';
import { canViewVisible, visibleRowsWhere, type Visibility } from './visibility.js';

export type ContestVisibility = Visibility;

export interface ContestViewContext {
  /**
   * Whether the actor created this contest. A contest has no member roles —
   * there is no `contest_members` table, because nothing in this phase needs
   * one — so the creator is the whole of "membership outranks visibility"
   * here. A setter must be able to read back the private contest they just
   * created; that is the only case this covers.
   */
  isCreator: boolean;
  /** Organizations this contest is shared with. */
  sharedOrgIds: number[];
  /** The intersection of those with the actor's own — see `VisibilityContext`. */
  actorOrgIds: number[];
}

/**
 * Whether `actor` may see `contest`.
 *
 * No new predicate: the decision is `canViewVisible`, the same function
 * `canViewProblem` calls (design §5 — "do not write a new predicate"). This
 * translates a contest's membership model into it, which is the only part
 * that differs from a problem's.
 *
 * The consequence callers must honour: a contest the actor may not see is
 * **404, never 403** — exactly as a problem is. `ContestAccessService` is the
 * only place that turns this into a status code.
 */
export function canViewContest(
  actor: Actor | null,
  contest: { visibility: ContestVisibility },
  ctx: ContestViewContext,
): boolean {
  return canViewVisible(actor, contest.visibility, {
    isMember: ctx.isCreator,
    sharedOrgIds: ctx.sharedOrgIds,
    actorOrgIds: ctx.actorOrgIds,
  });
}

/** Who may create a contest. Mirrors `canCreateProblem` exactly. */
export function canCreateContest(actor: Actor | null): boolean {
  return actor?.globalRole === 'setter' || actor?.globalRole === 'admin';
}

/**
 * The list-query form of `canViewContest`, built by the same
 * `visibleRowsWhere` that builds `visibleProblemsWhere`. Only the two
 * subqueries differ: a contest's "membership" is `created_by`, and its sharing
 * table is `contest_orgs`.
 */
export function visibleContestsWhere(db: Db, actor: Actor | null): SQL {
  const userId = actor?.userId ?? 0;
  return visibleRowsWhere(
    actor,
    { visibility: contests.visibility, id: contests.id },
    {
      memberOf: db
        .select({ contestId: contests.id })
        .from(contests)
        .where(eq(contests.createdBy, userId)),
      sharedWithMyOrgs: db
        .select({ contestId: contestOrgs.contestId })
        .from(contestOrgs)
        .innerJoin(orgMembers, eq(orgMembers.orgId, contestOrgs.orgId))
        .where(eq(orgMembers.userId, userId)),
    },
  );
}

/**
 * Loads what `canViewContest` needs for one contest: whether the actor created
 * it, which organizations it is shared with, and which of those the actor
 * belongs to. Mirrors `loadProblemContext`, including the deliberate
 * `LEFT JOIN` that computes the *intersection* rather than the actor's whole
 * membership list.
 */
export async function loadContestContext(
  db: Db,
  actor: Actor | null,
  contest: { id: number; createdBy: number },
): Promise<ContestViewContext> {
  if (!actor) return { isCreator: false, sharedOrgIds: [], actorOrgIds: [] };
  const orgs = await db
    .select({ shared: contestOrgs.orgId, mine: orgMembers.orgId })
    .from(contestOrgs)
    .leftJoin(
      orgMembers,
      and(eq(orgMembers.orgId, contestOrgs.orgId), eq(orgMembers.userId, actor.userId)),
    )
    .where(eq(contestOrgs.contestId, contest.id));
  return {
    isCreator: contest.createdBy === actor.userId,
    sharedOrgIds: orgs.map((o) => o.shared),
    actorOrgIds: orgs.filter((o) => o.mine !== null).map((o) => o.mine!),
  };
}
