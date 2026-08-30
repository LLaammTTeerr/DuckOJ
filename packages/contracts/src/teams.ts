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
});
export type TeamSummaryDto = z.infer<typeof TeamSummary>;

export const TeamPage = cursorPage(TeamSummary);
export type TeamPageDto = z.infer<typeof TeamPage>;

export const TeamDetail = TeamSummary.extend({
  members: z.array(TeamMember),
  /**
   * Whether THIS caller may edit the team — an owner or admin of the
   * organization, or a global admin. Served rather than derived, exactly as
   * `ContestDetail.canEdit` is and for its reason: the alternative is a
   * client assembling the answer from two other requests and getting it
   * subtly different from the server's own check.
   */
  canEdit: z.boolean(),
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
  description: '`members`, when present, replaces the whole roster.',
  request: {
    params: TeamParam,
    body: { content: { 'application/json': { schema: UpdateTeamRequest } } },
  },
  responses: {
    200: { description: 'The updated team', content: { 'application/json': { schema: TeamDetail } } },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: TEAM_NOT_FOUND,
    409: TEAM_SLUG_TAKEN,
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
