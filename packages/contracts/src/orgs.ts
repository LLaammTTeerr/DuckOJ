import { z } from 'zod';
import { PaginationQuery, ProblemDetails, Timestamp, cursorPage } from './common.js';
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
  /**
   * THIS caller's role in this organization, or `null` for a non-member and
   * for an anonymous reader.
   *
   * Served rather than derived, for the reason `ContestDetail.canEdit`
   * documents: the alternative is a client that fetches `/orgs/{slug}/members`
   * for every row of a list and searches it for its own username, which is one
   * request per organization to answer a question the server already knows.
   * The contest forms need it — only an owner or an admin may restrict a
   * contest to an organization (D56) — and the list can only offer the right
   * organizations if it is told which they are.
   *
   * A global admin is still `null` where they hold no membership: this is a
   * membership fact, not a permission. What a global admin may do is decided
   * by `globalRole`, which the caller already has from `GET /auth/me`.
   */
  myRole: OrgRole.nullable(),
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
  /**
   * The person's own name, added by D185 with the roster's search box.
   *
   * A roster that serves only usernames is a roster a teacher cannot read: a
   * school whose accounts were minted by a bulk import (D61) is a page of
   * `hs000123`, and a search that matches `Nguyễn Văn An` by name could not
   * show the name it had matched. It is also what D122's deterministic
   * initials are computed from, so a person picker can show a face.
   *
   * Discloses nothing new — `GET /users/{username}` already serves
   * `displayName` publicly for every account, one request per row.
   */
  displayName: z.string(),
  role: OrgRole,
  joinedAt: Timestamp,
});
export type OrgMemberDto = z.infer<typeof OrgMember>;

/**
 * The roster's page, plus "find this person" (D185).
 *
 * `q` matches a WORD of the username or the display name with Vietnamese
 * diacritics folded on both sides, so a teacher types `nguyen` (or `an`, the
 * given name a pupil is actually called by) and finds `Nguyễn Văn An`. The
 * rule is `nameSearchWhere` in the API and it is shared, byte for byte, with
 * `GET /users?q=`.
 *
 * **It is a parameter on THIS route rather than an `org=` filter on
 * `GET /users`, and that is an authorization decision, not a convenience.**
 * `GET /users` is `@Public()`. Teaching it to filter by organization would
 * publish "who belongs to this school" — including a PRIVATE school's roster
 * — through a route with no organization gate on it at all. This route
 * already runs `findVisibleOrgRow`, the same 404 gate `GET /orgs/{slug}`
 * uses, so the search inherits exactly the visibility the roster already had.
 */
export const OrgMemberListQuery = PaginationQuery.extend({
  q: z.string().min(1).max(64).optional(),
});
export type OrgMemberListQueryDto = z.infer<typeof OrgMemberListQuery>;

/**
 * A **page** of members, never the whole roster (D58).
 *
 * An organization is a province's school or club: `orgMembers` has no bound
 * at all, and the unpaginated array this used to be would happily serialise
 * every row of the largest one into a single response — the shape every
 * sibling list (`/problems`, `/contests`, `/orgs`, `/submissions`, `/users`)
 * abandoned long ago. The cursor is the last username on the page, which is
 * exactly the column the roster is ordered by, so it is stable under
 * concurrent joins and departures.
 *
 * The four *write* endpoints that answer with the roster (add, remove, set
 * role, decide a join request) return the FIRST page of it, with its own
 * `nextCursor`. Their body is a convenience refresh, not the roster of
 * record — the client that needs the rest pages `GET .../members` like
 * anybody else — and answering a bounded page there is what keeps a write
 * to a 5,000-member organization from costing 5,000 rows on every click.
 */
export const OrgMemberPage = cursorPage(OrgMember);
export type OrgMemberPageDto = z.infer<typeof OrgMemberPage>;

/** A pending request to join, as an owner or admin sees it. */
export const OrgJoinRequest = z.object({
  id: z.number().int(),
  username: z.string(),
  createdAt: Timestamp,
});
export type OrgJoinRequestDto = z.infer<typeof OrgJoinRequest>;

/**
 * **A page, not the array it used to be (D181).**
 *
 * `GET /orgs/{slug}/requests` was the only list in this API with no bound at
 * all: no `limit`, no cursor, no query parameters. It returned every pending
 * request a school held, and the web panel rendered every one of them into
 * one `<table>`. A school that opens enrolment to a province — which the
 * org-import contract already sizes a roster at — makes that a 219 kB
 * response and five thousand `<tr>` on the page a teacher opens to approve
 * three people. The statement itself is healthy and no index helps; the
 * missing thing was the bound.
 *
 * **The FIFO order is kept.** A queue is worked oldest first, and that is the
 * decider's own order — D177's argument for newest-first is about a list
 * someone TAILS and does not transfer here. So the cursor is `asc(id)`, the
 * same grammar and the same helper the roster beside it uses.
 */
