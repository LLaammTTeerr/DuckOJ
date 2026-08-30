/**
 * Which organizations each competitor in a contest belongs to (D71).
 *
 * A free function taking `db`, the shape `org.visibility.ts`'s
 * `loadOrgAdminships` already uses, rather than a method on
 * `ContestAccessService`: the one consumer is `ContestResultsService`, which
 * lives outside `authz/**` and therefore may not import
 * `@duckoj/db/guarded` at all (the runbook's "Reading a guarded table", and
 * ESLint enforces it over `apps/api/src/**`). A free function here is the
 * whole of what that service needs, needs no registration in
 * `authz.module.ts`, and cannot grow into a second visibility opinion.
 *
 * **This asks no visibility question, and must not.** Its only caller has
 * already established that the actor RUNS the contest (`canRunContest`), and
 * an organiser exporting their own results is entitled to know which school
 * each competitor came from — that is what the column is for. It is
 * deliberately unreachable from a request path that has not made that check,
 * because nothing else imports it.
 *
 * Keyed by USERNAME rather than participation id: a person's organizations
 * are theirs, and D36's split — one person may hold a live participation and
 * a virtual one in the same contest — duplicates the row, not the
 * membership. Both rows of such a competitor print the same schools, which
 * is correct.
 */
import { asc, eq } from 'drizzle-orm';
import { contestParticipations, organizations, orgMembers } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';

/** An organization as the export prints it. Same pair `ContestOrgDto` carries. */
export interface ParticipantOrg {
  slug: string;
  name: string;
}

/**
 * ONE query for the whole contest, never one per competitor: a
 * province-sized board is two thousand rows, and a per-row lookup would be
 * two thousand round trips to fill in a column.
 *
 * Ordered by slug, so two exports of the same contest list a competitor's
 * schools in the same order — a results file that reshuffles a column
 * between two downloads is a results file nobody can diff.
 */
export async function loadParticipantOrgs(
  db: Db,
  contestId: number,
): Promise<Map<string, ParticipantOrg[]>> {
  const rows = await db
    .selectDistinct({
      username: schema.users.username,
      slug: organizations.slug,
      name: organizations.name,
    })
    .from(contestParticipations)
    .innerJoin(schema.users, eq(schema.users.id, contestParticipations.userId))
    .innerJoin(orgMembers, eq(orgMembers.userId, contestParticipations.userId))
    .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
    .where(eq(contestParticipations.contestId, contestId))
    .orderBy(asc(schema.users.username), asc(organizations.slug));

  const byUsername = new Map<string, ParticipantOrg[]>();
  for (const row of rows) {
    // `selectDistinct` already collapses the duplicate a second
    // participation would produce; the map only groups.
    const list = byUsername.get(row.username) ?? [];
    list.push({ slug: row.slug, name: row.name });
    byUsername.set(row.username, list);
  }
  return byUsername;
}
