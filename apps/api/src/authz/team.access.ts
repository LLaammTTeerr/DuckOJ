/**
 * Teams — "đội tuyển", the roster an ICPC-style team contest is entered by
 * (D99).
 *
 * Three questions decide every call here, in this order, and none of them is
 * asked twice in this file — `ProblemSetAccessService`'s arrangement, for its
 * reasons:
 *
 * 1. **May this actor see the organization?** `OrgAccessService`'s own
 *    `loadVisibleWithRole` / `loadForEdit`, never a second copy of
 *    `visibleOrgsWhere`.
 * 2. **May they read THIS team?** An owner or admin of the school, a global
 *    admin, or somebody on the team. Anybody else gets the 404 a team that
 *    does not exist gets: a squad list read off the API the morning of the
 *    round is reconnaissance, and existence is what the 404-over-403 rule
 *    protects.
 * 3. **May they change it?** Owner or admin (`loadForEdit`), which is the
 *    rank D66 already gives a school's homework. The brief said "owner
 *    creates"; an organization `admin` is the rank that exists precisely to
 *    do the owner's day-to-day work, and D61's owner-only rule is about
 *    minting *accounts*, which this does not (D99).
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  contestOrgs,
  contestParticipations,
  contests,
  organizations,
  orgMembers,
  teamMembers,
  teams,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import {
  MY_TEAMS_LIMIT,
  type CreateTeamRequestDto,
  type MyTeamListDto,
  type MyTeamSummaryDto,
  type MyTeamsQueryDto,
  type PaginationQueryDto,
  type TeamContestEntryDto,
  type TeamDetailDto,
  type TeamIneligibleReasonDto,
  type TeamMemberDto,
  type TeamPageDto,
  type TeamSummaryDto,
  type UpdateTeamRequestDto,
} from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import { isAdmin, type Actor } from './actor.js';
import { OrgAccessService } from './org.access.js';
import { ContestAccessService, canRunContest } from './contest.access.js';

const UNIQUE_VIOLATION = '23505';
const TEAM_SLUG_CONSTRAINT = 'teams_org_slug_lower_idx';
/** Postgres SQLSTATE for a foreign key a row still points at. */
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * One row of `teams`, as every method here reads it — with its school's slug
 * and name joined on.
 *
 * The organization travels WITH the team because `OrgAccessService
 * .loadForEdit` answers with `OrgRow`, which carries no `name` (it exists to
 * decide visibility, not to render), and a team summary prints the school on
 * every row. One join beats a second lookup per write.
 */
export interface TeamRow {
  id: number;
  slug: string;
  name: string;
  orgSlug: string;
  orgName: string;
  createdAt: Date;
}