export const OrgJoinRequestPage = cursorPage(OrgJoinRequest);
export type OrgJoinRequestPageDto = z.infer<typeof OrgJoinRequestPage>;

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

/**
 * The largest roster one import may carry (D61, amended by the F13 owed
 * sweep). Declared here as well as in the API so a client can refuse — or,
 * better, SPLIT — a file before uploading it.
 *
 * Five hundred, not two thousand: every row costs one argon2id hash at the
 * parameters every other account is held to, so two thousand of them held a
 * request open for twenty-odd seconds, and the F8 report's own concern was
 * that a proxy or browser timeout there strands accounts that were created
 * with passwords nobody ever received. Five hundred keeps a request under
 * about six seconds; a larger roster is several requests, which the web
 * panel makes for the teacher rather than asking them to cut up a file.
 */
export const ORG_IMPORT_MAX_ROWS = 500;

/** One roster row. `email` is optional — most pupils have no school mailbox. */
export const OrgMemberImportRow = z.object({
  username: z.string(),
  displayName: z.string(),
  email: z.string().optional(),
});
export type OrgMemberImportRowDto = z.infer<typeof OrgMemberImportRow>;

/**
 * A roster, as either a CSV blob or a parsed list — exactly one of the two.
 *
 * Both shapes rather than one because both callers are real: a teacher drops
 * the file their office suite exported (`csv`, parsed by the server so the
 * browser and the CLI cannot disagree about what a quoted field means), and a
 * script that already holds structured data sends `rows`. Sending neither, or
 * both, is `import_body_invalid`.
 *
 * `dryRun` validates and reports and creates nothing. It is what the web's
 * preview table is built from, and it deliberately does NOT consume the
 * one-import-per-minute window: the normal flow is a teacher fixing one bad
 * row and trying again, and a meter that punished that would make the preview
 * useless.
 */
export const OrgMemberImportRequest = z
  .object({
    csv: z.string().max(4_000_000).optional(),
    rows: z.array(OrgMemberImportRow).optional(),
    dryRun: z.boolean().default(false),
  })
  .strict();
export type OrgMemberImportRequestDto = z.infer<typeof OrgMemberImportRequest>;

/** What a `dryRun` answers with: the rows as the server understood them. */
export const OrgMemberImportPreview = z.object({
  rows: z.array(
    z.object({
      username: z.string(),
      displayName: z.string(),
      email: z.string(),
      /** False when the server synthesised the address (no mailbox was given). */
      emailProvided: z.boolean(),
    }),
  ),
});
export type OrgMemberImportPreviewDto = z.infer<typeof OrgMemberImportPreview>;

/**
 * The credentials, handed over ONCE.
 *
 * `password` is the only time the plaintext exists anywhere outside the
 * caller's response body — it is argon2id-hashed on the way into the
 * database and nothing can recover it afterwards, which is why the `csv`
 * field is served beside the array rather than left to the client to build:
 * a printed sheet that disagrees with the archived file is the one failure
 * nobody can debug later.
 */
export const OrgMemberImportResult = z.object({
  created: z.array(
    z.object({ username: z.string(), displayName: z.string(), password: z.string() }),
  ),
  csv: z.string(),
});
export type OrgMemberImportResultDto = z.infer<typeof OrgMemberImportResult>;

