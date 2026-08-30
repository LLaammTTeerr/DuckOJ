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

/**
 * The eight single-use recovery codes (D39), returned ONCE — by the confirm
 * that created them and by the regenerate that replaced them. Nothing can
 * show them again: only their hashes are kept.
 *
 * Formatted `xxxxx-xxxxx` for transcription. The server canonicalizes on the
 * way in, so a code typed back without the dash still works.
 */
export const TotpRecoveryCodesResponse = z.object({ recoveryCodes: z.array(z.string()) });
export type TotpRecoveryCodesResponseDto = z.infer<typeof TotpRecoveryCodesResponse>;

/**
 * Turning the second factor OFF is re-authentication, not a click (D72).
 *
 * The session alone is exactly what an intruder holds: `@SessionOnly` keeps
 * a stolen access token out, and nothing else stood between a stolen cookie
 * and an account with no second factor. The password is the one secret the
 * thief of a session does not have; a TOTP code is not (the phone is what
 * gets lost, which is why `POST /auth/totp/recovery/regenerate` exists).
 */
export const TotpDisableRequest = z.object({ password: z.string().min(1).max(1024) });
export type TotpDisableRequestDto = z.infer<typeof TotpDisableRequest>;

/** Regenerating proves control of the authenticator, so it carries a live code. */
export const TotpRecoveryRegenerateRequest = z.object({ code: z.string().regex(/^\d{6}$/) });
export type TotpRecoveryRegenerateRequestDto = z.infer<typeof TotpRecoveryRegenerateRequest>;

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
  tags: ['Auth'],
  summary: 'Begin TOTP enrolment',
  description:
    'Upserts a fresh, unconfirmed secret. Calling this again while an enrolment is still pending ' +
    'replaces the previous secret, so the last QR shown is the one that works. Calling it once 2FA is ' +
    'already ON is refused (409 `totp_already_enabled`, D33): the upsert would clear `confirmedAt` and ' +
    'turn the second factor off with no code and no notice. Re-enrol by disabling first.',
  responses: {
    200: {
      description: 'The secret and its otpauth:// URL, to render as a QR code',
      content: { 'application/json': { schema: TotpBeginResponse } },
    },
    401: NOT_SIGNED_IN,
    403: SESSION_REQUIRED,
    409: {
      description:
        'Two-factor authentication is already enabled (`totp_already_enabled`) — disable it before enrolling again',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/auth/totp/confirm',
  tags: ['Auth'],
  summary: 'Confirm TOTP enrolment',
  description:
    'Answers with the eight single-use RECOVERY CODES for the account (D39). This is the only time ' +
    'they are ever shown — only their hashes are stored — and confirming again replaces the set, ' +
    'because a confirm proves exactly what a regenerate does.',
  request: { body: { content: { 'application/json': { schema: TotpConfirmRequest } } } },
  responses: {
    200: {
      description:
        'Enrolment confirmed; the account now requires a TOTP code at login. The body carries the ' +
        'recovery codes, once.',
      content: { 'application/json': { schema: TotpRecoveryCodesResponse } },
    },
    401: NOT_SIGNED_IN,
    403: SESSION_REQUIRED,
    422: {
      description:
        'The code is not a valid 6-digit code for the credential (`invalid_totp_enrolment_code`) — ' +
        'the same code this route and `recovery/regenerate` both use for "the code you typed at a ' +
        'credential-management route was wrong", which a client must be able to tell apart from the ' +
        'login-time 401 `invalid_totp_code`',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    429: {
      description:
        'Ten confirmations have been attempted for this account in the last fifteen minutes ' +
        '(`totp_confirm_rate_limited`, D72). The meter is read BEFORE the code is checked, so a ' +
        'correct code inside a spent window is refused too.',
      headers: {
        'Retry-After': {
          description: 'Whole seconds until another attempt will be accepted',
          schema: { type: 'string' },
        },
      },
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/auth/totp/recovery/regenerate',
  tags: ['Auth'],
  summary: 'Replace the TOTP recovery codes',
  description:
    'Issues a fresh set of eight and invalidates every previous code, used or not. Requires a live ' +
    'TOTP code: the recovery codes are the second factor in another shape, so minting a new set from ' +
    'a session alone would let whoever holds a stolen session walk out with eight standing logins. ' +
    'The code presented here is SPENT (D34), exactly as it would be at a sign-in.',
  request: {
    body: { content: { 'application/json': { schema: TotpRecoveryRegenerateRequest } } },
  },
  responses: {
    200: {
      description: 'The new codes, shown once',
      content: { 'application/json': { schema: TotpRecoveryCodesResponse } },
    },
    401: NOT_SIGNED_IN,
    403: SESSION_REQUIRED,
    409: {
      description:
        'Two-factor authentication is not enabled for this account (`totp_not_enabled`) — there is ' +
        'nothing to recover to, and the code check would otherwise pass vacuously',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: {
      description: 'The code is wrong or already spent (`invalid_totp_enrolment_code`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/auth/totp',
  tags: ['Auth'],
  summary: 'Disable TOTP, presenting the current password',
  description:
    'The account password is required (D72): a session is what an intruder steals, and stripping ' +
    "the second factor with the stolen thing is the move the second factor exists to stop. An " +
    "admin's `POST /admin/users/{username}/totp/reset` is unaffected — it is not the account " +
    'holder acting, and it is already gated on being an admin.',
  request: { body: { content: { 'application/json': { schema: TotpDisableRequest } } } },
  responses: {
    204: { description: 'Disabled (or was already off)' },
    401: {
      description:
        'Not signed in, or the password is wrong (`invalid_credentials`) — the same code and status ' +
        '`POST /auth/password/change` answers for the same mistake',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    403: SESSION_REQUIRED,
    422: {
      description: 'No password was sent',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    429: {
      description:
        'Ten password attempts have been made for this account in the last fifteen minutes ' +
        '(`password_check_rate_limited`, D73). ONE budget is shared with ' +
        '`POST /auth/password/change`, keyed on the account, and it is read BEFORE the password ' +
        'is verified — so a correct password inside a spent window is refused too.',
      headers: {
        'Retry-After': {
          description: 'Whole seconds until another attempt will be accepted',
          schema: { type: 'string' },
        },
      },
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});
