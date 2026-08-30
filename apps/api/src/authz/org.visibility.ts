import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { organizations, orgMembers } from '@duckoj/db/guarded';
import type { Db } from '@duckoj/db';
import { isAdmin, type Actor } from './actor.js';

/**
 * The list-query visibility condition for organizations: public, or the
 * actor is a member (any role), or the actor is an admin. Lives here as a
 * free function — not a method on `OrgAccessService` — for the same reason
 * `problem.visibility.ts` holds `canViewProblem` / `loadProblemContext` as
 * free functions rather than methods on `ProblemAccessService`: a second
 * consumer needs this question answered without importing the first
 * service, or "one service per guarded table family" turns into an import
 * cycle waiting to happen. `ProblemAccessService` is exactly that second
 * consumer — it must decide whether a problem may be shared with an
 * organization without depending on `OrgAccessService`.
 */
export function visibleOrgsWhere(db: Db, actor: Actor | null): SQL {
  if (isAdmin(actor)) return sql`true`;
  if (!actor) return eq(organizations.visibility, 'public');
  const memberOrgIds = db
    .select({ orgId: orgMembers.orgId })
    .from(orgMembers)
    .where(eq(orgMembers.userId, actor.userId));
  return or(eq(organizations.visibility, 'public'), inArray(organizations.id, memberOrgIds))!;
}

/**
 * Which of `orgIds` the actor belongs to, in ANY role — `owner`, `admin`,
 * and `member` all count. This is the question `ProblemAccessService` needs
 * answered before it may attach a problem to an organization: sharing must
 * require membership, not merely that the organization exists and is
 * nameable. An anonymous actor, or an empty `orgIds`, belongs to nothing.
 */
/**
 * The subset of `orgIds` in which `actor` is an **owner or an admin** —
 * membership that carries authority, not merely presence.
 *
 * Separate from `loadOrgMembership` rather than a flag on it, because the two
 * answer different questions and the wrong one is silently permissive:
 * membership decides what a person may SEE (`canViewVisible`), and this
 * decides what they may bind an organization to (D56 — restricting a contest
 * to a school is a claim to speak for that school, which a pupil on its
 * roster does not get to make).
 */
export async function loadOrgAdminships(
  db: Db,
  actor: Actor | null,
  orgIds: number[],
): Promise<Set<number>> {
  if (!actor || orgIds.length === 0) return new Set();
  const rows = await db
    .select({ orgId: orgMembers.orgId })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.userId, actor.userId),
        inArray(orgMembers.orgId, orgIds),
        inArray(orgMembers.role, ['owner', 'admin']),
      ),
    );
  return new Set(rows.map((r) => r.orgId));
}

export async function loadOrgMembership(
  db: Db,
  actor: Actor | null,
  orgIds: number[],
): Promise<Set<number>> {
  if (!actor || orgIds.length === 0) return new Set();
  const rows = await db
    .select({ orgId: orgMembers.orgId })
    .from(orgMembers)
    .where(and(eq(orgMembers.userId, actor.userId), inArray(orgMembers.orgId, orgIds)));
  return new Set(rows.map((r) => r.orgId));
}
