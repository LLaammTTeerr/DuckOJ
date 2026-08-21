import { eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { submissions } from '@duckoj/db/guarded';
import { isAdmin, type Actor } from './actor.js';

/**
 * The one predicate for "may `actor` see a submission owned by `ownerId`" —
 * yours, or admin, and nothing else (Phase 1's rule; Phase 4 is expected to
 * extend it with contest rules and per-problem source visibility, at which
 * point both call sites below still only need to change here).
 *
 * `SubmissionAccessService.getVisible` (single-row) and `.listVisible`
 * (list, via `visibleSubmissionsWhere` below) both resolve to this same
 * function rather than each keeping its own copy of "owner or admin" —
 * spec §4.1 requires the set `GET /submissions` returns to equal exactly
 * the set of ids `GET /submissions/{id}` answers 200 for, and two
 * independently-written copies of the same rule are exactly how that
 * agreement silently breaks (the Phase 2b org-visibility shape).
 */
export function canViewSubmission(actor: Actor, ownerId: number): boolean {
  return ownerId === actor.userId || isAdmin(actor);
}

/** The list-query form of `canViewSubmission`, for a `WHERE` clause rather than a row already in hand. */
export function visibleSubmissionsWhere(actor: Actor): SQL {
  if (isAdmin(actor)) return sql`true`;
  return eq(submissions.userId, actor.userId);
}
