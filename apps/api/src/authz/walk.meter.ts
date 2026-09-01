/**
 * The walk meter — ONE budget, shared by every bulk read of people (D188, D191).
 *
 * D188 put this in `user.access.ts` because `GET /users` was the only list of
 * people a stranger could sweep. D191 found the second one — a public
 * organization's roster — and the honest way to cover it is not a second
 * meter with a second constant. Two budgets would mean a caller who has spent
 * their twenty pages of `GET /users` still has twenty more pages of every
 * school's roster, which is the same province-scale sweep with an extra step
 * in it. So the purpose, the limit and the window live here, and both call
 * sites spend the SAME window under the SAME key.
 *
 * The name is still `user_walk`, deliberately: `rate_events` on the live host
 * already holds rows under it, and renaming a plain-text purpose orphans
 * every one of them along with D47's refusal markers, for nothing. What is
 * being counted did not change — pages of a list of users — only which routes
 * can serve them.
 */
import { AppError } from '../common/app.error.js';
import type { RateLimiter } from '../common/rate-limiter.js';

/** The `rate_events.purpose` a page-advance through a list of people is counted under. */
export const USER_WALK_PURPOSE = 'user_walk';

/**
 * Pages of a list of people a single ACCOUNT may advance through per window.
 *
 * A judgement, not a measurement — one constant, exactly as D16 says of its
 * three. Twenty pages is generous for every use anyone has articulated and
 * slow for the one nobody has: at the maximum page of 100 it is 2 000 rows an
 * hour, so a province's 25 000 accounts take half a working day and leave a
 * `rate_events` trail under one user id the whole way.
 *
 * It is not raised for the roster, because the reader who would need it
 * raised is exempt from it instead — see `OrgAccessService.listMembers`. A
 * teacher paging their own five-thousand-pupil school is 200 presses of "load
 * more", and metering them at twenty would be D16's self-lockout on a real
 * screen; a caller with no standing in the school has no such page to render.
 */
export const USER_WALK_LIMIT = 20;
export const USER_WALK_WINDOW_MS = 3_600_000;

/**
 * The key, and the whole reason the gate and the meter are one ruling.
 *
 * `user:<id>` and **never an address**. A school computer room is one NAT
 * address and thirty pupils; an IP-keyed meter would hand the room a single
 * budget between them and lock the last arrivals out in the middle of a
 * contest — worse than the problem it solves. Requiring an actor before a
 * walk is what MAKES this key available, which is why D188 refused to meter
 * anonymous callers and D191 refuses to let them walk at all.
 */
export function walkKey(userId: number): string {
  return `user:${String(userId)}`;
}

/**
 * `null` when this account may advance another page, or the whole seconds
 * until it may.
 *
 * D16's split rather than D13's `allow`: the caller asks BEFORE it knows
 * whether the page will be served, so a refused request records nothing and
 * the window DRAINS instead of a caller who hit the wall pinning themselves
 * against it.
 */
export function walkRetryAfter(limiter: RateLimiter, userId: number): Promise<number | null> {
  return limiter.retryAfterSeconds(
    USER_WALK_PURPOSE,
    walkKey(userId),
    USER_WALK_LIMIT,
    USER_WALK_WINDOW_MS,
  );
}

/** Recorded only for a page that was actually served. Call it after the read. */
export async function recordWalk(limiter: RateLimiter, userId: number): Promise<void> {
  await limiter.record(USER_WALK_PURPOSE, walkKey(userId), USER_WALK_WINDOW_MS);
}

/**
 * The refusal, identical on both routes so a client handles one code in one
 * place. `Retry-After` in whole seconds per RFC 9110, through `AppError`'s
 * headers bag; never `0`, which would invite a retry that is refused again.
 */
export function walkRefused(retryAfterSeconds: number): AppError {
  return new AppError(
    429,
    'user_walk_rate_limited',
    'Too many pages of this list have been requested. Try again later.',
    undefined,
    { 'Retry-After': String(retryAfterSeconds) },
  );
}
