/**
 * The scoreboard freeze, reaching the submission routes (D23).
 *
 * D22 froze the *scoreboard* by filtering: a submission made inside a
 * participation's freeze window stops counting toward the board a
 * non-privileged viewer is served. It stopped there. Every such submission
 * still travelled out through `GET /submissions` and `GET /submissions/{id}`
 * with its verdict on it, so the board's silence was decorative — the P1-C
 * report named this hole in its own "Concerns". This file closes it.
 *
 * **Masking, not filtering.** A frozen row is still listed and still answers
 * 200; what is replaced is the part that describes the *outcome*. Dropping the
 * row instead would be a worse lie (a competitor could tell a hidden
 * submission from no submission by paging), and it would break the keyset
 * cursor, which reads `items.at(-1).id` and therefore assumes nothing was
 * removed after the query.
 *
 * The one exception is `?verdict=`: a filter pushed into SQL answers the very
 * question the mask refuses to, nine probes at a time, so a frozen row must
 * match no verdict filter at all. That is why the SQL form below exists —
 * it is the only form that can reach a `WHERE` clause.
 *
 * ## Two forms, one rule
 *
 * | row form (`isSubmissionFrozen`)            | SQL form (`frozenSubmissionsWhere`)                  |
 * |--------------------------------------------|------------------------------------------------------|
 * | `ctx === null` (no contest)                 | `not exists (… contest_submissions …)`               |
 * | `submission.userId === actor.userId`        | `submissions.user_id <> :me`                          |
 * | (no row form — a profile has no one row)    | `actor === null` drops both ownership clauses         |
 * | `isAdmin(actor)`                            | the whole predicate collapses to `false`              |
 * | `ctx.contestCreatedBy === actor.userId`     | `contests.created_by <> :me`                          |
 * | `freezeAtMs(end, F)` / `isFrozenAt(...)`    | `:now >= endsAt − F min AND :now < endsAt`            |
 * | `submission.createdAt >= freezeMs`          | `submissions.created_at >= endsAt − F min`            |
 *
 * The two must agree exactly, and the risky half of that agreement is
 * `endsAt`: the row form gets it from `participationWindow` — i.e. from
 * `@duckoj/contest-formats`' `participationEndMs`, the one derivation the
 * scoreboard and submit-time enforcement already share — while the SQL form
 * restates it as a `CASE`. A second derivation is exactly the split-predicate
 * bug this project has found once per phase, so it is pinned by an agreement
 * test (`apps/api/test/submission-freeze.spec.ts`) that seeds every
 * participation shape — spectating, live ± time limit, virtual ± time limit,
 * no freeze at all — and asserts the two mark the same set.
 */
import { eq, sql, type SQL } from 'drizzle-orm';
import { contestParticipations, contestSubmissions, contests, submissions } from '@duckoj/db/guarded';
import { LIVE, SPECTATE, freezeAtMs, isFrozenAt } from '@duckoj/contest-formats';
import type { Db } from '@duckoj/db';
import type { SubmissionDetailDto, SubmissionSummaryDto } from '@duckoj/contracts';
import { isAdmin, type Actor } from './actor.js';
import { participationWindow } from './participation.js';

/**
 * The three facts beyond ownership that `isSubmissionFrozen` needs, all read
 * off the ONE participation the submission belongs to (`contest_submissions`
 * is unique on `submission_id`). `null`, in the caller's hands, means "this
 * submission is not in a contest", which is the common case and is never
 * frozen.
 */
export interface SubmissionFreezeContext {
  /** The contest's creator: they, like an admin, always see the live data. */
  contestCreatedBy: number;
  /** `contests.frozen_last_minutes`; `0` is no freeze window. */
  frozenLastMinutes: number;
  /**
   * The end of the submission's OWN participation, not of the contest — D22's
   * per-participation clause. A virtual entrant still inside their window
   * stays frozen past the contest's `end_time`, and unfreezes at their own.
   */
  participationEndMs: number;
}