@Injectable()
export class TeamAccessService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OrgAccessService) private readonly orgs: OrgAccessService,
    /**
     * For `?contest=` alone. `ContestAccessService` owns "may this caller see
     * this contest", and asking it beats a second copy of that rule living
     * here — the whole arrangement this file's header describes.
     */
    @Inject(ContestAccessService) private readonly contests: ContestAccessService,
  ) {}

  /**
   * One page of an organization's teams.
   *
   * A school's staff see every team; anybody else sees only the teams they
   * are ON, and somebody who can see the organization but is on none gets an
   * EMPTY page rather than a refusal — D66's shape, for D66's reason: "no
   * teams" is exactly what a school that has assembled none returns.
   */
  async list(actor: Actor, slug: string, page: PaginationQueryDto): Promise<TeamPageDto> {
    const { row: org, role } = await this.orgs.loadVisibleWithRole(actor, slug);
    const staff = isAdmin(actor) || role === 'owner' || role === 'admin';

    const after = parseTeamCursor(page.cursor);
    const mine = this.db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(eq(teamMembers.userId, actor.userId));
    const rows = await this.db
      .select({
        id: teams.id,
        slug: teams.slug,
        name: teams.name,
        createdAt: teams.createdAt,
      })
      .from(teams)
      .where(
        and(
          eq(teams.orgId, org.id),
          gt(teams.id, after),
          // A subquery rather than a join: a join through `team_members`
          // would multiply a page by the roster size and then need a
          // DISTINCT, which the keyset walk cannot page through.
          staff ? undefined : inArray(teams.id, mine),
        ),
      )
      .orderBy(asc(teams.id))
      .limit(page.limit + 1);

    const kept = rows.slice(0, page.limit);
    const counts = await this.memberCounts(kept.map((row) => row.id));
    const locked = await this.teamsInRunningContest(kept.map((row) => row.id));
    return {
      items: kept.map((row) =>
        toSummary(
          { ...row, orgSlug: org.slug, orgName: org.name },
          counts.get(row.id) ?? 0,
          locked.has(row.id),
        ),
      ),
      nextCursor: rows.length > page.limit ? String(kept.at(-1)!.id) : null,
    };
  }

  /**
   * Every team this caller is on, across every school — one request (D99 as
   * amended by F-25).
   *
   * **Why it exists.** The join picker used to issue `GET /orgs/{slug}/teams`
   * once per organization the contest named. Fine at two schools; at twenty
   * it is twenty round trips to fill in a `<select>`, on the page a whole
   * province opens at the same minute.
   *
   * **It asks no visibility question**, deliberately, and that is not a hole:
   * every row it returns is a team the caller is ON, which is the strongest
   * membership `get` accepts. The organization is joined for its name, not
   * for permission — somebody on a team in a private school may obviously
   * know that school's name.
   *
   * Not paged (`MY_TEAMS_LIMIT`): a person is on a handful of teams, and a
   * picker that had to page would carry a bug nobody ever reproduces.
   */
  async myTeams(actor: Actor, query: MyTeamsQueryDto): Promise<MyTeamListDto> {
    const rows = await this.teamQuery()
      .innerJoin(teamMembers, eq(teamMembers.teamId, teams.id))
      .where(eq(teamMembers.userId, actor.userId))
      .orderBy(asc(organizations.name), asc(teams.name), asc(teams.id))
      .limit(MY_TEAMS_LIMIT + 1);

    const kept = rows.slice(0, MY_TEAMS_LIMIT);
    const ids = kept.map((row) => row.id);
    const counts = await this.memberCounts(ids);
    const locked = await this.teamsInRunningContest(ids);
    const eligibility = query.contest
      ? await this.eligibilityFor(actor, query.contest, kept, counts)
      : new Map<number, { eligible: boolean; reason: TeamIneligibleReasonDto | null }>();

    return {
      items: kept.map((row): MyTeamSummaryDto => {
        const verdict = eligibility.get(row.id);
        return {
          ...toSummary(row, counts.get(row.id) ?? 0, locked.has(row.id)),
          // BOTH null without a `?contest=`: "may this team enter" has no
          // answer without a contest, and `true` would make a picker that
          // forgot the parameter look like it worked.
          eligible: verdict ? verdict.eligible : null,
          ineligibleReason: verdict ? verdict.reason : null,
        };
      }),
      truncated: rows.length > MY_TEAMS_LIMIT,
    };
  }

  /**
   * One team, its members, and its record.
   *
   * Staff, a global admin, or somebody on it — anybody else gets the 404 a
   * team that does not exist gets.
   *
   * The contests it has entered ride along rather than living behind a second
   * request: they are what a team page is FOR, they are three or four rows,
   * and the alternative is a screen that renders a roster and then pops a
   * history in under it a moment later.
   */
  async get(actor: Actor, slug: string, teamSlug: string): Promise<TeamDetailDto> {
    const { row: org, role } = await this.orgs.loadVisibleWithRole(actor, slug);
    const team = await this.findTeam(org.id, teamSlug);
    const members = await this.membersOf(team.id);
    const staff = isAdmin(actor) || role === 'owner' || role === 'admin';
    if (!staff && !members.some((member) => member.userId === actor.userId)) throw teamNotFound();
    const entered = await this.contestsOf(team.id);
    return toDetail(team, members, staff, entered);
  }

  /** Assemble a team. Owner or admin of the organization, or a global admin. */
  async create(actor: Actor, slug: string, body: CreateTeamRequestDto): Promise<TeamDetailDto> {
    const { row: org } = await this.orgs.loadForEdit(actor, slug);
    const memberIds = await this.resolveMembers(org.id, body.members);

    let teamId: number;
    try {
      teamId = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(teams)
          .values({ orgId: org.id, slug: body.slug, name: body.name, createdBy: actor.userId })
          .returning({ id: teams.id });
        if (memberIds.length > 0) {
          await tx.insert(teamMembers).values(memberIds.map((userId) => ({ teamId: row!.id, userId })));
        }
        return row!.id;
      });
    } catch (error) {
      throw toTeamConflict(error);
    }
    // A team that was just assembled has entered nothing.
    return toDetail(await this.findTeamById(teamId), await this.membersOf(teamId), true, []);
  }

  /**
   * Rename a team or replace its roster.
   *
   * `members`, when present, replaces the WHOLE roster — delete then insert
   * inside one transaction rather than a diff, which is
   * `ProblemSetAccessService.update`'s choice for its reason: the client has
   * already said what the final set is.
   *
   * **A ROSTER edit is refused while a contest this team has entered is
   * running** — 409 `team_locked_during_contest` — unless the caller runs
   * every one of those contests, or is a global admin. This REVERSES D99's
   * "rosters stay live", and the reversal is what a real contest day
   * taught: membership is read on every submission, so swapping a member
   * mid-round hands a stranger the team's participation and every point on
   * it, and an ordinary org admin at ANY of the contest's schools could do
   * it. The one legitimate mid-round edit — the pupil who did not turn up —
   * is made by the person running the round, which is exactly who the
   * exemption names. A RENAME is not covered here: it has its own rule
   * (`assertRenameKeepsBoardsUnambiguous`), which is about the board being
   * unambiguous rather than about the roster being stable, and a typo fixed
   * during a round harms nobody.
   *
   * `members`, when present, replaces the WHOLE roster — delete then insert
   * inside one transaction rather than a diff, which is
   * `ProblemSetAccessService.update`'s choice for its reason: the client has
   * already said what the final set is.
   */
  async update(
    actor: Actor,
    slug: string,
    teamSlug: string,
    patch: UpdateTeamRequestDto,
  ): Promise<TeamDetailDto> {
    const { row: org } = await this.orgs.loadForEdit(actor, slug);
    const team = await this.findTeam(org.id, teamSlug);
    const memberIds = patch.members ? await this.resolveMembers(org.id, patch.members) : undefined;
    if (memberIds !== undefined) await this.assertRosterUnlocked(actor, team.id);
    if (patch.name !== undefined && patch.name.toLowerCase() !== team.name.toLowerCase()) {
      await this.assertRenameKeepsBoardsUnambiguous(team.id, patch.name);
    }

    const values: Partial<typeof teams.$inferInsert> = {};
    if (patch.slug !== undefined) values.slug = patch.slug;
    if (patch.name !== undefined) values.name = patch.name;

    try {
      await this.db.transaction(async (tx) => {
        if (Object.keys(values).length > 0) {
          await tx.update(teams).set(values).where(eq(teams.id, team.id));
        }
        if (memberIds !== undefined) {
          await tx.delete(teamMembers).where(eq(teamMembers.teamId, team.id));
          if (memberIds.length > 0) {
            await tx.insert(teamMembers).values(memberIds.map((userId) => ({ teamId: team.id, userId })));
          }
        }
      });
    } catch (error) {
      throw toTeamConflict(error);
    }
    return toDetail(
      await this.findTeamById(team.id),
      await this.membersOf(team.id),
      true,
      await this.contestsOf(team.id),
    );
  }

  /**
   * A roster may not change while a contest this team is entered in is
   * running (D99 as amended by F-25).
   *
   * **The exemption is per-contest and it is ALL of them, not any.** A team
   * competing in two running rounds may only be edited by somebody who runs
   * both: an organiser of round A has no standing to reshuffle a roster that
   * is mid-round in B, and "any" would make the rule evaporate the moment a
   * team entered a second contest. A global admin passes by `isAdmin`, which
   * is the rank that already answers for the deployment.
   *
   * The window is `[startTime, endTime]` — the same interval the contest page
   * calls "running" — and it is closed at both ends deliberately: a
   * participation minted at the gun and a submission made in the final second
   * are both inside the round.
   */
  private async assertRosterUnlocked(actor: Actor, teamId: number): Promise<void> {
    const running = await this.db
      .select({
        id: contests.id,
        createdBy: contests.createdBy,
        key: contests.key,
      })
      .from(contestParticipations)
      .innerJoin(contests, eq(contests.id, contestParticipations.contestId))
      .where(
        and(
          eq(contestParticipations.teamId, teamId),
          sql`now() between ${contests.startTime} and ${contests.endTime}`,
        ),
      );
    if (running.length === 0) return;
    if (running.every((contest) => canRunContest(actor, contest))) return;
    throw new AppError(
      409,
      'team_locked_during_contest',
      'This team is competing right now; its roster cannot be changed until the contest ends.',
    );
  }

  /**
   * Which of these teams are competing at this instant — one query for a
   * whole page, never one per row.
   *
   * The web reads it to warn a teacher BEFORE they open an edit form, which
   * is the difference between a rule and an ambush.
   */
  private async teamsInRunningContest(teamIds: number[]): Promise<Set<number>> {
    if (teamIds.length === 0) return new Set();
    const rows = await this.db
      .selectDistinct({ teamId: contestParticipations.teamId })
      .from(contestParticipations)
      .innerJoin(contests, eq(contests.id, contestParticipations.contestId))
      .where(
        and(
          inArray(contestParticipations.teamId, teamIds),
          sql`now() between ${contests.startTime} and ${contests.endTime}`,
        ),
      );
    return new Set(rows.map((row) => row.teamId).filter((id): id is number => id !== null));
  }

  /** Every contest this team has entered, newest first. */
  private async contestsOf(teamId: number): Promise<TeamContestEntryDto[]> {
    const rows = await this.db
      .select({
        key: contests.key,
        name: contests.name,
        startTime: contests.startTime,
        endTime: contests.endTime,
        isDisqualified: contestParticipations.isDisqualified,
        captain: schema.users.username,
        running: sql<boolean>`now() between ${contests.startTime} and ${contests.endTime}`,
      })
      .from(contestParticipations)
      .innerJoin(contests, eq(contests.id, contestParticipations.contestId))
      .innerJoin(schema.users, eq(schema.users.id, contestParticipations.userId))
      .where(eq(contestParticipations.teamId, teamId))
      .orderBy(desc(contests.startTime), desc(contests.id));
    return rows.map((row) => ({
      key: row.key,
      name: row.name,
      startTime: row.startTime.toISOString(),
      endTime: row.endTime.toISOString(),
      running: row.running,
      isDisqualified: row.isDisqualified,
      captain: row.captain,
    }));
  }

  /**
   * May each of these teams enter the contest `?contest=` names?
   *
   * **Every code here is one `POST /contests/{key}/join` would answer with**,
   * and that is the whole design: this route exists so a picker can grey a
   * choice out before the click, and a screen that explained a refusal in
   * words the server would not use is a screen that disagrees with the server
   * the first time either changes. The one code join never produces is
   * `contest_team_org_not_named` — join resolves a slug INSIDE the contest's
   * schools and simply does not find a team outside them, which from a
   * picker's side is the same refusal spelled differently.
   *
   * It is a snapshot, not a promise: two teams racing for one name are
   * separated at join by the advisory lock, and a picker cannot be. What it
   * buys is that the ordinary refusals — wrong school, too many people, a
   * teammate already entered — are visible before contest day rather than at
   * the gun.
   *
   * A contest the caller may not see 404s, through `ContestAccessService`
   * itself rather than a second opinion about visibility.
   */
  private async eligibilityFor(
    actor: Actor,
    key: string,
    rows: TeamRow[],
    counts: Map<number, number>,
  ): Promise<Map<number, { eligible: boolean; reason: TeamIneligibleReasonDto | null }>> {
    const verdicts = new Map<number, { eligible: boolean; reason: TeamIneligibleReasonDto | null }>();
    const contest = await this.contests.loadVisible(actor, key);
    if (contest.participationMode !== 'team') {
      for (const row of rows) verdicts.set(row.id, { eligible: false, reason: 'contest_not_team_mode' });
      return verdicts;
    }

    const named = new Set(
      (
        await this.db
          .select({ slug: organizations.slug })
          .from(contestOrgs)
          .innerJoin(organizations, eq(organizations.id, contestOrgs.orgId))
          .where(eq(contestOrgs.contestId, contest.id))
      ).map((org) => org.slug.toLowerCase()),
    );

    // Everything already on this contest's board, in ONE query: which teams
    // hold a row, which names are taken, and which people are spoken for.
    const entered = await this.db
      .select({
        teamId: contestParticipations.teamId,
        userId: contestParticipations.userId,
        name: teams.name,
      })
      .from(contestParticipations)
      .leftJoin(teams, eq(teams.id, contestParticipations.teamId))
      .where(eq(contestParticipations.contestId, contest.id));
    const enteredTeams = new Set(entered.map((row) => row.teamId).filter((id) => id !== null));
    const takenNames = new Set(
      entered.map((row) => row.name?.toLowerCase()).filter((name) => name !== undefined),
    );
    const busyUsers = new Set(entered.map((row) => row.userId));

    const rosters = await this.rostersOf(rows.map((row) => row.id));
    for (const row of rows) {
      const roster = rosters.get(row.id) ?? [];
      let reason: TeamIneligibleReasonDto | null = null;
      if (!named.has(row.orgSlug.toLowerCase())) reason = 'contest_team_org_not_named';
      else if (enteredTeams.has(row.id)) reason = 'contest_team_joined';
      else if ((counts.get(row.id) ?? 0) > contest.maxTeamSize) reason = 'contest_team_too_large';
      else if (roster.some((userId) => busyUsers.has(userId))) reason = 'contest_already_joined';
      else if (takenNames.has(row.name.toLowerCase())) reason = 'contest_team_name_taken';
      verdicts.set(row.id, { eligible: reason === null, reason });
    }
    return verdicts;
  }

  /** Team id → its members' user ids, one query for a whole list. */
  private async rostersOf(teamIds: number[]): Promise<Map<number, number[]>> {
    if (teamIds.length === 0) return new Map();
    const rows = await this.db
      .select({ teamId: teamMembers.teamId, userId: teamMembers.userId })
      .from(teamMembers)
      .where(inArray(teamMembers.teamId, teamIds));
    const byTeam = new Map<number, number[]>();
    for (const row of rows) {
      const list = byTeam.get(row.teamId) ?? [];
      list.push(row.userId);
      byTeam.set(row.teamId, list);
    }
    return byTeam;
  }

  /**
   * A rename may not make two teams on one scoreboard share a name (D99).
   *
   * `join` already refuses the second of two same-named teams entering one
   * contest — but a rename is the same collision arriving by the back door,
   * and it is an ordinary PATCH any admin of any of the contest's schools can
   * make while the round is running. It is NOT a display problem: the board's
   * `teams` sidecar is keyed by the name, so two rows sharing one would
   * collapse to a single entry, and then the scoreboard's disqualify button
   * sends the WRONG team's captain and the results sheet prints the wrong
   * roster against one of the two rows. Enforcement and exports, not
   * cosmetics — so the rule is checked wherever the name can change.
   *
   * Scoped to the contests this team actually competes in: renaming a team
   * that has never entered anything is always free, which is the ordinary
   * case (fixing a typo the week before the round).
   */
  private async assertRenameKeepsBoardsUnambiguous(teamId: number, name: string): Promise<void> {
    const rival = alias(contestParticipations, 'rival');
    const [clash] = await this.db
      .select({ id: rival.id })
      .from(contestParticipations)
      .innerJoin(
        rival,
        and(
          eq(rival.contestId, contestParticipations.contestId),
          ne(rival.teamId, contestParticipations.teamId),
        ),
      )
      .innerJoin(teams, eq(teams.id, rival.teamId))
      .where(and(eq(contestParticipations.teamId, teamId), sql`lower(${teams.name}) = lower(${name})`))
      .limit(1);
    if (clash) {
      throw new AppError(
        409,
        'contest_team_name_taken',
        'Another team of that name is competing in a contest this team has entered.',
      );
    }
  }

  /**
   * Disband a team.
   *
   * Refused with 409 for a team that has competed: `contest_participations
   * .team_id` is `ON DELETE RESTRICT`, so the database refuses it anyway —
   * this turns that into an answer a client can read rather than a 500. The
   * record of what a team did is its participation, and a delete that took
   * the row with it would delete a contest's results.
   */
  async remove(actor: Actor, slug: string, teamSlug: string): Promise<void> {
    const { row: org } = await this.orgs.loadForEdit(actor, slug);
    const team = await this.findTeam(org.id, teamSlug);
    const [competed] = await this.db
      .select({ id: contestParticipations.id })
      .from(contestParticipations)
      .where(eq(contestParticipations.teamId, team.id))
      .limit(1);
    if (competed) {
      throw new AppError(
        409,
        'team_has_participations',
        'This team has entered a contest, so its record cannot be deleted.',
      );
    }
    try {
      await this.db.delete(teams).where(eq(teams.id, team.id));
    } catch (error) {
      // The pre-check above loses a race with a join committing between the
      // two statements; the constraint is what actually decides, so its
      // violation answers with the same code rather than a 500.
      if (asViolation(error, FOREIGN_KEY_VIOLATION)) {
        throw new AppError(
          409,
          'team_has_participations',
          'This team has entered a contest, so its record cannot be deleted.',
        );
      }
      throw error;
    }
  }

  /**
   * Usernames → user ids, refusing anything that is not on this
   * organization's roster.
   *
   * `lower() = lower()`, like every other username resolution in this repo:
   * an exact-match `eq()` against the case-folded unique index is a bug this
   * codebase has already paid for once.
   */
  private async resolveMembers(orgId: number, usernames: string[]): Promise<number[]> {
    if (usernames.length === 0) return [];
    const wanted = [...new Set(usernames.map((name) => name.toLowerCase()))];
    const rows = await this.db
      .select({ id: schema.users.id, username: schema.users.username, orgId: orgMembers.orgId })
      .from(schema.users)
      .leftJoin(
        orgMembers,
        and(eq(orgMembers.userId, schema.users.id), eq(orgMembers.orgId, orgId)),
      )
      .where(inArray(sql`lower(${schema.users.username})`, wanted));

    const byName = new Map(rows.map((row) => [row.username.toLowerCase(), row]));
    const fields: Record<string, string[]> = {};
    const ids: number[] = [];
    usernames.forEach((username, index) => {
      const row = byName.get(username.toLowerCase());
      if (!row) {
        (fields[`members.${String(index)}`] ??= []).push('team_member_unknown');
        return;
      }
      if (row.orgId === null) {
        (fields[`members.${String(index)}`] ??= []).push('team_member_not_in_org');
        return;
      }
      ids.push(row.id);
    });
    if (Object.keys(fields).length > 0) {
      throw new AppError(
        422,
        'team_members_invalid',
        'Every member of a team must be on this organization’s roster.',
        fields,
      );
    }
    // De-duplicated: the same person named twice is one member, and the
    // primary key would otherwise turn a typo into a 500.
    return [...new Set(ids)];
  }

  private async findTeam(orgId: number, teamSlug: string): Promise<TeamRow> {
    const [row] = await this.teamQuery()
      .where(and(eq(teams.orgId, orgId), sql`lower(${teams.slug}) = lower(${teamSlug})`))
      .limit(1);
    if (!row) throw teamNotFound();
    return row;
  }

  private async findTeamById(id: number): Promise<TeamRow> {
    const [row] = await this.teamQuery().where(eq(teams.id, id)).limit(1);
    if (!row) throw teamNotFound();
    return row;
  }

  private teamQuery() {
    return this.db
      .select({
        id: teams.id,
        slug: teams.slug,
        name: teams.name,
        orgSlug: organizations.slug,
        orgName: organizations.name,
        createdAt: teams.createdAt,
      })
      .from(teams)
      .innerJoin(organizations, eq(organizations.id, teams.orgId));
  }

  private async membersOf(teamId: number): Promise<MemberRow[]> {
    return this.db
      .select({
        userId: teamMembers.userId,
        username: schema.users.username,
        displayName: schema.users.displayName,
        joinedAt: teamMembers.joinedAt,
      })
      .from(teamMembers)
      .innerJoin(schema.users, eq(schema.users.id, teamMembers.userId))
      .where(eq(teamMembers.teamId, teamId))
      .orderBy(asc(schema.users.username));
  }

  /** One query for a whole page, never one per row. */
  private async memberCounts(teamIds: number[]): Promise<Map<number, number>> {
    if (teamIds.length === 0) return new Map();
    const rows = await this.db
      .select({ teamId: teamMembers.teamId, count: sql<number>`count(*)::int` })
      .from(teamMembers)
      .where(inArray(teamMembers.teamId, teamIds))
      .groupBy(teamMembers.teamId);
    return new Map(rows.map((row) => [row.teamId, row.count]));
  }
}

