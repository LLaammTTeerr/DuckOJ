import { z } from 'zod';
import { ProblemDetails, Timestamp, cursorPage } from './common.js';
import { registry } from './registry.js';

export const ORG_SLUG = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export const OrgVisibility = z.enum(['public', 'private']);
export type OrgVisibilityDto = z.infer<typeof OrgVisibility>;

export const OrgJoinPolicy = z.enum(['open', 'request', 'invite']);
export type OrgJoinPolicyDto = z.infer<typeof OrgJoinPolicy>;

export const OrgRole = z.enum(['owner', 'admin', 'member']);
export type OrgRoleDto = z.infer<typeof OrgRole>;

export const OrgSummary = z.object({
  id: z.number().int(),
  slug: z.string(),
  name: z.string(),
  about: z.string().nullable(),
  visibility: OrgVisibility,
  joinPolicy: OrgJoinPolicy,
  createdAt: Timestamp,
});
export type OrgSummaryDto = z.infer<typeof OrgSummary>;

export const OrgPage = cursorPage(OrgSummary);
export type OrgPageDto = z.infer<typeof OrgPage>;

export const CreateOrgRequest = z.object({
  slug: z.string().regex(ORG_SLUG),
  name: z.string().min(1).max(200),
  about: z.string().max(4096).optional(),
  visibility: OrgVisibility.default('private'),
  joinPolicy: OrgJoinPolicy.default('request'),
});
export type CreateOrgRequestDto = z.infer<typeof CreateOrgRequest>;

/**
 * `slug` is deliberately patchable, unlike `UpdateProblemRequest`'s `code`:
 * nothing in the schema references an organization by slug — `problem_orgs`,
 * `org_members` and `org_join_requests` all key on `organizations.id` — so a
 * rename corrupts no relationship, only a stale bookmark, which 404s
 * (honestly) rather than resolving to the wrong thing. A problem's code is a
 * permanent public citation (it appears in exported records and editorials);
 * an organization's slug is closer to a display handle that legitimately
 * changes on a rebrand or a typo fix. `.strict()` still guards against a
 * stray unrecognized key the same way `UpdateProblemRequest` does.
 */
export const UpdateOrgRequest = z
  .object({
    slug: z.string().regex(ORG_SLUG).optional(),
    name: z.string().min(1).max(200).optional(),
    about: z.string().max(4096).nullable().optional(),
    visibility: OrgVisibility.optional(),
    joinPolicy: OrgJoinPolicy.optional(),
  })
  .strict();
export type UpdateOrgRequestDto = z.infer<typeof UpdateOrgRequest>;

/**
 * `members` is visible to any caller who can see the organization at all —
 * no narrower a gate than `GET /orgs/{slug}` itself. A private organization
 * already 404s for everyone but a member or an admin (spec item 5), so by
 * the time this list is reachable at all, the caller is either looking at a
 * public organization's roster (arguably public information, same reasoning
 * `ProblemDetail.members` uses — credit, not a secret) or is themselves
 * already inside the private one. No separate "must be a member" check is
 * layered on top.
 */
export const OrgMember = z.object({
  username: z.string(),
  role: OrgRole,
  joinedAt: Timestamp,
});
export type OrgMemberDto = z.infer<typeof OrgMember>;

export const OrgMemberList = z.array(OrgMember);
export type OrgMemberListDto = z.infer<typeof OrgMemberList>;

/** A pending request to join, as an owner or admin sees it. */
export const OrgJoinRequest = z.object({
  id: z.number().int(),
  username: z.string(),
  createdAt: Timestamp,
});
export type OrgJoinRequestDto = z.infer<typeof OrgJoinRequest>;

export const OrgJoinRequestList = z.array(OrgJoinRequest);
export type OrgJoinRequestListDto = z.infer<typeof OrgJoinRequestList>;

/**
 * What `POST /orgs/:slug/join` did.
 *
 * `joined` under an open policy, `requested` under a request policy — carried
 * in the body as well as in the status code, so a client that does not branch
 * on 201-vs-202 still cannot mistake one for the other.
 */
export const OrgJoinResult = z.object({
  outcome: z.enum(['joined', 'requested']),
  role: OrgRole.nullable(),
});
export type OrgJoinResultDto = z.infer<typeof OrgJoinResult>;

export const AddOrgMemberRequest = z
  .object({
    username: z.string().min(1).max(64),
    /** Defaults to `member`; only an owner may pass `owner` or `admin`. */
    role: OrgRole.default('member'),
  })
  .strict();
export type AddOrgMemberRequestDto = z.infer<typeof AddOrgMemberRequest>;

export const SetOrgMemberRoleRequest = z.object({ role: OrgRole }).strict();
export type SetOrgMemberRoleRequestDto = z.infer<typeof SetOrgMemberRoleRequest>;