/**
 * Whether `actor` must be shown a masked version of this submission.
 *
 * Ordered ownership-first, like `canViewSubmission`: your own late verdict is
 * yours, and no contest state takes it away — a competitor watching their own
 * submission grade is the normal experience of submitting, not a leak.
 */
export function isSubmissionFrozen(
  actor: Actor,
  submission: { userId: number; createdAt: Date },
  ctx: SubmissionFreezeContext | null,
  now: Date,
): boolean {
  if (ctx === null) return false;
  if (submission.userId === actor.userId) return false;
  if (isAdmin(actor)) return false;
  if (ctx.contestCreatedBy === actor.userId) return false;

  // `freezeAtMs`/`isFrozenAt` rather than the arithmetic: they are the same
  // two functions `lower()` freezes the scoreboard with, including the
  // boundary rule (closed at the freeze instant, open at the end).
  const freezeMs = freezeAtMs(ctx.participationEndMs, ctx.frozenLastMinutes);
  if (!isFrozenAt(now.getTime(), freezeMs, ctx.participationEndMs)) return false;
  // Only submissions made INSIDE the window are hidden. Everything the board
  // already published before it froze stays published — that is what makes
  // this a window rather than a switch.
  return submission.createdAt.getTime() >= freezeMs!;
}

/**
 * The SQL form of `isSubmissionFrozen`, as a boolean expression over the outer
 * `submissions` row. Usable as a selected column (the list's `frozen` flag)
 * and inside a `WHERE` (excluding frozen rows from a `?verdict=` page).
 *
 * The `EXISTS` correlates on `contest_submissions.submission_id`, which is a
 * unique index, so this costs one index probe per row of the page — not a
 * scan, and not a query per row.
 *
 * Takes no `Db`, unlike `visibleSubmissionsWhere`: that one builds its
 * subqueries with the query builder, this one is a single raw expression and
 * a `db` parameter would only be there to look symmetrical.
 */
export function frozenSubmissionsWhere(actor: Actor | null, now: Date): SQL<boolean> {
  // An admin is never masked, so the whole expression collapses rather than
  // being evaluated and then ignored — the same shape `visibleSubmissionsWhere`
  // uses for the clause that makes its own predicate trivially true.
  if (actor !== null && isAdmin(actor)) return sql<boolean>`false`;

  // `participationEndMs`, restated in SQL. Read it beside that function, not
  // alone: spectators take the contest's end, a live entrant is capped by it,
  // and a virtual entrant measures the contest's *duration* from their own
  // start — which is how a virtual attempt legitimately outlives the contest.
  const endsAt = sql`case
      when ${contestParticipations.virtual} = ${SPECTATE} then ${contests.endTime}
      when ${contestParticipations.virtual} = ${LIVE} then
        case
          when ${contests.timeLimitSeconds} is null then ${contests.endTime}
          else least(
            ${contestParticipations.startTime} + ${contests.timeLimitSeconds} * interval '1 second',
            ${contests.endTime}
          )
        end
      else
        case
          when ${contests.timeLimitSeconds} is null
            then ${contestParticipations.startTime} + (${contests.endTime} - ${contests.startTime})
          else ${contestParticipations.startTime} + ${contests.timeLimitSeconds} * interval '1 second'
        end
    end`;
  const freezeAt = sql`((${endsAt}) - ${contests.frozenLastMinutes} * interval '1 minute')`;
  // Cast rather than a bare bind parameter: an untyped parameter compared
  // against a `timestamptz` is resolvable, but only by inference, and this
  // expression is compared three ways.
  const at = sql`${now.toISOString()}::timestamptz`;

  // `null` is an ANONYMOUS viewer, and the two ownership escapes below are
  // the only clauses that mention the actor at all: nobody is the submitter,
  // and nobody is the contest's creator, so both simply drop. Written as
  // omitted conjuncts rather than as `<> -1` against a sentinel id — a
  // sentinel would be a second thing to get right, and `user_id <> -1` reads
  // as a real comparison rather than as "this clause does not apply".
  const notMine = actor === null ? sql`true` : sql`${submissions.userId} <> ${actor.userId}`;
  const notMyContest =
    actor === null ? sql`true` : sql`${contests.createdBy} <> ${actor.userId}`;

  const predicate = sql`(
    ${notMine}
    and exists (
      select 1
      from ${contestSubmissions}
      join ${contestParticipations}
        on ${contestParticipations.id} = ${contestSubmissions.participationId}
      join ${contests} on ${contests.id} = ${contestParticipations.contestId}
      where ${contestSubmissions.submissionId} = ${submissions.id}
        and ${contests.frozenLastMinutes} > 0
        and ${notMyContest}
        and ${at} >= ${freezeAt}
        and ${at} < (${endsAt})
        and ${submissions.createdAt} >= ${freezeAt}
    )
  )`;
  // Wrapped in a second `sql` template, and that is load-bearing rather than
  // cosmetic. When this expression is a SELECTED field of a single-table
  // query, drizzle rewrites every `Column` sitting at the TOP level of the
  // field's chunks into a bare identifier — `"id"`, not `"submissions"."id"`
  // — because a one-table select needs no qualifier. Four tables are in scope
  // inside the `EXISTS` here, so an unqualified `"id"` is ambiguous and
  // Postgres refuses the query outright (`42702`). The rewrite is not
  // recursive: nesting the whole predicate one level down leaves every
  // qualifier intact, in every shape of query this is embedded in.
  return sql<boolean>`${predicate}`;
}

