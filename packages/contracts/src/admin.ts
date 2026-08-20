import { z } from 'zod';
import { ProblemDetails } from './common.js';
import { registry } from './registry.js';

/**
 * Deliberately a bare `z.string().min(1)`, not `z.enum([...])`: an invalid
 * value here is a *domain* rule enforced by `AdminUsersService` (which checks
 * membership against the real `global_role` enum and answers 400
 * `admin_role_invalid`), not a malformed request shape. A `z.enum` here would
 * make `ZodValidationPipe` intercept it first and answer the pipe's generic
 * 422 `validation_failed` instead of the specific code this route documents.
 */
export const AdminGrantRoleRequest = z.object({ globalRole: z.string().min(1) });
export type AdminGrantRoleRequestDto = z.infer<typeof AdminGrantRoleRequest>;

export const AdminUserSummary = z.object({
  id: z.number().int(),
  username: z.string(),
  globalRole: z.enum(['user', 'setter', 'admin']),
});
export type AdminUserSummaryDto = z.infer<typeof AdminUserSummary>;

const UsernameParam = z.object({ username: z.string() });

const NOT_SIGNED_IN = {
  description: 'Not signed in',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const FORBIDDEN = {
  description: 'Signed in, but not an admin',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};

registry.registerPath({
  method: 'patch',
  path: '/admin/users/{username}',
  summary: "Grant a user's global role — admin only",
  request: {
    params: UsernameParam,
    body: { content: { 'application/json': { schema: AdminGrantRoleRequest } } },
  },
  responses: {
    200: {
      description: 'The role was granted',
      content: { 'application/json': { schema: AdminUserSummary } },
    },
    400: {
      description: '`globalRole` is not one of `user`, `setter`, `admin`',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: {
      description: 'No such user',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});
