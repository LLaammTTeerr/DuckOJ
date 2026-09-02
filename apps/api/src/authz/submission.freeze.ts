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
 * | `ctx.viewerOwnsViaTeam` (D117)              | `(actingParticipationWhere) is not true`              |
 * | (no row form — a profile has no one row)    | `actor === null` drops the ownership clauses          |
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
 *
 * ## The other contest-window rule (D27)
 *
 * `isContestSourceHidden` at the bottom of this file is NOT the freeze — it
 * has no freeze window, no `frozen_last_minutes`, and it runs for a
 * participation's whole duration. It lives here anyway, deliberately: it
 * needs the same participation end instant, off the same
 * `SubmissionFreezeContext`, loaded by the same `loadSubmissionFreezeContext`
 * probe. A second derivation of `participationEndMs` in a second file is the
 * split-predicate bug this project has found once per phase, and one shared
 * context is what stops the two rules disagreeing about when a contest is
 * over.
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { contestParticipations, contestSubmissions, contests, submissions } from '@duckoj/db/guarded';
import { LIVE, SPECTATE, freezeAtMs, isFrozenAt } from '@duckoj/contest-formats';
import type { Db } from '@duckoj/db';
import type { SubmissionDetailDto, SubmissionSummaryDto } from '@duckoj/contracts';
import { isAdmin, type Actor } from './actor.js';
import { actingParticipationWhere } from './problem.visibility.js';
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
  /**
   * Whether this submission belongs to a participation the viewer ACTS on —
   * their own row, or one held by a team they are on (D117). A team's own
   * submissions are never frozen from a member and never source-hidden from
   * them: the team made them. The row twin of the `is not true` team escape
   * inside `frozenSubmissionsWhere`, resolved through the same sanctioned
   * `actingParticipationWhere` predicate (D113).
   */
  viewerOwnsViaTeam: boolean;
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
  // The viewer's own team's submission, never frozen from them (D117): the
  // team made it. Ordered beside ownership, for the same reason.
  if (ctx.viewerOwnsViaTeam) return false;
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
 * `participationEndMs`, restated in SQL, over a `contest_participations` row
 * joined to its `contests` row.
 *
 * Read it beside that function, not alone: spectators take the contest's end,
 * a live entrant is capped by it, and a virtual entrant measures the
 * contest's *duration* from their own start — which is how a virtual attempt
 * legitimately outlives the contest.
 *
 * Called by `frozenSubmissionsWhere` below, by `upcomingContests`, and — this
 * is the part that matters since D194 — it is the DEFINITION that
 * `contest_participations.ends_at` materialises. Migration 0048's trigger
 * carries a transcription of this `CASE`, and `participation-ends-at.spec.ts`
 * asserts the stored column equals what this function emits over every
 * participation shape and after a contest edit moves any of the three inputs.
 * A second transcription of this rule left unpinned is the split-predicate bug
 * this project has found once per phase, and the D49 statistics need exactly
 * the same instant the freeze does.
 */