/**
 * The facts for one submission, or `null` when it belongs to no contest.
 *
 * One indexed lookup: `contest_submissions.submission_id` is unique, so this
 * is a probe, and the two joins it hangs off are both primary keys.
 */
export async function loadSubmissionFreezeContext(
  db: Db,
  submissionId: number,
): Promise<SubmissionFreezeContext | null> {
  const [row] = await db
    .select({
      contestId: contests.id,
      contestKey: contests.key,
      startTime: contests.startTime,
      endTime: contests.endTime,
      timeLimitSeconds: contests.timeLimitSeconds,
      frozenLastMinutes: contests.frozenLastMinutes,
      createdBy: contests.createdBy,
      virtual: contestParticipations.virtual,
      participationStart: contestParticipations.startTime,
    })
    .from(contestSubmissions)
    .innerJoin(
      contestParticipations,
      eq(contestParticipations.id, contestSubmissions.participationId),
    )
    .innerJoin(contests, eq(contests.id, contestParticipations.contestId))
    .where(eq(contestSubmissions.submissionId, submissionId))
    .limit(1);
  if (!row) return null;

  // `participationWindow` — the shared derivation, never a fourth copy of it.
  const { endMs } = participationWindow(
    {
      id: row.contestId,
      key: row.contestKey,
      startTime: row.startTime,
      endTime: row.endTime,
      timeLimitSeconds: row.timeLimitSeconds,
    },
    { virtual: row.virtual, startTime: row.participationStart },
  );
  return {
    contestCreatedBy: row.createdBy,
    frozenLastMinutes: row.frozenLastMinutes,
    participationEndMs: endMs,
  };
}

/**
 * What a freeze actually removes, in one place for both routes.
 *
 * `state`, `maxPoints`, `createdAt` and `judgedAt` deliberately survive: they
 * say that somebody submitted and that grading has finished, which the
 * scoreboard's own `pending` count already announces. `compileOutput` does
 * NOT survive — `CE` is a verdict, and a compiler's error text states it in
 * full sentences.
 */
export function maskFrozenSummary(item: SubmissionSummaryDto): SubmissionSummaryDto {
  return { ...item, verdict: null, points: null, frozen: true };
}

export function maskFrozenDetail(detail: SubmissionDetailDto): SubmissionDetailDto {
  return {
    ...detail,
    verdict: null,
    points: null,
    timeMs: null,
    memoryKb: null,
    compileOutput: null,
    cases: [],
    frozen: true,
  };
}
