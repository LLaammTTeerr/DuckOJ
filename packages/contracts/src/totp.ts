import { z } from 'zod';
import { ProblemDetails } from './common.js';
import { registry } from './registry.js';

export const TotpBeginResponse = z.object({
  /** Shown once, so the user can enter it manually if they cannot scan `otpauthUrl`. */
  secret: z.string(),
  otpauthUrl: z.string(),
});
export type TotpBeginResponseDto = z.infer<typeof TotpBeginResponse>;

export const TotpConfirmRequest = z.object({ code: z.string().regex(/^\d{6}$/) });
export type TotpConfirmRequestDto = z.infer<typeof TotpConfirmRequest>;

// Every route here rewrites the caller's second factor — see
// `TotpController`'s comment on why a bearer token must never reach any of
// them — so all three require an interactive session, exactly like
// `/auth/tokens`.
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
  path: '/auth/totp/begin',
  summary: 'Begin TOTP enrolment',
  description:
    'Upserts a fresh, unconfirmed secret. Calling this again before confirming silently replaces the ' +
    'previous secret — and calling it after 2FA is already enabled disables it until `confirm` succeeds.',
  responses: {
    200: {
      description: 'The secret and its otpauth:// URL, to render as a QR code',
      content: { 'application/json': { schema: TotpBeginResponse } },
    },
    401: NOT_SIGNED_IN,
    403: SESSION_REQUIRED,
  },
});

registry.registerPath({
  method: 'post',
  path: '/auth/totp/confirm',
  summary: 'Confirm TOTP enrolment',
  request: { body: { content: { 'application/json': { schema: TotpConfirmRequest } } } },
  responses: {
    204: { description: 'Enrolment confirmed; the account now requires a TOTP code at login' },
    401: NOT_SIGNED_IN,
    403: SESSION_REQUIRED,
    422: {
      description: 'The code is not a valid 6-digit code for the pending secret (`invalid_totp_enrolment_code`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/auth/totp',
  summary: 'Disable TOTP',
  responses: {
    204: { description: 'Disabled (or was already off)' },
    401: NOT_SIGNED_IN,
    403: SESSION_REQUIRED,
  },
});
