import { and, eq, inArray, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { isAdmin, type Actor } from './actor.js';

/**
 * The `private` / `org` / `public` triple, and the *one* decision that reads it.
 *
 * Problems had this first. Contests need exactly the same rule — design §5
 * says so, and this project has had one visibility bug per phase where a
 * second implementation disagreed with the first. So rather than a second
 * predicate shaped like the first, there is one predicate here that both
 * entities call, and one list-query builder beside it. `problem.visibility.ts`
 * and `contest.visibility.ts` keep their own *loaders* — the tables differ —
 * but neither owns a decision.
 *
 * Both forms must agree: the row-wise one answers "may this actor see this
 * row" for a 404-or-not, the SQL one answers the same question for every row
 * at once. They live eight lines apart for the same reason `canViewProblem`
 * and `visibleProblemsWhere` used to: agreement is easier to audit than to
 * remember.
 */
export type Visibility = 'private' | 'org' | 'public';

export interface VisibilityContext {
  /**
   * Whether the actor holds a *membership* on this row — a relationship that
   * outranks visibility outright. For a problem that is any of
   * author/curator/tester (a tester exists precisely so a private problem can
   * be proofread); for a contest it is being its creator.
   */
  isMember: boolean;
  /** Organizations this row is shared with. */
  sharedOrgIds: number[];
  /**
   * Organizations the actor belongs to **that this row is also shared with** —
   * the intersection, not the actor's full membership list. The loaders
   * compute it with a join against this row's sharing table, so an actor in
   * ten unrelated organizations arrives here with an empty array.
   *
   * That is exactly what this predicate needs, and it is a trap for any future
   * consumer that wants "which orgs is this user in" — a different question
   * with a different answer.
   */
  actorOrgIds: number[];
}

/** The single visibility predicate. Every row-wise read path shares it. */
export function canViewVisible(
  actor: Actor | null,
  visibility: Visibility,
  ctx: VisibilityContext,
): boolean {
  if (isAdmin(actor)) return true;
  // Membership outranks visibility.
  if (actor && ctx.isMember) return true;
  if (visibility === 'public') return true;
  if (visibility === 'org' && actor) {
    return ctx.sharedOrgIds.some((id) => ctx.actorOrgIds.includes(id));
  }
  return false;
}

/**
 * The list-query form of `canViewVisible`, as a `WHERE` fragment.
 *
 * The two subqueries are supplied by the caller because only it knows which
 * tables hold membership and org sharing; the *shape* of the condition —
 * public, or a member, or `org` and shared with one of mine — is decided here
 * and nowhere else.
 */
export function visibleRowsWhere(
  actor: Actor | null,
  columns: { visibility: PgColumn; id: PgColumn },
  subqueries: { memberOf: SQLWrapper; sharedWithMyOrgs: SQLWrapper },
): SQL {
  if (isAdmin(actor)) return sql`true`;
  if (!actor) return eq(columns.visibility, 'public');
  return or(
    eq(columns.visibility, 'public'),
    inArray(columns.id, subqueries.memberOf),
    and(eq(columns.visibility, 'org'), inArray(columns.id, subqueries.sharedWithMyOrgs)),
  )!;
}
