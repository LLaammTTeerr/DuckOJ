/**
 * D73 — every place a signed-in caller re-proves their password shares one
 * meter.
 *
 * D72 closed two doors by demanding the account password: `DELETE
 * /auth/totp` (turning the second factor off) and, before it,
 * `POST /auth/password/change`. Its argument for demanding one is that **a
 * session is the thing an intruder steals**, and both routes are reachable
 * with exactly the stolen thing. That argument does not stop at the demand:
 * an unmetered check reachable from the stolen session is an unlimited
 * oracle for the password itself, answering 401 or 2xx on every guess, on
 * routes that need no email, no second factor and no fresh sign-in. Login
 * has been metered since B1 precisely so that door is not open; these two
 * were the way round it.
 *
 * Three consequences, each deliberate:
 *
 * - **One purpose, keyed on the user id.** Not one meter per route: a
 *   budget that is spent per endpoint grows with the number of endpoints
 *   that check a password, which is the wrong direction for it to grow in.
 *   Keyed on the id rather than the session, so a fresh sign-in does not buy
 *   a fresh ten, and one account cannot spend another's.
 * - **Read BEFORE the password is verified**, exactly as D72's confirm meter
 *   is: a limiter the *correct* guess walks past is a limiter the attacker's
 *   winning guess walks past, and that is the only guess that matters.
 * - **`allow`, not `consumeOnce`** — D72's choice, for D72's reason. A
 *   refused attempt is recorded too, so a caller hammering the endpoint
 *   keeps burning their own window rather than probing its edge for free.
 *
 * There is a second reason for the bound that has nothing to do with
 * guessing: every check is one argon2id verification at 19 MiB on the libuv
 * thread pool this process shares with every sign-in and every roster
 * import (D61). A loop on either route is a denial of service against
 * signing in, from one ordinary session.
 */
import { AppError } from '../common/app.error.js';
import type { RateLimiter } from '../common/rate-limiter.js';

const PURPOSE = 'password_check';

/**
 * Ten in fifteen minutes — D72's shape for the same class of guess.
 *
 * Generous for the human case (a person mistyping their own password twice
 * before getting it right) and useless for the scripted one.
 */
const LIMIT = 10;
const WINDOW_MS = 15 * 60_000;

/**
 * Spends one attempt against the account's budget, or throws the 429.
 *
 * Called by `AuthService.changePassword` and `TotpService.disableWithPassword`
 * immediately before they verify a hash — never by `resetPassword` or
 * `AdminUsersService.resetTotp`, which prove who they are some other way and
 * check no password at all.
 */
export async function spendPasswordCheck(limiter: RateLimiter, userId: number): Promise<void> {
  const key = String(userId);
  if (await limiter.allow(PURPOSE, key, LIMIT, WINDOW_MS)) return;
  const retryAfter = await limiter.retryAfterSeconds(PURPOSE, key, LIMIT, WINDOW_MS);
  throw new AppError(
    429,
    'password_check_rate_limited',
    'Too many password attempts. Try again later.',
    undefined,
    { 'Retry-After': String(retryAfter ?? 1) },
  );
}
