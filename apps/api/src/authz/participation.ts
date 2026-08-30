/**
 * Contest participation: the window a participant may submit in, finding the
 * one that is open, and routing a submission into it.
 *
 * Free functions rather than a service, like the visibility rules beside them,
 * so both `ContestAccessService` (join, read) and `SubmissionAccessService`
 * (route a submission) reach the same code without either depending on the
 * other.
 */
import { and, asc, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { contestParticipations, contestProblems, teamMembers } from '@duckoj/db/guarded';
import { participationEndMs, participationStartMs } from '@duckoj/contest-formats';
import type { Db } from '@duckoj/db';
import { AppError } from '../common/app.error.js';

/** The contest columns the window depends on. */
export interface ContestWindowRow {
  id: number;
  key: string;
  startTime: Date;
  endTime: Date;
  timeLimitSeconds: number | null;
}

/** The participation columns the window depends on. */
export interface ParticipationRow {
  id: number;
  virtual: number;
  startTime: Date;
  isDisqualified: boolean;
  /** The team this row competes as (D99), or `null` for an individual entry. */
  teamId: number | null;
}

/**
 * `ContestParticipation.start` and `.end_time`, from `@duckoj/contest-formats`
 * rather than re-derived here.
 *
 * Those helpers are what DIV-1 filters the scoreboard with. If submit-time
 * enforcement used its own copy, the two would disagree the first time either
 * changed — and the symptom would be a submission accepted at the door and
 * then silently dropped from the ranking, which is the worst possible way for
 * a competitor to find out.
 */
export function participationWindow(
  contest: ContestWindowRow,
  participation: Pick<ParticipationRow, 'virtual' | 'startTime'>,
): { startMs: number; endMs: number } {
  const spec = {
    start_time: contest.startTime.toISOString(),
    end_time: contest.endTime.toISOString(),
    time_limit_seconds: contest.timeLimitSeconds,
  };
  const who = { virtual: participation.virtual, real_start: participation.startTime.toISOString() };
  return { startMs: participationStartMs(who, spec), endMs: participationEndMs(who, spec) };
}

/**
 * The caller's participations in this contest, highest `virtual` first.
 *
 * Descending because that is the one the caller is plausibly *in*: a live
 * participation (`virtual = 0`) closes when the contest does, and every
 * virtual attempt starts after it. Ordering this way makes "the open one"
 * deterministic without depending on ids.
 */
export async function listParticipations(
  db: Db,
  contestId: number,
  userId: number,
): Promise<ParticipationRow[]> {
  return selectParticipations(
    db,
    and(
      eq(contestParticipations.contestId, contestId),
      eq(contestParticipations.userId, userId),
    )!,
  );
}

/**
 * The team ids this user is on (D99). One query, and `[]` for somebody on
 * none — which is every competitor in every individual contest, so the
 * caller can skip the second query entirely.
 */
export async function teamIdsOf(db: Db, userId: number): Promise<number[]> {
  const rows = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId));
  return rows.map((row) => row.teamId);
}

/**
 * **Every participation this user acts under in this contest** — their own
 * rows, and the rows held by any team they are on (D99).
 *
 * ONE function, and that is the whole point of it. Four call sites answer
 * "which participation is this person competing in": `join`'s idempotent
 * short-circuit, `GET /contests/{key}/me`, `resolveContestTarget` (a
 * submission with `?contest=`), and `ContestClarificationsService.ask`. Each
 * of them used to spell the question as `user_id = ?`, and a team
 * participation is held by ONE member's account — so four independent
 * widenings would be four chances to reintroduce the split-predicate bug
 * D22, D23 and D25 each record having paid for once.
 *
 * Ordered highest `virtual` first (`listParticipations`' rule, for its
 * reason) and then by lowest id, so that a competitor who somehow holds two
 * rows at the same `virtual` — a roster edited between two teams' joins is
 * the only way — resolves to the same one on every request rather than to
 * whatever the planner returned first.
 *
 * **The `user_id` half is narrowed to rows that are NOT a team's** (`team_id
 * is null`), and that narrowing is the whole of D99's "membership is read,
 * never frozen". A team's participation is held by the account that pressed
 * Join, so a bare `user_id = you` says yes to that account for as long as the
 * row exists — including after the roster edit that took them off the team.
 * The captain is the ONE member a removal would not have removed, which is
 * both the likeliest person to be taken off (they are on the machine that
 * entered) and the exact case D99 says must stop: "a member removed mid-round
 * stops being able to submit for the team from that moment". Whether they may
 * still READ the round's problems is a different question with a different
 * answer — `problem.visibility.ts`'s own predicate keeps saying yes, because
 * they did compete on it.
 */
