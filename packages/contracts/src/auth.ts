import { z } from 'zod';
import { ProblemDetails, Timestamp } from './common.js';
import { registry } from './registry.js';

export const Username = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[A-Za-z0-9_.-]+$/, 'may contain letters, digits, dot, underscore and hyphen only');

export const Password = z.string().min(10).max(256);

export const RegisterRequest = z.object({
  username: Username,
  email: z.string().email(),
  password: Password,
  displayName: z.string().min(1).max(64),
});
export type RegisterRequestDto = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.object({
  usernameOrEmail: z.string().min(1),
  password: z.string().min(1),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
});
export type LoginRequestDto = z.infer<typeof LoginRequest>;

export const MeResponse = z.object({
  id: z.number().int(),
  username: z.string(),
  email: z.string(),
  displayName: z.string(),
  globalRole: z.enum(['user', 'setter', 'admin']),
  locale: z.string(),
  timezone: z.string(),
  totpEnabled: z.boolean(),
  createdAt: Timestamp,
});
export type MeResponseDto = z.infer<typeof MeResponse>;

export const LoginResponse = z.object({ user: MeResponse });

registry.registerPath({
  method: 'post',
  path: '/auth/register',
  summary: 'Create an account',
  request: { body: { content: { 'application/json': { schema: RegisterRequest } } } },
  responses: {
    201: { description: 'The account was created', content: { 'application/json': { schema: MeResponse } } },
    409: {
      description: 'That username or email is already registered (`username_taken` or `email_taken`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: {
      description: 'The request body failed validation',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/auth/login',
  summary: 'Sign in and receive a session cookie',
  request: { body: { content: { 'application/json': { schema: LoginRequest } } } },
  responses: {
    200: { description: 'Signed in', content: { 'application/json': { schema: LoginResponse } } },
    401: {
      description: 'Invalid credentials or a TOTP code is required',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/auth/logout',
  summary: 'End the current session',
  description:
    'Public and idempotent on purpose: a caller whose session has already expired still gets its cookie ' +
    'cleared, rather than a 401.',
  responses: {
    204: { description: 'Signed out (or was already signed out)' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/auth/me',
  summary: 'The signed-in user',
  responses: {
    200: { description: 'Profile', content: { 'application/json': { schema: MeResponse } } },
    401: {
      description: 'Not signed in',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});