interface MemberRow {
  userId: number;
  username: string;
  displayName: string;
  joinedAt: Date;
}

/**
 * ONE answer to three questions: there is no such team, it is in an
 * organization you may not see, or it is one you neither run nor belong to.
 * `problem_set_not_found`'s shape, for its reason.
 */
function teamNotFound(): AppError {
  return new AppError(404, 'team_not_found', 'No such team.');
}

function toSummary(
  team: TeamRow,
  memberCount: number,
  inRunningContest: boolean,
): TeamSummaryDto {
  return {
    slug: team.slug,
    name: team.name,
    orgSlug: team.orgSlug,
    orgName: team.orgName,
    memberCount,
    createdAt: team.createdAt.toISOString(),
    inRunningContest,
  };
}

function toDetail(
  team: TeamRow,
  members: MemberRow[],
  canEdit: boolean,
  contests: TeamContestEntryDto[],
): TeamDetailDto {
  const items: TeamMemberDto[] = members.map((member) => ({
    username: member.username,
    displayName: member.displayName,
    joinedAt: member.joinedAt.toISOString(),
  }));
  return {
    ...toSummary(team, items.length, contests.some((entry) => entry.running)),
    members: items,
    contests,
    canEdit,
  };
}

function toTeamConflict(error: unknown): unknown {
  const unique = asViolation(error, UNIQUE_VIOLATION);
  if (unique?.constraint_name === TEAM_SLUG_CONSTRAINT) {
    return new AppError(409, 'team_slug_taken', 'This organization already has a team with that slug.');
  }
  return error;
}

function asViolation(
  error: unknown,
  code: string,
): { code: string; constraint_name?: string } | undefined {
  if (isViolationShape(error, code)) return error;
  const cause = error instanceof Error ? error.cause : undefined;
  return isViolationShape(cause, code) ? cause : undefined;
}

function isViolationShape(
  value: unknown,
  code: string,
): value is { code: string; constraint_name?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    (value as { code?: unknown }).code === code
  );
}

/** A team list cursor is a `teams.id`, like every other id cursor here. */
function parseTeamCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const after = Number(cursor);
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new AppError(422, 'invalid_cursor', 'That page cursor is not valid.');
  }
  return after;
}
