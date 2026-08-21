/**
 * `ContestParticipation.start` and `.end_time` — the window a submission has to
 * fall inside to count.
 *
 * Both live here, together, because DuckOJ diverges from DMOJ by filtering on
 * this window (DIV-1) while DMOJ filters on nothing at all. A second derivation
 * of "when does this participation end" is exactly the split-predicate bug this
 * project has found once per phase, so the start rule moved here to sit beside
 * the end rule rather than being reimplemented next to it.
 *
 * Read from `judge/models/contest.py`, not from memory. The one branch omitted
 * is `pre_registered`, which keys off `real_start` landing on 1970-01-01 — a
 * sentinel DuckOJ has no concept of and no fixture exercises.
 */

import type { ContestSpec, ParticipantSpec } from './types.js';

export const SPECTATE = -1;
export const LIVE = 0;

export function parseInstant(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`not an ISO-8601 instant: ${value}`);
  return ms;
}

/**
 * `ContestParticipation.start`. A live or spectating participation in a contest
 * with no time limit starts when the *contest* does, so joining late costs
 * nothing — `real_start` is only honoured for virtual participations and for
 * time-limited contests.
 */
export function participationStartMs(
  participant: ParticipantSpec,
  contest: ContestSpec,
): number {
  const live = participant.virtual === LIVE;
  const spectate = participant.virtual === SPECTATE;
  if (contest.time_limit_seconds === null && (live || spectate)) {
    return parseInstant(contest.start_time);
  }
  return parseInstant(participant.real_start);
}

/**
 * `ContestParticipation.end_time`.
 *
 * A **virtual** participation legitimately outlives the contest: with no time
 * limit its window is the contest's *duration* measured from its own start, so
 * an entrant beginning six hours late still gets the full five hours. Every
 * `05-virtual-participation` golden depends on this — a window taken from
 * `contest.end_time` would void submissions DMOJ correctly counts, trading an
 * old bug for a new one.
 */
export function participationEndMs(participant: ParticipantSpec, contest: ContestSpec): number {
  const contestEndMs = parseInstant(contest.end_time);
  if (participant.virtual === SPECTATE) return contestEndMs;

  const limitSeconds = contest.time_limit_seconds;
  if (participant.virtual !== LIVE) {
    const durationMs =
      limitSeconds === null ? contestEndMs - parseInstant(contest.start_time) : limitSeconds * 1000;
    return parseInstant(participant.real_start) + durationMs;
  }

  if (limitSeconds === null) return contestEndMs;
  return Math.min(parseInstant(participant.real_start) + limitSeconds * 1000, contestEndMs);
}

/**
 * Whether a submission counts toward this participation.
 *
 * **Inclusive at both ends.** `Contest.ended` is `end_time < now` — strictly
 * after — so a submission stamped exactly at the deadline is still inside the
 * contest, and `03-deadline-boundary` contains one by design.
 */
export function isWithinWindow(dateMs: number, startMs: number, endMs: number): boolean {
  return dateMs >= startMs && dateMs <= endMs;
}
