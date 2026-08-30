/**
 * The seat — one row per (contest, person) for every live participation
 * (D104, migration 0038).
 *
 * D99's rule is "a person holds at most one participation per contest", and
 * until now it was enforced by two checks in two services:
 * `ContestAccessService.assertMembersFree` at `join`, and (since B-18)
 * `TeamAccessService.assertAddedMembersFree` at the roster PATCH. Both are
 * correct and neither can close the gap, because they run in separate
 * transactions that do not serialise: each reads a world in which the other
 * has not happened, each says yes, and both write. D99 already names what
 * that costs — `actingParticipations` choosing between two rows by id,
 * `setDisqualified` moving both, one pupil's work counted twice on one board.
 *
 * `contest_seats` is the fact the checks were asserting, written down where a
 * unique index can hold it. The checks stay: they are what produce a legible
 * refusal naming the pupil, and the index is the backstop nothing can race
 * past. This module is the only place that writes the table, so the three
 * paths cannot disagree about what a seat is.
 *
 * Every function takes the caller's transaction handle and opens none of its
 * own: a seat exists if and only if the participation or roster change it
 * describes commits.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '@duckoj/db';
import { contestParticipations, contestSeats } from '@duckoj/db/guarded';
import { AppError } from '../common/app.error.js';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** `virtual = 0`: a replay is not a seat, and several are allowed per person. */
const LIVE_VIRTUAL = 0;

/**
 * Seats `userIds` on `participationId`.
 *
 * `onConflictDoNothing` is deliberately NOT used: a conflict here is the race
 * this table exists to catch, and swallowing it would restore the bug with
 * extra steps. The violation propagates and {@link toSeatConflict} turns it
 * into the same 409 the app-level check would have produced.
 */
export async function seat(
  db: Db,
  contestId: number,
  participationId: number,
  userIds: readonly number[],
): Promise<void> {
  if (userIds.length === 0) return;
  await db
    .insert(contestSeats)
    .values(userIds.map((userId) => ({ contestId, userId, participationId })));
}

/**
 * Gives up the seats `userIds` hold on `participationId`.
 *
 * Keyed on the participation as well as the person, so a roster edit can only
 * ever release the seats its OWN row holds — a pupil competing elsewhere in
 * the same contest keeps theirs.
 */
export async function unseat(
  db: Db,
  participationId: number,
  userIds: readonly number[],
): Promise<void> {
  if (userIds.length === 0) return;
  await db
    .delete(contestSeats)
    .where(
      and(
        eq(contestSeats.participationId, participationId),
        inArray(contestSeats.userId, [...userIds]),
      ),
    );
}

/**
 * A team's roster has been replaced: move the seats on every live row it
 * holds to match.
 *
 * The removals matter as much as the additions. D99 rules that a member taken
 * off the roster stops competing for the team from that moment, so a seat
 * left behind would bar that pupil from the contest for the rest of it — on a
 * row they no longer have any part in.
 */
export async function reseatTeam(
  db: Db,
  teamId: number,
  memberIds: readonly number[],
): Promise<void> {
  const rows = await db
    .select({ id: contestParticipations.id, contestId: contestParticipations.contestId })
    .from(contestParticipations)
    .where(
      and(
        eq(contestParticipations.teamId, teamId),
        eq(contestParticipations.virtual, LIVE_VIRTUAL),
      ),
    );
  for (const row of rows) {
    const held = await db
      .select({ userId: contestSeats.userId })
      .from(contestSeats)
      .where(eq(contestSeats.participationId, row.id));
    const before = new Set(held.map((seat) => seat.userId));
    const after = new Set(memberIds);
    await unseat(db, row.id, [...before].filter((userId) => !after.has(userId)));
    await seat(db, row.contestId, row.id, [...after].filter((userId) => !before.has(userId)));
  }
}

/**
 * A `unique_violation` on the seat's primary key, as the refusal the checks
 * would have given.
 *
 * The code is `contest_already_joined` — the one `assertMembersFree` and
 * `assertAddedMembersFree` already use — so a client has one thing to branch
 * on whether the check caught it or the index did. The sentence is vaguer
 * than theirs on purpose: at this point the loser of a race knows a seat was
 * taken and nothing about by whom, and inventing a name would mean a second
 * query on the error path to say something the caller can read off the board.
 */
export function toSeatConflict(error: unknown): unknown {
  const violation = asViolation(error);
  if (violation?.constraint_name === 'contest_seats_contest_id_user_id_pk') {
    return new AppError(
      409,
      'contest_already_joined',
      'Somebody in this entry is already competing in this contest.',
    );
  }
  return error;
}

function asViolation(error: unknown): { code: string; constraint_name?: string } | undefined {
  if (isViolation(error)) return error;
  const cause = error instanceof Error ? error.cause : undefined;
  return isViolation(cause) ? cause : undefined;
}

function isViolation(value: unknown): value is { code: string; constraint_name?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    (value as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}
