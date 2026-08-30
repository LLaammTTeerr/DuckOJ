/**
 * The team side of a contest (D99): resolving the team a join names, and
 * loading — in one query for a whole board — who each team on a scoreboard
 * actually is.
 *
 * Free functions taking `db`, the shape `participant-orgs.ts` and
 * `org.visibility.ts` already use, rather than methods on
 * `ContestAccessService`: two callers need them (`ContestAccessService` for
 * `join` and the board, `ContestSimilarityService` for the report's labels),
 * neither should depend on the other, and a free function here cannot grow
 * into a second opinion about who may see a team — it asks no visibility
 * question at all.
 *
 * **It asks none deliberately.** Every caller has already established what
 * it needs to: `join` has resolved the contest and the caller's standing in
 * it, and the board's teams are named on a scoreboard everybody who can see
 * the contest may read. A team's name is published by its own participation
 * — that is what a team scoreboard IS — which is why `TeamAccessService`'s
 * 404-for-strangers rule is about the ROSTER route and not about this.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { contestOrgs, organizations, teamMembers, teams } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';

/** A team as a scoreboard, a results sheet and a certificate print it. */
export interface ContestTeam {
  id: number;
  slug: string;
  name: string;
  orgSlug: string;
  orgName: string;
  /** Usernames, ordered — the same order two exports of one contest print. */
  members: string[];
}

/**
 * The team a `teamSlug` names among a contest's organizations, or
 * `undefined`.
 *
 * Scoped to the CONTEST's organizations rather than searched globally: a
 * team contest names its schools (D99 requires at least one), and a slug is
 * only unique per organization, so "team `doi-1`" is a question that only
 * has an answer inside a school. Two of the contest's schools each holding a
 * `doi-1` is resolved by the caller's own membership, which is checked next
 * — and if they are on both, the lowest team id wins, deterministically.
 */
export async function resolveContestTeam(
  db: Db,
  contestId: number,
  teamSlug: string,
): Promise<ContestTeam | undefined> {
  const rows = await db
    .select({
      id: teams.id,
      slug: teams.slug,
      name: teams.name,
      orgSlug: organizations.slug,
      orgName: organizations.name,
    })
    .from(teams)
    .innerJoin(organizations, eq(organizations.id, teams.orgId))
    .innerJoin(contestOrgs, eq(contestOrgs.orgId, teams.orgId))
    .where(and(eq(contestOrgs.contestId, contestId), sql`lower(${teams.slug}) = lower(${teamSlug})`))
    .orderBy(asc(teams.id));
  if (rows.length === 0) return undefined;
  const [first, ...rest] = rows;
  const found = [first!, ...rest];
  const members = await loadTeamMembers(
    db,
    found.map((row) => row.id),
  );
  return { ...found[0]!, members: members.get(found[0]!.id) ?? [] };
}

/**
 * Every team on a board, keyed by id — ONE query for the teams and one for
 * their members, never one per row: a province-sized team contest is
 * hundreds of rows and a per-row lookup would be hundreds of round trips to
 * fill in a column.
 */
export async function loadContestTeams(
  db: Db,
  teamIds: number[],
): Promise<Map<number, ContestTeam>> {
  const wanted = [...new Set(teamIds)];
  if (wanted.length === 0) return new Map();
  const [rows, members] = await Promise.all([
    db
      .select({
        id: teams.id,
        slug: teams.slug,
        name: teams.name,
        orgSlug: organizations.slug,
        orgName: organizations.name,
      })
      .from(teams)
      .innerJoin(organizations, eq(organizations.id, teams.orgId))
      .where(inArray(teams.id, wanted)),
    loadTeamMembers(db, wanted),
  ]);
  return new Map(rows.map((row) => [row.id, { ...row, members: members.get(row.id) ?? [] }]));
}

/**
 * Team id → its members' usernames, ordered by username.
 *
 * Ordered so that two reads of the same contest print a team's people in the
 * same order — a certificate that reshuffles the names between two prints is
 * a certificate somebody will notice.
 */
export async function loadTeamMembers(
  db: Db,
  teamIds: number[],
): Promise<Map<number, string[]>> {
  if (teamIds.length === 0) return new Map();
  const rows = await db
    .select({ teamId: teamMembers.teamId, username: schema.users.username })
    .from(teamMembers)
    .innerJoin(schema.users, eq(schema.users.id, teamMembers.userId))
    .where(inArray(teamMembers.teamId, teamIds))
    .orderBy(asc(teamMembers.teamId), asc(schema.users.username));
  const byTeam = new Map<number, string[]>();
  for (const row of rows) {
    const list = byTeam.get(row.teamId) ?? [];
    list.push(row.username);
    byTeam.set(row.teamId, list);
  }
  return byTeam;
}

/** The user ids on a team — what `join`'s member-disjointness check needs. */
export async function teamMemberIds(db: Db, teamId: number): Promise<number[]> {
  const rows = await db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));
  return rows.map((row) => row.userId);
}
