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