registry.registerPath({
  method: 'get',
  path: '/orgs',
  summary: 'Organizations visible to the caller',
  responses: {
    200: { description: 'A page of organizations', content: { 'application/json': { schema: OrgPage } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/orgs/{slug}',
  summary: 'A single organization visible to the caller',
  request: { params: z.object({ slug: z.string() }) },
  responses: {
    200: { description: 'The organization', content: { 'application/json': { schema: OrgSummary } } },
    404: {
      description: 'No such organization, or one the caller may not see — the two are indistinguishable',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

const OrgSlugParam = z.object({ slug: z.string() });

const NOT_SIGNED_IN = {
  description: 'Not signed in',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const FORBIDDEN = {
  description: 'Signed in, but not permitted to perform this action on this organization',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const ORG_NOT_FOUND = {
  description: 'No such organization, or one the caller may not see — the two are indistinguishable',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const VALIDATION_FAILED = {
  description: 'The request failed validation',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const SLUG_TAKEN = {
  description: 'That organization slug is already taken',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};

registry.registerPath({
  method: 'post',
  path: '/orgs',
  summary: 'Create an organization (global admin only)',
  request: { body: { content: { 'application/json': { schema: CreateOrgRequest } } } },
  responses: {
    201: { description: 'The created organization', content: { 'application/json': { schema: OrgSummary } } },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    409: SLUG_TAKEN,
    422: VALIDATION_FAILED,
  },
});

registry.registerPath({
  method: 'patch',
  path: '/orgs/{slug}',
  summary: "Update an organization's slug, name, about, visibility or join policy",
  request: {
    params: OrgSlugParam,
    body: { content: { 'application/json': { schema: UpdateOrgRequest } } },
  },
  responses: {
    200: { description: 'The updated organization', content: { 'application/json': { schema: OrgSummary } } },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: ORG_NOT_FOUND,
    409: SLUG_TAKEN,
    422: VALIDATION_FAILED,
  },
});

registry.registerPath({
  method: 'get',
  path: '/orgs/{slug}/members',
  summary: 'The members of an organization visible to the caller',
  request: { params: OrgSlugParam },
  responses: {
    200: { description: 'Every member, sorted by username', content: { 'application/json': { schema: OrgMemberList } } },
    404: ORG_NOT_FOUND,
  },
});

registry.registerPath({
  method: 'post',
  path: '/orgs/{slug}/join',
  summary: 'Join an organization, or request to',
  responses: {
    201: {
      description: 'Joined — the organization is open',
      content: { 'application/json': { schema: OrgJoinResult } },
    },
    202: {
      description: 'Requested — an owner or admin must approve',
      content: { 'application/json': { schema: OrgJoinResult } },
    },
    401: NOT_SIGNED_IN,
    403: {
      description: 'This organization admits members by invitation only (`org_invite_only`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    404: ORG_NOT_FOUND,
    409: {
      description: 'Already a member',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/orgs/{slug}/requests',
  summary: 'Pending join requests (owner or admin)',
  responses: {
    200: {
      description: 'The pending requests, oldest first',
      content: { 'application/json': { schema: OrgJoinRequestList } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: ORG_NOT_FOUND,
  },
});

for (const decision of ['approve', 'reject'] as const) {
  registry.registerPath({
    method: 'post',
    path: `/orgs/{slug}/requests/{id}/${decision}`,
    summary: `${decision === 'approve' ? 'Approve' : 'Reject'} a pending join request`,
    responses: {
      200: { description: 'Decided', content: { 'application/json': { schema: OrgMemberList } } },
      401: NOT_SIGNED_IN,
      403: FORBIDDEN,
      404: ORG_NOT_FOUND,
      409: {
        description: 'That request has already been decided',
        content: { 'application/problem+json': { schema: ProblemDetails } },
      },
    },
  });
}

registry.registerPath({
  method: 'post',
  path: '/orgs/{slug}/members',
  summary: 'Add a member directly (owner or admin)',
  request: { body: { content: { 'application/json': { schema: AddOrgMemberRequest } } } },
  responses: {
    201: { description: 'The updated roster', content: { 'application/json': { schema: OrgMemberList } } },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: ORG_NOT_FOUND,
    409: { description: 'Already a member', content: { 'application/problem+json': { schema: ProblemDetails } } },
    422: VALIDATION_FAILED,
  },
});

registry.registerPath({
  method: 'delete',
  path: '/orgs/{slug}/members/{username}',
  summary: 'Remove a member, or leave by naming yourself',
  responses: {
    200: { description: 'The updated roster', content: { 'application/json': { schema: OrgMemberList } } },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: ORG_NOT_FOUND,
    409: {
      description: 'That would leave the organization with no owner (`org_last_owner`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/orgs/{slug}/members/{username}',
  summary: "Set a member's role (owner only)",
  request: { body: { content: { 'application/json': { schema: SetOrgMemberRoleRequest } } } },
  responses: {
    200: { description: 'The updated roster', content: { 'application/json': { schema: OrgMemberList } } },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: ORG_NOT_FOUND,
    409: {
      description: 'That would leave the organization with no owner (`org_last_owner`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: VALIDATION_FAILED,
  },
});
