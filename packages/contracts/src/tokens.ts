import { z } from 'zod';
import { ProblemDetails, Timestamp } from './common.js';
import { registry } from './registry.js';
import { SCOPES } from './scopes.js';

export const CreateTokenRequest = z.object({
  name: z.string().min(1).max(64),
  scopes: z.array(z.enum(SCOPES)).default([]),
  expiresAt: Timestamp.optional(),
});
export type CreateTokenRequestDto = z.infer<typeof CreateTokenRequest>;

export const CreateTokenResponse = z.object({
  id: z.number().int(),
  /** Returned exactly once, at creation. */
  token: z.string(),
});
export type CreateTokenResponseDto = z.infer<typeof CreateTokenResponse>;

export const TokenSummary = z.object({
  id: z.number().int(),
  name: z.string(),
  // Deliberately `string[]`, not `z.enum(SCOPES)`: this is a read-back of
  // whatever is stored in the `access_tokens.scopes` `text[]` column, which
  // is untyped at the DB layer. A token minted before `SCOPES` gained (or
  // lost) an entry would hold a value the enum rejects, and `TokenSummary`
  // is an output boundary — throwing while listing a caller's own tokens
  // would be strictly worse than showing them the stale value. `CreateTokenRequest`
  // is the input boundary and stays strict.
  scopes: z.array(z.string()),
  lastUsedAt: Timestamp.nullable(),
  expiresAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type TokenSummaryDto = z.infer<typeof TokenSummary>;

// Deliberately not `.coerce`: zod v4 + zod-to-openapi v9 document a coerced
// number schema as `{"type": ["integer","null"], "required": false}`, which
// OpenAPI 3.1 forbids for an `in: "path"` parameter (path parameters must be
// `required: true`, and a nullable id is meaningless anyway) — see
// `submissions.ts`'s `SubmissionIdParamSchema` for the same fix. This schema
// documents the shape; the runtime pipe is `RevokeTokenIdParam` below.
const TokenIdParam = z.object({ id: z.number().int() });

// The runtime pipe for `DELETE /auth/tokens/:id`. Nest hands `@Param('id')` a
// raw route-segment string, so this coerces and validates it. `.int()` is
// `Number.isSafeInteger` in zod v4, which bounds the value to the range a
// `bigint` column accepts — without that bound Nest's own `ParseIntPipe`
// accepted `1e20` (from an id like `99999999999999999999`), bound it against
// the `access_tokens.id` column, and Postgres answered `22003
// numeric_value_out_of_range`, which surfaced as a `500 internal_error`
// rather than the `422` a client can act on.
export const RevokeTokenIdParam = z.coerce.number().pipe(z.number().int().positive());
export type RevokeTokenIdParamDto = z.infer<typeof RevokeTokenIdParam>;

// Every route on this controller requires an interactive session — see
// `TokensController`'s class-level `@UseGuards(SessionOnlyGuard)` — because
// personal access tokens must not be able to mint or revoke their own
// replacements.
const NOT_SIGNED_IN = {
  description: 'Not signed in',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const SESSION_REQUIRED = {
  description:
    'Signed in, but authenticated by an access token rather than an interactive session ' +
    '(`session_required`) — credential management is session-only',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};

registry.registerPath({
  method: 'post',
  path: '/auth/tokens',
  tags: ['API tokens'],
  summary: 'Mint a personal access token',
  request: { body: { content: { 'application/json': { schema: CreateTokenRequest } } } },
  responses: {
    201: {
      description: 'The token was minted; `token` is returned exactly once',
      content: { 'application/json': { schema: CreateTokenResponse } },
    },
    401: NOT_SIGNED_IN,
    403: SESSION_REQUIRED,
    409: {
      description:
        'The account still carries `mustChangePassword` (`password_change_required`, D102). An ' +
        'imported account holds a password it never chose, printed on a sheet handed round a ' +
        'classroom; a token minted before that password is replaced would outlive the replacement. ' +
        'Change the password first (`POST /auth/password/change`) — the same refusal is returned to ' +
        'any request that authenticates with an already-minted token.',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: {
      description: 'The request body failed validation',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/auth/tokens',
  tags: ['API tokens'],
  summary: "The caller's personal access tokens",
  responses: {
    200: {
      description: 'The tokens, never including the secret itself',
      content: { 'application/json': { schema: z.array(TokenSummary) } },
    },
    401: NOT_SIGNED_IN,
    403: SESSION_REQUIRED,
  },
});

registry.registerPath({
  method: 'delete',
  path: '/auth/tokens/{id}',
  tags: ['API tokens'],
  summary: 'Revoke a personal access token',
  description: 'Idempotent: revoking a token that does not exist, or belongs to someone else, still answers 204.',
  request: { params: TokenIdParam },
  responses: {
    204: { description: 'Revoked (or already gone)' },
    401: NOT_SIGNED_IN,
    403: SESSION_REQUIRED,
  },
});