registry.registerPath({
  method: 'get',
  path: '/orgs',
  tags: ['Organizations'],
  summary: 'Organizations visible to the caller, in alphabetical order',
  description:
    'Ordered by slug, which is the order a province looks a school up in (D186). The cursor is ' +
    '`<slug>_<id>`, a keyset over the same pair; a cursor from the previous id-ordered grammar ' +
    'has no `_` and is refused `422 invalid_cursor` rather than silently walking a different list.',
  // The controller has validated `PaginationQuery` here since Phase 3e and
  // this document never said so, which made `?limit=` invisible to the SDK
  // and therefore untypeable by the contest forms that need a whole page of
  // organizations at once.
  request: { query: PaginationQuery },
  responses: {
    200: { description: 'A page of organizations, alphabetical by slug', content: { 'application/json': { schema: OrgPage } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/orgs/{slug}',
  tags: ['Organizations'],
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
const OrgMemberParam = z.object({ slug: z.string(), username: z.string() });

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
  tags: ['Organizations'],
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
  tags: ['Organizations'],
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
  tags: ['Organizations'],
  summary: 'The members of an organization visible to the caller',
  description:
    'A page, ordered by username. `q` finds a person by a word of their username or display ' +
    'name with Vietnamese diacritics folded on both sides — `nguyen` finds `Nguyễn`, and `an` ' +
    'finds `Nguyễn Văn An` by the given name a teacher calls them (D185).',
  request: { params: OrgSlugParam, query: OrgMemberListQuery },
  responses: {
    200: { description: 'A page of members, sorted by username', content: { 'application/json': { schema: OrgMemberPage } } },
    404: ORG_NOT_FOUND,
  },
});

registry.registerPath({
  method: 'post',
  path: '/orgs/{slug}/join',
  tags: ['Organizations'],
  request: { params: OrgSlugParam },
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
  tags: ['Organizations'],
  request: { params: OrgSlugParam, query: PaginationQuery },
  summary: 'Pending join requests (owner or admin)',
  description:
    'A page, oldest first — a queue is worked from its front. This used to answer the WHOLE queue ' +
    'in one array with no limit and no cursor, which is a 219 kB response for a school that has ' +
    'opened enrolment to a province (D181).',
  responses: {
    200: {
      description: 'A page of pending requests, oldest first',
      content: { 'application/json': { schema: OrgJoinRequestPage } },
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
    tags: ['Organizations'],
    request: { params: z.object({ slug: z.string(), id: z.number().int() }) },
    summary: `${decision === 'approve' ? 'Approve' : 'Reject'} a pending join request`,
    responses: {
      200: { description: 'Decided', content: { 'application/json': { schema: OrgMemberPage } } },
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
  tags: ['Organizations'],
  summary: 'Add a member directly (owner or admin)',
  request: {
    params: OrgSlugParam,
    body: { content: { 'application/json': { schema: AddOrgMemberRequest } } },
  },
  responses: {
    201: { description: 'The updated roster', content: { 'application/json': { schema: OrgMemberPage } } },
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
  tags: ['Organizations'],
  summary: 'Remove a member, or leave by naming yourself',
  request: { params: OrgMemberParam },
  responses: {
    200: { description: 'The updated roster', content: { 'application/json': { schema: OrgMemberPage } } },
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
  tags: ['Organizations'],
  summary: "Set a member's role (owner only)",
  request: {
    params: OrgMemberParam,
    body: { content: { 'application/json': { schema: SetOrgMemberRoleRequest } } },
  },
  responses: {
    200: { description: 'The updated roster', content: { 'application/json': { schema: OrgMemberPage } } },
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

registry.registerPath({
  method: 'post',
  path: '/orgs/{slug}/members/import',
  tags: ['Organizations'],
  summary: 'Create accounts in bulk from a roster and add them as members (owner or global admin)',
  description:
    'D61 — a province seats thousands of pupils who will never self-register. Every row is validated ' +
    'FIRST (username shape per D8, uniqueness case-folded against the database and against the rest ' +
    'of the file, addresses likewise); if anything fails, nothing is created and the 422 lists every ' +
    'bad row. Otherwise each account is created with a generated twelve-character password, flagged ' +
    '`mustChangePassword`, and added to the organization as a `member`. The plaintext passwords are ' +
    'in the response and NOWHERE else — there is no second chance to read them. Only an OWNER of the ' +
    'organization or a global admin may call it (an org `admin` may not: minting accounts on a ' +
    "province's judge is speaking for the school, which the rank below owner does not). Session-only, " +
    'and metered at one real import per organization per minute; `dryRun` is exempt from the meter.',
  request: {
    params: OrgSlugParam,
    body: { content: { 'application/json': { schema: OrgMemberImportRequest } } },
  },
  responses: {
    200: {
      description: 'A `dryRun` that validated cleanly — nothing was created',
      content: { 'application/json': { schema: OrgMemberImportPreview } },
    },
    201: {
      description: 'The accounts were created; the passwords are here and are not stored anywhere',
      content: { 'application/json': { schema: OrgMemberImportResult } },
    },
    401: NOT_SIGNED_IN,
    403: {
      description:
        'Not an owner of this organization and not a global admin (`organization_forbidden`), or ' +
        'authenticated by an access token rather than a session (`session_required`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    404: ORG_NOT_FOUND,
    422: {
      description:
        'One or more rows are unacceptable (`member_import_invalid`) and NOTHING was created. Every ' +
        'failure is listed in `fields`, keyed `rows[<n>].<field>` with `n` the 1-based data row — so ' +
        'a client can put each message beside the row that caused it. `rows[0].file` is a problem ' +
        'with the file as a whole (empty, or over ' +
        `${String(ORG_IMPORT_MAX_ROWS)}` +
        ' rows — split the file and send it as several requests, which is what the web panel does). ' +
        '`import_body_invalid` means neither or both of `csv` and `rows` were sent.',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    429: {
      description:
        'Ten imports have run for this organization within the last minute ' +
        '(`member_import_rate_limited`) — enough for a five-thousand-pupil roster in 500-row chunks, ' +
        'and the same rows-per-minute the old single 2,000-row call could do. `Retry-After` carries ' +
        'the whole seconds until another will be accepted.',
      headers: {
        'Retry-After': {
          description: 'Whole seconds until another import will be accepted',
          required: true,
          schema: { type: 'integer' },
        },
      },
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});