export async function actingParticipations(
  db: Db,
  contestId: number,
  userId: number,
): Promise<ParticipationRow[]> {
  const teamIds = await teamIdsOf(db, userId);
  const mine = and(
    eq(contestParticipations.userId, userId),
    isNull(contestParticipations.teamId),
  )!;
  return selectParticipations(
    db,
    and(
      eq(contestParticipations.contestId, contestId),
      teamIds.length === 0 ? mine : or(mine, inArray(contestParticipations.teamId, teamIds))!,
    )!,
  );
}

function selectParticipations(db: Db, where: SQL): Promise<ParticipationRow[]> {
  return db
    .select({
      id: contestParticipations.id,
      virtual: contestParticipations.virtual,
      startTime: contestParticipations.startTime,
      isDisqualified: contestParticipations.isDisqualified,
      teamId: contestParticipations.teamId,
    })
    .from(contestParticipations)
    .where(where)
    .orderBy(desc(contestParticipations.virtual), asc(contestParticipations.id));
}

/**
 * Where a submission with `contestKey` set should land, or the reason it may
 * not land anywhere.
 *
 * The window check is **inclusive at both ends**, matching DIV-1 and
 * `Contest.ended` (`end_time < now`, strictly after): a submission stamped
 * exactly at the deadline is inside the contest.
 */
export async function resolveContestTarget(
  db: Db,
  contest: ContestWindowRow,
  userId: number,
  problemId: number,
  at: Date,
): Promise<{ participationId: number; contestProblemId: number }> {
  // The PARTICIPATION checks run first, and that ordering is load-bearing
  // rather than stylistic. `ContestAccessService.getVisible` conceals a
  // contest's problem list until it starts — `problems: []` for anyone who
  // does not run it — and nobody can join before the start either, so a
  // pairing check answering 400 `problem_not_in_contest` here while a
  // problem that IS in the contest answered 403 `contest_not_joined` read
  // the concealed list back one public problem code at a time. Refuse on the
  // caller's own standing first; only somebody with an open, undisqualified
  // window learns which problems the contest holds.
  // `actingParticipations`, never `listParticipations`: in a team contest the
  // participation belongs to whichever member pressed Join, and every other
  // member's submissions have to land on it (D99).
  const participations = await actingParticipations(db, contest.id, userId);
  if (participations.length === 0) {
    throw new AppError(403, 'contest_not_joined', 'Join this contest before submitting to it.');
  }

  const atMs = at.getTime();
  const open = participations.find((participation) => {
    const { startMs, endMs } = participationWindow(contest, participation);
    return atMs >= startMs && atMs <= endMs;
  });
  // 403 rather than 404: the caller demonstrably knows this contest exists,
  // because they joined it. There is nothing left to conceal, and a 404 here
  // would read as "the contest vanished".
  if (!open) {
    throw new AppError(
      403,
      'contest_window_closed',
      'Your window for this contest has closed.',
    );
  }
  if (open.isDisqualified) {
    throw new AppError(403, 'contest_disqualified', 'You are disqualified from this contest.');
  }

  const contestProblem = (
    await db
      .select({ id: contestProblems.id })
      .from(contestProblems)
      .where(
        and(eq(contestProblems.contestId, contest.id), eq(contestProblems.problemId, problemId)),
      )
      .limit(1)
  )[0];
  // 400, not 404: this caller holds an open participation, so they can see
  // the contest's problem list on the contest page — the pairing is what does
  // not exist, and saying so leaks nothing they cannot already read.
  if (!contestProblem) {
    throw new AppError(
      400,
      'problem_not_in_contest',
      'That problem is not part of this contest.',
    );
  }

  return { participationId: open.id, contestProblemId: contestProblem.id };
}
