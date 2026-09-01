/**
 * Teams — "đội tuyển", the roster an ICPC-style team contest is entered by
 * (D99).
 *
 * A separate module from `orgs.ts`, registered under the SAME
 * `Organizations` tag, on `problem-sets.ts`' precedent: every route lives
 * under `/orgs/{slug}` and a team belongs to a school the way a roster does.
 * The file split is size, not domain.
 *
 * The **contest** side of teams — `participationMode`, `maxTeamSize`, the
 * `teamSlug` a join carries, the team a participation names, and the
 * scoreboard's `teams` sidecar — lives in `contests.ts`, beside the rest of
 * what a contest is. Only the roster itself is here.
 */
import { z } from 'zod';
import { PaginationQuery, ProblemDetails, Timestamp, cursorPage } from './common.js';
import { ORG_SLUG } from './orgs.js';
import { TEAM_MAX_MEMBERS } from './contests.js';
import { registry } from './registry.js';

/**
 * The same grammar an organization's own slug uses, for
 * `PROBLEM_SET_SLUG`'s reason: the URL is `/orgs/{slug}/teams/{teamSlug}`,
 * and two slug rules in one path is two rules a teacher has to learn to name
 * a thing.
 */
export const TEAM_SLUG = ORG_SLUG;

/**
 * `TEAM_MAX_MEMBERS` lives in `contests.ts` — it is the ceiling a contest's
 * own `maxTeamSize` may reach, and importing it from there rather than the
 * other way round keeps `registerPath`'s side-effect order (and therefore
 * `openapi.json`'s path order) the one `index.ts` documents.
 */

/**
 * One member of a team.
 *
 * `displayName` rides along because every screen that prints a team prints
 * its people — the contest scoreboard's hover, the certificate, the org
 * page's roster — and looking each one up would be a request per member.
 */
export const TeamMember = z.object({
  username: z.string(),
  displayName: z.string(),
  joinedAt: Timestamp,
});
export type TeamMemberDto = z.infer<typeof TeamMember>;

/**
 * A team as a list row.
 *
 * `orgSlug` is carried even though the URL already names it: the same shape
 * appears inside a contest participation and on the scoreboard, where there
 * is no path to read it from, and one shape for a team beats two.
 */
export const TeamSummary = z.object({
  slug: z.string(),
  name: z.string(),
  orgSlug: z.string(),
  orgName: z.string(),
  memberCount: z.number().int(),
  createdAt: Timestamp,
  /**
   * This team is entered in a contest that is running RIGHT NOW (D99 as
   * amended by F-25).
   *
   * Served rather than derived, and on the summary rather than only on the
   * detail, because it is what makes a roster read-only: while it is true, a
   * membership change is refused with 409 `team_locked_during_contest` for
   * anyone who does not run the contest. A teacher who cannot see WHY the
   * edit is refused until they have already tried it is a teacher who tries
   * it during the round, which is exactly the moment the refusal costs the
   * most.
   */
  inRunningContest: z.boolean(),
});
export type TeamSummaryDto = z.infer<typeof TeamSummary>;

export const TeamPage = cursorPage(TeamSummary);
export type TeamPageDto = z.infer<typeof TeamPage>;

/**
 * One contest this team has entered — its record, in the order a reader
 * wants it (newest first).
 *
 * Deliberately NOT a rank. Ranking a team means folding the contest's
 * scoreboard, which is a cached two-second fold per contest (D25) and would
 * make a team page cost one of those per row; and a rank means nothing at all
 * for a contest still running, which is the state this panel exists to show.
 * The contest is a link, and the contest's own results page is where a
 * standing lives.
 */
export const TeamContestEntry = z.object({
  key: z.string(),
  name: z.string(),
  startTime: Timestamp,
  endTime: Timestamp,
  /** `now` is inside `[startTime, endTime]` — the state that locks the roster. */
  running: z.boolean(),
  isDisqualified: z.boolean(),
  /** Which member's account holds the row (D99's captain). */
  captain: z.string(),
});
export type TeamContestEntryDto = z.infer<typeof TeamContestEntry>;

