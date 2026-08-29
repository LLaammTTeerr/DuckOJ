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
  /** Nothing is gated on this yet — see 3f §5. */
  emailVerified: z.boolean(),
  createdAt: Timestamp,
});
export type MeResponseDto = z.infer<typeof MeResponse>;

export const LoginResponse = z.object({ user: MeResponse });

registry.registerPath({
  method: 'post',
  path: '/auth/register',
  tags: ['Auth'],
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
  tags: ['Auth'],
  summary: 'Sign in and receive a session cookie',
  request: { body: { content: { 'application/json': { schema: LoginRequest } } } },
  responses: {
    200: { description: 'Signed in', content: { 'application/json': { schema: LoginResponse } } },
    401: {
      description: 'Invalid credentials or a TOTP code is required',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    429: {
      description:
        'Too many FAILED sign-in attempts (`login_rate_limited`) — ten per identifier and thirty ' +
        'per client IP, each per fifteen minutes (D16). A successful sign-in consumes neither ' +
        'window, and the refusal itself records nothing. `Retry-After` carries the whole seconds ' +
        'until the window frees up.',
      headers: {
        'Retry-After': {
          description: 'Whole seconds until another attempt will be accepted',
          required: true,
          schema: { type: 'integer' },
        },
      },
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/auth/logout',
  tags: ['Auth'],
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
  tags: ['Auth'],
  summary: 'The signed-in user',
  responses: {
    200: { description: 'Profile', content: { 'application/json': { schema: MeResponse } } },
    401: {
      description: 'Not signed in',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

/**
 * Password reset and address verification.
 *
 * `forgot` answers the same way for every syntactically valid address, so the
 * endpoint cannot be used to ask whether someone has an account here.
 */
export const ForgotPasswordRequest = z.object({ email: z.string().email() }).strict();
export type ForgotPasswordRequestDto = z.infer<typeof ForgotPasswordRequest>;

export const ResetPasswordRequest = z
  .object({ token: z.string().min(1).max(256), password: z.string().min(12).max(256) })
  .strict();
export type ResetPasswordRequestDto = z.infer<typeof ResetPasswordRequest>;

export const VerifyEmailRequest = z.object({ token: z.string().min(1).max(256) }).strict();
export type VerifyEmailRequestDto = z.infer<typeof VerifyEmailRequest>;

const INVALID_TOKEN = {
  description: 'The link is invalid, expired, or already used — all answered identically',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};

registry.registerPath({
  method: 'post',
  path: '/auth/password/forgot',
  tags: ['Auth'],
  summary: 'Send a password-reset link',
  request: { body: { content: { 'application/json': { schema: ForgotPasswordRequest } } } },
  responses: {
    202: { description: 'Accepted — answered identically whether or not the account exists' },
    422: {
      description: 'Not a syntactically valid address',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/auth/password/reset',
  tags: ['Auth'],
  summary: 'Redeem a reset link; ends every session for that user',
  request: { body: { content: { 'application/json': { schema: ResetPasswordRequest } } } },
  responses: { 200: { description: 'Password changed' }, 400: INVALID_TOKEN },
});

registry.registerPath({
  method: 'post',
  path: '/auth/email/verify/send',
  tags: ['Auth'],
  summary: 'Send an address-confirmation link to the signed-in user',
  responses: { 202: { description: 'Accepted' }, 401: { description: 'Not signed in' } },
});

registry.registerPath({
  method: 'post',
  path: '/auth/email/verify',
  tags: ['Auth'],
  summary: 'Confirm an email address',
  request: { body: { content: { 'application/json': { schema: VerifyEmailRequest } } } },
  responses: { 200: { description: 'Address confirmed' }, 400: INVALID_TOKEN },
});
