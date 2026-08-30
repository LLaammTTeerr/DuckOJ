import { z } from 'zod';
import { ProblemDetails, Timestamp } from './common.js';
import { registry } from './registry.js';

export const Username = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[A-Za-z0-9_.-]+$/, 'may contain letters, digits, dot, underscore and hyphen only');

export const Password = z.string().min(10).max(256);

/**
 * A person's rendered name — one schema, used by registration and by the
 * profile edit alike.
 *
 * Two things it is not, both of which it was:
 *
 *  - **Not `min(1)` on the raw string.** `'   '` satisfies that, and three
 *    spaces are a name that renders as nothing at all: an empty heading on
 *    the profile, an empty cell in the user list, an empty author on every
 *    clarification. `.trim()` runs FIRST, so `min(1)` means what it looks
 *    like it means, and `max` measures the name rather than the padding.
 *  - **Not two different rules.** Registration capped at 64 and
 *    `UpdateMeRequest` at 100, so the same account could hold a name it
 *    could not have been created with. Unified at 100 — the wider of the
 *    two, so no stored name becomes unsavable.
 *
 * The trim is a transform, not a refusal: `'  Lan  '` is a typo, not an
 * attack, and correcting it is friendlier than a 422 about invisible
 * characters. It also means two accounts cannot wear the same name padded
 * differently.
 */
export const DisplayName = z.string().trim().min(1).max(100);

export const RegisterRequest = z.object({
  username: Username,
  email: z.string().email(),
  password: Password,
  displayName: DisplayName,
});
export type RegisterRequestDto = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.object({
  usernameOrEmail: z.string().min(1),
  password: z.string().min(1),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
  /**
   * A single-use TOTP recovery code (D39), the alternative to `totpCode` when
   * the authenticator is gone. Deliberately loose — the server canonicalizes
   * (uppercase, non-alphanumerics dropped) before hashing, so a code typed
   * without its dash, in lowercase, or with a stray space still works. A
   * strict shape here would answer 422 for a mistyped credential, which is a
   * different thing from "that code is wrong" and would escape D16's window.
   */
  recoveryCode: z.string().min(1).max(64).optional(),
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
  /**
   * How many unused TOTP recovery codes the account still holds (D39). Zero
   * whenever 2FA is off, so the security page can tell "none left, regenerate
   * now" apart from "nothing to have".
   */
  recoveryCodesRemaining: z.number().int(),
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
  description:
    'A taken EMAIL is answered with 201 and a body of the same shape, and no account is created (D26) — ' +
    'an address is not public, and a distinguishable refusal made this endpoint an email-enumeration ' +
    'oracle. A taken USERNAME is still a 409: a username is public, and refusing it is the only way a ' +
    'caller can pick another one.',
  request: { body: { content: { 'application/json': { schema: RegisterRequest } } } },
  responses: {
    201: {
      description:
        'The account was created — OR the address was already registered, in which case nothing was ' +
        'created and this response is deliberately indistinguishable from the one above (D26)',
      content: { 'application/json': { schema: MeResponse } },
    },
    409: {
      description: 'That username is already registered (`username_taken`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: {
      description: 'The request body failed validation',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    429: {
      description:
        'Too many registrations from this client IP (`register_rate_limited`) — thirty per hour (D26). ' +
        'Unlike login, EVERY attempt counts: what is metered is the cost of an argon2id hash, which a ' +
        'successful registration pays in full. The refusal itself records nothing, so the window drains. ' +
        '`Retry-After` carries the whole seconds until another attempt will be accepted.',
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
  path: '/auth/login',
  tags: ['Auth'],
  summary: 'Sign in and receive a session cookie',
  description:
    'When the account has 2FA on, exactly one of `totpCode` or `recoveryCode` must accompany the '+
    'password; `totpCode` wins if both are sent. A recovery code is spent on the sign-in it '+
    'succeeds at, and when it was the last one the account is sent a notification telling its '+
    'holder to generate a new set (D39).',
  request: { body: { content: { 'application/json': { schema: LoginRequest } } } },
  responses: {
    200: { description: 'Signed in', content: { 'application/json': { schema: LoginResponse } } },
    401: {
      description:
        'Invalid credentials, or a second factor is required (`totp_required`), or the second factor ' +
        'was wrong (`invalid_totp_code`). A `recoveryCode` that is unknown, malformed or ALREADY SPENT ' +
        'answers `invalid_totp_code` too (D39): a caller must not be able to tell a code that never ' +
        'existed from one that has already been used.',
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
