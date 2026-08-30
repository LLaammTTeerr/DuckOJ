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
import { and, asc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { contestParticipations, organizations, orgMembers, teamMembers, teams } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import type {
  CreateTeamRequestDto,
  PaginationQueryDto,
  TeamDetailDto,
  TeamMemberDto,
  TeamPageDto,
  TeamSummaryDto,
  UpdateTeamRequestDto,
} from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import { isAdmin, type Actor } from './actor.js';
import { OrgAccessService } from './org.access.js';

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
    return {
      items: kept.map((row) =>
        toSummary({ ...row, orgSlug: org.slug, orgName: org.name }, counts.get(row.id) ?? 0),
      ),
      nextCursor: rows.length > page.limit ? String(kept.at(-1)!.id) : null,
    };
  }

  /** One team and its members. Staff, a global admin, or somebody on it. */
  async get(actor: Actor, slug: string, teamSlug: string): Promise<TeamDetailDto> {
    const { row: org, role } = await this.orgs.loadVisibleWithRole(actor, slug);
    const team = await this.findTeam(org.id, teamSlug);
    const members = await this.membersOf(team.id);
    const staff = isAdmin(actor) || role === 'owner' || role === 'admin';
    if (!staff && !members.some((member) => member.userId === actor.userId)) throw teamNotFound();
    return toDetail(team, members, staff);
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
    return toDetail(await this.findTeamById(teamId), await this.membersOf(teamId), true);
  }

  /**
   * Rename a team or replace its roster.
   *
   * `members`, when present, replaces the WHOLE roster — delete then insert
   * inside one transaction rather than a diff, which is
   * `ProblemSetAccessService.update`'s choice for its reason: the client has
   * already said what the final set is.
   *
   * **A roster edit is not refused while a contest runs.** The membership is
   * read, never frozen, so a team that loses a member mid-round loses their
   * ability to submit for it from that moment; the participation, and every
   * submission already on it, is untouched. D99 records that as deliberate
   * rather than as an oversight.
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
    if (memberIds !== undefined) {
      await this.assertAddedMembersFree(team.id, memberIds);
    }
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
    return toDetail(await this.findTeamById(team.id), await this.membersOf(team.id), true);
  }

  /**
   * A roster edit may not put one pupil on two rows of one board (D99).
   *
   * `join` already refuses the second team that shares a member with one
   * already competing — and this is the same collision arriving by the back
   * door the rename above closed: an ordinary PATCH, which any admin of any
   * of the contest's schools can make while the round is running.
   *
   * D99 spells out what two rows for one person cost, and none of it is
   * cosmetic: `actingParticipations` would have to CHOOSE between them for
   * every submission (by lowest id, which is an arbitrary answer to "which
   * team did this pupil write it for"), `setDisqualified` — keyed by
   * username, D37 — would move both, and the board would show the same
   * person's work counted twice under two names.
   *
   * Scoped to the contests this team actually competes in, exactly as the
   * rename check is: adding anyone to a team that has entered nothing is
   * always free, which is the ordinary case. Rows this team ALREADY holds
   * are excluded, so the captain somebody took off by mistake can be put
   * back — their user id is on this team's own participation, and that is
   * not a second row.
   */
  private async assertAddedMembersFree(teamId: number, memberIds: number[]): Promise<void> {
    if (memberIds.length === 0) return;
    const contestIds = (
      await this.db
        .select({ contestId: contestParticipations.contestId })
        .from(contestParticipations)
        .where(eq(contestParticipations.teamId, teamId))
    ).map((row) => row.contestId);
    if (contestIds.length === 0) return;

    // The other teams these people are on, and who is on which — the second
    // half is what lets the refusal name the PUPIL rather than whichever
    // teammate happens to hold the rival row.
    const otherTeams = await this.db
      .select({ teamId: teamMembers.teamId, userId: teamMembers.userId })
      .from(teamMembers)
      .where(and(inArray(teamMembers.userId, memberIds), ne(teamMembers.teamId, teamId)));
    const memberOfTeam = new Map(otherTeams.map((row) => [row.teamId, row.userId]));

    const held = inArray(contestParticipations.userId, memberIds);
    const [clash] = await this.db
      .select({ userId: contestParticipations.userId, teamId: contestParticipations.teamId })
      .from(contestParticipations)
      .where(
        and(
          inArray(contestParticipations.contestId, contestIds),
          // NOT this team's own rows. Spelled with the `is null` arm because
          // `team_id <> $1` is NULL — and therefore false — for an
          // individual entry, which would silently exempt one.
          or(
            isNull(contestParticipations.teamId),
            ne(contestParticipations.teamId, teamId),
          )!,
          memberOfTeam.size === 0
            ? held
            : or(held, inArray(contestParticipations.teamId, [...memberOfTeam.keys()]))!,
        ),
      )
      .limit(1);
    if (!clash) return;

    const offenderId = memberIds.includes(clash.userId)
      ? clash.userId
      : (clash.teamId === null ? undefined : memberOfTeam.get(clash.teamId));
    const [offender] = offenderId === undefined
      ? []
      : await this.db
          .select({ username: schema.users.username })
          .from(schema.users)
          .where(eq(schema.users.id, offenderId))
          .limit(1);
    throw new AppError(
      409,
      'contest_already_joined',
      offender
        ? `${offender.username} is already competing in a contest this team has entered.`
        : 'Somebody on this roster is already competing in a contest this team has entered.',
    );
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

function toSummary(team: TeamRow, memberCount: number): TeamSummaryDto {
  return {
    slug: team.slug,
    name: team.name,
    orgSlug: team.orgSlug,
    orgName: team.orgName,
    memberCount,
    createdAt: team.createdAt.toISOString(),
  };
}

function toDetail(team: TeamRow, members: MemberRow[], canEdit: boolean): TeamDetailDto {
  const items: TeamMemberDto[] = members.map((member) => ({
    username: member.username,
    displayName: member.displayName,
    joinedAt: member.joinedAt.toISOString(),
  }));
  return { ...toSummary(team, items.length), members: items, canEdit };
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