export const TeamDetail = TeamSummary.extend({
  members: z.array(TeamMember),
  /** Every contest this team has entered, newest first. */
  contests: z.array(TeamContestEntry),
  /**
   * Whether THIS caller may edit the team — an owner or admin of the
   * organization, or a global admin. Served rather than derived, exactly as
   * `ContestDetail.canEdit` is and for its reason: the alternative is a
   * client assembling the answer from two other requests and getting it
   * subtly different from the server's own check.
   */
  canEdit: z.boolean(),
  /**
   * What this caller must send back as `expectedVersion` to be sure their
   * PATCH replaces the state they were shown \u2014 D161, extended to this form
   * by D176.
   *
   * An opaque hash of the team's **stored editable state**: its slug, its name
   * and its roster. Exactly what `UpdateTeamRequest` writes \u2014 so `contests`
   * above is deliberately absent, because a team entering a round is not an
   * edit to the team and must not refuse a rename made in the same minute.
   *
   * **`null` when `canEdit` is false**, on that field's own precedent and
   * gated on the same predicate: a team member who may read the roster has no
   * PATCH to send it back on.
   */
  version: z.string().nullable(),
});
export type TeamDetailDto = z.infer<typeof TeamDetail>;

/**
 * `members` is a list of USERNAMES, resolved at write time, and every one of
 * them must already belong to the organization: a team is a school's entry,
 * and enrolling an outsider through it would route around the roster
 * (`team_member_not_in_org`, 422).
 */
export const CreateTeamRequest = z
  .object({
    slug: z.string().regex(TEAM_SLUG),
    name: z.string().min(1).max(200),
    members: z.array(z.string().min(1).max(64)).max(TEAM_MAX_MEMBERS).default([]),
  })
  .strict();
export type CreateTeamRequestDto = z.infer<typeof CreateTeamRequest>;

/**
 * Every field optional; an absent one is left alone. `members`, when
 * present, REPLACES the whole roster — the shape `UpdateProblemSetRequest`
 * gives `problems` and `UpdateContestRequest` gives `orgSlugs`, because a
 * partial patch of a set has no meaning a client could predict.
 */
export const UpdateTeamRequest = z
  .object({
    slug: z.string().regex(TEAM_SLUG).optional(),
    name: z.string().min(1).max(200).optional(),
    members: z.array(z.string().min(1).max(64)).max(TEAM_MAX_MEMBERS).optional(),
    /**
     * The `version` this client read before it started editing \u2014 D161's
     * token, extended to this form by D176. Present and no longer current is a
     * 409 `team_version_conflict` with **nothing written**.
     *
     * The field at risk is `members`, which is the most all-or-nothing field
     * in this API: it REPLACES the whole roster, so a co-admin who added the
     * fourth pupil while this form was open has them removed again by a save
     * that was only meant to fix the team's name. On contest morning that is a
     * pupil who cannot compete, and nothing failed and nobody was told.
     *
     * **Absent means unchecked**, as on `UpdateProblemRequest` and for the
     * same reason.
     */
    expectedVersion: z.string().optional(),
  })
  .strict();
export type UpdateTeamRequestDto = z.infer<typeof UpdateTeamRequest>;

const OrgSlugParam = z.object({ slug: z.string() });
const TeamParam = z.object({ slug: z.string(), teamSlug: z.string() });

