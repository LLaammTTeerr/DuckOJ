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
// `submissions.ts`'s `SubmissionIdParamSchema` for the same fix. The runtime
// route still uses Nest's own `ParseIntPipe`, which is untouched by this;
// this schema exists purely to document the shape.
const TokenIdParam = z.object({ id: z.number().int() });

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
  summary: 'Mint a personal access token',
  request: { body: { content: { 'application/json': { schema: CreateTokenRequest } } } },
  responses: {
    201: {
      description: 'The token was minted; `token` is returned exactly once',
      content: { 'application/json': { schema: CreateTokenResponse } },
    },
    401: NOT_SIGNED_IN,
    403: SESSION_REQUIRED,
    422: {
      description: 'The request body failed validation',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/auth/tokens',
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
  summary: 'Revoke a personal access token',
  description: 'Idempotent: revoking a token that does not exist, or belongs to someone else, still answers 204.',
  request: { params: TokenIdParam },
  responses: {
    204: { description: 'Revoked (or already gone)' },
    401: NOT_SIGNED_IN,
    403: SESSION_REQUIRED,
  },
});