export function participationEndsAtSql(): SQL {
  return sql`case
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
}

/**
 * D49 — whether this submission belongs to a contest participation whose
 * window is **still open** at `now`, as a boolean expression over the outer
 * `submissions` row.
 *
 * The statistics exclude exactly these, for every viewer including admins.
 * That uniformity is the point: an acceptance rate is a difficulty hint of
 * the same family D35 withholds from a room still solving, and a per-viewer
 * answer would make the 30 s cache key a per-viewer key — four caches with
 * four miss rates, and a mask that has to be reapplied identically in five
 * places or it leaks in one.
 *
 * Open-ended at the start and closed at the end, matching
 * `isContestSourceHidden` and `participationEndMs` everywhere else: at
 * `now === end` the window is over and the submission joins the statistics,
 * the same instant its source is released and its board unfreezes.
 *
 * ## Why it reads a column and not the `CASE` (D194)
 *
 * The rule is unchanged; only the way the planner is told about it is. Until
 * migration 0048 this `EXISTS` joined `contest_submissions ⋈
 * contest_participations ⋈ contests` and applied `now < <CASE>` after the
 * join. Postgres has no selectivity estimate for that `CASE` — it falls back
 * to a third of the table — so on five hot statements it either hashed **all
 * of** `contest_submissions` (O(every contest submission the deployment has
 * ever taken)) or, once the table was a season deep, walked three index
 * probes per row of the page instead. Neither is bounded by how much contest
 * activity is happening NOW, which is the only thing this predicate is about.
 *
 * `contest_participations.ends_at` is the same instant, materialised, with a
 * btree index over it, so "whose window is open at `now`" is a range scan
 * returning the participations actually running — a couple of thousand during
 * a province round and none the rest of the year — and the anti-join is driven
 * from that. Measured at 496 240 contest submissions with nothing running:
 * one problem's statistics went from 19 201 buffers to 480.
 *
 * The `IN (subquery)` form rather than a join is deliberate, and it is what
 * makes the shape stable: written as a join, the planner is free to scan
 * `contest_submissions` and hash the small side onto it (measured — it does),
 * because it prices a sequential read of a narrow table below two thousand
 * index descents. Written as a semi-join into a set it drives from the set.
 * `contest_submissions.participation_id` is `NOT NULL` with a foreign key, so
 * the two forms select exactly the same rows.
 *
 * It mentions `contest_participations.id` and no `user_id`, so D113's
 * source-scan guard has nothing to say about it.
 */
export function contestWindowOpenWhere(now: Date): SQL<boolean> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const predicate = sql`exists (
    select 1
    from ${contestSubmissions}
    where ${contestSubmissions.submissionId} = ${submissions.id}
      and ${contestSubmissions.participationId} in (
        select ${contestParticipations.id}
        from ${contestParticipations}
        where ${contestParticipations.endsAt} > ${at}
      )
  )`;
  // Wrapped a second time for the reason `frozenSubmissionsWhere` documents
  // at length: drizzle rewrites a top-level `Column` in a single-table
  // select into a bare identifier, and three tables are in scope inside this
  // `EXISTS`.
  return sql<boolean>`${predicate}`;
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
 * Takes a `Db` since D117: the team escape below reuses
 * `actingParticipationWhere`, the sanctioned participation predicate (D113),
 * which builds a `team_members` subquery with the query builder — the same
 * reason `visibleSubmissionsWhere` takes one. Everything else here is still a
 * single raw expression.
 */
export function frozenSubmissionsWhere(db: Db, actor: Actor | null, now: Date): SQL<boolean> {
  // An admin is never masked, so the whole expression collapses rather than
  // being evaluated and then ignored — the same shape `visibleSubmissionsWhere`
  // uses for the clause that makes its own predicate trivially true.
  if (actor !== null && isAdmin(actor)) return sql<boolean>`false`;

  const endsAt = participationEndsAtSql();
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
  // D117: a member's own team's submissions are never frozen from them. The
  // conjunct is `(<acting predicate>) IS NOT TRUE`, deliberately not
  // `NOT (<acting predicate>)`: the predicate is `user_id = me OR team_id IN
  // (my teams)`, and for someone ELSE's individual entry `team_id` is NULL, so
  // once the viewer holds any team membership the `IN` is `NULL` and the whole
  // OR is `NULL` — `NOT NULL` is `NULL`, which would drop the conjunct and
  // unfreeze every stranger's late verdict. `IS NOT TRUE` maps that `NULL`
  // (and `FALSE`) to `TRUE`, so only a genuine team match (predicate `TRUE`)
  // stands the freeze down. Reuses `actingParticipationWhere` (D113); the
  // `contest_participations` row it references is in scope inside the EXISTS.
  const notMyTeam =
    actor === null ? sql`true` : sql`(${actingParticipationWhere(db, actor.userId)}) is not true`;

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
        and ${notMyTeam}
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
 * Two indexed lookups, run in parallel: the window facts (one probe —
 * `contest_submissions.submission_id` is unique and the two joins are primary
 * keys) and the D117 team check (the same unique probe, filtered by the
 * sanctioned participation predicate).
 */
export async function loadSubmissionFreezeContext(
  db: Db,
  actor: Actor,
  submissionId: number,
): Promise<SubmissionFreezeContext | null> {
  const [[row], teamRows] = await Promise.all([
    db
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
      .limit(1),
    // D117: is this submission one the viewer's team made? Same sanctioned
    // `actingParticipationWhere` predicate the visibility gate uses, bounded
    // to this one submission — the positive form is NULL-safe (a stranger's
    // NULL-team row simply fails to match and is excluded by the WHERE).
    db
      .select({ id: contestSubmissions.submissionId })
      .from(contestSubmissions)
      .innerJoin(
        contestParticipations,
        eq(contestParticipations.id, contestSubmissions.participationId),
      )
      .where(
        and(
          eq(contestSubmissions.submissionId, submissionId),
          actingParticipationWhere(db, actor.userId),
        ),
      )
      .limit(1),
  ]);
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
    viewerOwnsViaTeam: teamRows.length > 0,
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
    // D160. `state` survives above and this does not, which is the line
    // between them: `state: 'queued'` says grading has not finished, which
    // the scoreboard's `pending` count already announces. WHY it has not
    // finished is a fact about the fleet, attached to somebody else's
    // in-flight submission — and the viewer it was added for can never be
    // here, because a freeze never applies to a viewer's own submission.
    awaitingCapableJudge: false,
    frozen: true,
  };
}

/**
 * D27 — whether this submission's `source` must be withheld from `actor`
 * because its contest is still running.
 *
 * `source_access = 'solved'` opens a *problem's* solutions to anyone holding
 * an AC on it. That predicate (`canViewSubmission`) knows nothing about
 * contests, so a problem opened for practice and later reused in a contest
 * handed the first competitor to solve it every rival's accepted source, live,
 * for the rest of the contest. This clause closes that without touching
 * `source_access`, which remains the right control for practice.
 *
 * Deliberately NOT part of the freeze:
 *
 * - it applies for the participation's WHOLE window, not its last `F`
 *   minutes, because reading a rival's solution at minute five is worse than
 *   reading their verdict at minute fifty-five;
 * - it applies when `frozen_last_minutes` is 0, i.e. to every contest;
 * - it withholds one field and leaves the submission otherwise intact, so a
 *   viewer entitled to the row still gets the row.
 *
 * The same four escapes as the freeze, in the same order and for the same
 * reasons: your own source is yours, an admin sees everything, and the
 * contest's creator is running the thing.
 */
export function isContestSourceHidden(
  actor: Actor,
  submission: { userId: number },
  ctx: SubmissionFreezeContext | null,
  now: Date,
): boolean {
  if (ctx === null) return false;
  if (submission.userId === actor.userId) return false;
  // A teammate reads the SOURCE of their team's contest submissions live
  // (D117 extends D27's own-source rule to the team): one team is one entity.
  if (ctx.viewerOwnsViaTeam) return false;
  if (isAdmin(actor)) return false;
  if (ctx.contestCreatedBy === actor.userId) return false;
  // Open-ended at the start and closed at the end, matching
  // `participationEndMs` everywhere else: at `now === end` the window is over
  // and the source is released, the same instant the board unfreezes.
  return now.getTime() < ctx.participationEndMs;
}

/** The D27 mask: one field, plus the flag that says it was withheld. */
export function maskHiddenSource(detail: SubmissionDetailDto): SubmissionDetailDto {
  return { ...detail, source: null, sourceHidden: true };
}