const NOT_SIGNED_IN = {
  description: 'Not signed in',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const FORBIDDEN = {
  description: 'Signed in, but not an owner or admin of this organization',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const ORG_NOT_FOUND = {
  description: 'No such organization, or one the caller may not see — the two are indistinguishable',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const TEAM_NOT_FOUND = {
  description:
    'No such team, one in an organization the caller may not see, or one the caller neither runs ' +
    'nor belongs to — indistinguishable by design (`team_not_found`)',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const TEAM_VALIDATION_FAILED = {
  description:
    'The request failed validation. `team_member_unknown` — a username no account has; ' +
    '`team_member_not_in_org` — an account that is not on this organization’s roster.',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const TEAM_SLUG_TAKEN = {
  description: 'This organization already has a team with that slug (`team_slug_taken`)',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};

registry.registerPath({
  method: 'get',
  path: '/orgs/{slug}/teams',
  tags: ['Organizations'],
  summary: "An organization's teams",
  description:
    'An owner or admin of the organization (or a global admin) sees every team; anybody else ' +
    'sees the teams they are ON, and a caller who can see the organization but belongs to no ' +
    'team in it gets an EMPTY page rather than a refusal — D66’s shape, for D66’s reason. An ' +
    'organization the caller may not see is 404.',
  request: { params: OrgSlugParam, query: PaginationQuery },
  responses: {
    200: { description: 'A page of teams', content: { 'application/json': { schema: TeamPage } } },
    401: NOT_SIGNED_IN,
    404: ORG_NOT_FOUND,
  },
});

registry.registerPath({
  method: 'get',
  path: '/orgs/{slug}/teams/{teamSlug}',
  tags: ['Organizations'],
  summary: 'One team and its members',
  description:
    'An owner or admin of the organization, a global admin, or a member of the team itself. ' +
    'Anybody else gets the same 404 a team that does not exist gets: a school’s squad list is ' +
    'not something a rival school reads off the API before the round.',
  request: { params: TeamParam },
  responses: {
    200: { description: 'The team', content: { 'application/json': { schema: TeamDetail } } },
    401: NOT_SIGNED_IN,
    404: TEAM_NOT_FOUND,
  },
});

registry.registerPath({
  method: 'post',
  path: '/orgs/{slug}/teams',
  tags: ['Organizations'],
  summary: 'Assemble a team (owner or admin)',
  description:
    'Members are named by username and must already be on this organization’s roster. The size ' +
    `ceiling here is ${String(TEAM_MAX_MEMBERS)}, the table’s own; what a CONTEST admits is its ` +
    'own `maxTeamSize` (three by default), checked at `POST /contests/{key}/join` so that one ' +
    'squad can enter two contests with different limits.',
  request: {
    params: OrgSlugParam,
    body: { content: { 'application/json': { schema: CreateTeamRequest } } },
  },
  responses: {
    201: { description: 'The created team', content: { 'application/json': { schema: TeamDetail } } },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: ORG_NOT_FOUND,
    409: TEAM_SLUG_TAKEN,
    422: TEAM_VALIDATION_FAILED,
  },
});

registry.registerPath({
  method: 'patch',
  path: '/orgs/{slug}/teams/{teamSlug}',
  tags: ['Organizations'],
  summary: 'Rename a team or replace its roster (owner or admin)',
  description:
    '`members`, when present, replaces the whole roster. A **rename** is refused (409 ' +
    '`contest_team_name_taken`) when it would put two same-named teams on one scoreboard: the ' +
    'board’s `teams` sidecar is keyed by the name, so a collision makes the disqualify control ' +
    'act on the wrong team and the results sheet print the wrong roster (D99).',
  request: {
    params: TeamParam,
    body: { content: { 'application/json': { schema: UpdateTeamRequest } } },
  },
  responses: {
    200: { description: 'The updated team', content: { 'application/json': { schema: TeamDetail } } },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: TEAM_NOT_FOUND,
    409: {
      description:
        'This organization already has a team with that slug (`team_slug_taken`), the new ' +
        'name is already competing on a board this team is on (`contest_team_name_taken`), or ' +
        'the request carried an `expectedVersion` that is no longer current \u2014 somebody else ' +
        'saved this team after this client read it, and NOTHING was written ' +
        '(`team_version_conflict`, D161/D176)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: TEAM_VALIDATION_FAILED,
  },
});

registry.registerPath({
  method: 'delete',
  path: '/orgs/{slug}/teams/{teamSlug}',
  tags: ['Organizations'],
  summary: 'Disband a team (owner or admin)',
  description:
    'A team that has entered a contest cannot be deleted (409 `team_has_participations`): its ' +
    'participation IS the record of what it did, and dropping the row would delete a contest’s ' +
    'results. Disbanding it is emptying its roster, which this route still allows.',
  request: { params: TeamParam },
  responses: {
    204: { description: 'Deleted' },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: TEAM_NOT_FOUND,
    409: {
      description: 'The team has competed (`team_has_participations`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

/* ────────────────────────────────────────────────────────────────────────────
 * "My teams", and whether they may enter a contest — D99 as amended by F-25.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Why a team of mine cannot enter the contest I named.
 *
 * The SAME codes `POST /contests/{key}/join` refuses with, deliberately: this
 * route exists so a picker can grey out a choice before the click, and a
 * screen that explained the refusal in words the server would not use is a
 * screen that disagrees with the server the first time either changes.
 * `contest_team_org_not_named` is the one code join never answers, because
 * join resolves the slug inside the contest's schools and simply does not
 * find a team outside them.
 */
export const TeamIneligibleReason = z.enum([
  'contest_not_team_mode',
  'contest_team_org_not_named',
  'contest_team_too_large',
  'contest_team_joined',
  'contest_already_joined',
  'contest_team_name_taken',
]);
export type TeamIneligibleReasonDto = z.infer<typeof TeamIneligibleReason>;

/**
 * A team of mine, with whatever the `?contest=` I asked about implies.
 *
 * `eligible` and `ineligibleReason` are BOTH `null` when no contest was
 * named. Not `true`: "may this team enter" has no answer without a contest,
 * and answering `true` would make a picker that forgot the query parameter
 * look like it worked.
 */
export const MyTeamSummary = TeamSummary.extend({
  eligible: z.boolean().nullable(),
  ineligibleReason: TeamIneligibleReason.nullable(),
});
export type MyTeamSummaryDto = z.infer<typeof MyTeamSummary>;

/**
 * Every team I am on, across every school — not a page.
 *
 * A cursor would be ceremony: a person is on a handful of teams, the ceiling
 * is `MY_TEAMS_LIMIT`, and a picker that had to page would be a picker with a
 * bug nobody ever reproduces. If somebody is ever on more than that, the list
 * is truncated rather than paged, and `truncated` says so.
 */
export const MyTeamList = z.object({
  items: z.array(MyTeamSummary),
  truncated: z.boolean(),
});
export type MyTeamListDto = z.infer<typeof MyTeamList>;

/** The ceiling on one person's team list. */
export const MY_TEAMS_LIMIT = 200;

export const MyTeamsQuery = z.object({
  /**
   * A contest key. Every team in the answer is then annotated with whether it
   * may enter THAT contest and, if not, with the code the join would refuse
   * with. A key naming no contest the caller may see is 404 — the same answer
   * reading the contest itself would give.
   */
  contest: z.string().max(64).optional(),
});
export type MyTeamsQueryDto = z.infer<typeof MyTeamsQuery>;

registry.registerPath({
  method: 'get',
  path: '/users/me/teams',
  tags: ['Users'],
  summary: 'Every team I am on, across every school',
  description:
    'One request, however many organizations the caller belongs to. It exists because the join ' +
    'picker used to issue `GET /orgs/{slug}/teams` once per organization a contest named — fine ' +
    'at two schools, not at twenty. With `?contest=`, each team also carries whether it may ' +
    'enter that contest and, if not, the code `POST /contests/{key}/join` would refuse with, so ' +
    'the picker greys a choice out with the server’s own reason rather than a guess. ' +
    '`orgs:read`, not `users:read`: what comes back is a school’s rosters, and a token holding ' +
    'only the profile scope must not reach them through a route named after the caller.',
  request: { query: MyTeamsQuery },
  responses: {
    200: { description: 'My teams', content: { 'application/json': { schema: MyTeamList } } },
    401: NOT_SIGNED_IN,
    404: {
      description: 'The `?contest=` names no contest this caller may see',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});
