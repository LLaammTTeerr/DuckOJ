import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { submissionCases, submissions } from '@duckoj/db/guarded';
import { summariseCases } from '@duckoj/contest-formats';

import { noteContestVerdict, schema, type Db } from '@duckoj/db';
import type { GradingEvent } from '@duckoj/judge-protocol';
import type { ClaimedJob } from './job-store.js';
import type { JobStore } from './job-store.js';
import type { SubmissionEvents } from './submission-events.js';

/**
 * Written to `compileOutput` for `internalError` and `terminated` instead of
 * the judge's own message (or, for `terminated`, instead of leaving the
 * field blank). judge-server populates `internalError` with its own Python
 * traceback — file paths, module names, internal state — none of which is
 * fit to hand to the submitting user, and a `terminated` attempt has no
 * judge-provided explanation at all. The raw `internalError` message is
 * still logged (see `write` below) where an operator can reach it; only the
 * client-facing payload is generic.
 */
const GENERIC_INTERNAL_ERROR_MESSAGE =
  'Grading failed due to an internal judge error. This has been logged for investigation.';

export class EventWriter {
  constructor(
    private readonly db: Db,
    private readonly jobs: JobStore,
    private readonly events: SubmissionEvents,
  ) {}

  /**
   * Applies one event. Returns false when the job's attempt has been
   * superseded — the caller should stop feeding events for it.
   */
  async apply(job: ClaimedJob, event: GradingEvent): Promise<boolean> {
    if (!(await this.jobs.isCurrentAttempt(job.id, job.attempt))) return false;

    // Before the `submissionId === null` bail below, on purpose: the judge
    // that ran a job is a fact about the GRADING JOB, not about the
    // submission, and a future job kind with no submission still deserves
    // the join (D68). A driver that does not name a node (every in-process
    // double) writes nothing, rather than a guess.
    if (event.type === 'dispatched' && event.node !== undefined) {
      await this.jobs.recordJudgeNode(job.id, job.attempt, event.node);
    }

    if (job.submissionId === null) return true;

    const submissionId = job.submissionId;
    await this.write(submissionId, job, event);

    // Deliberately after `write` resolves, and only once it has resolved
    // successfully: a write that throws never reaches this line, so a
    // constraint violation announces nothing. In the real path `apply` is
    // called with a non-transactional `Db`, so each `write` is a single
    // auto-committed statement and "after write returns" already means
    // "after commit". That equivalence depends on the caller: `apply` must
    // never be invoked from inside a caller-managed transaction, because a
    // later rollback would undo the write after this publish has already
    // fired, and nothing here would know to take it back.
    await this.events.publish(submissionId);
    return true;
  }

  /**
   * The in-statement fence every `submissions` UPDATE below carries.
   *
   * `isCurrentAttempt` above is a separate SELECT — cheap, but check-then-act:
   * a stale attempt whose terminal UPDATE stalls (network partition, TCP
   * retry) can land AFTER the retry's, permanently overwriting the good
   * verdict with `errored`/`IE`. Folding the attempt check into the UPDATE's
   * own WHERE makes a superseded write match zero rows instead — the check
   * and the act become one statement, which is the only place a fence holds.
   */
  private fencedById(submissionId: number, job: ClaimedJob) {
    return and(
      eq(submissions.id, submissionId),
      sql`(select ${schema.gradingJobs.attempt} from ${schema.gradingJobs} where ${schema.gradingJobs.id} = ${job.id}) = ${job.attempt}`,
    );
  }

  private async write(submissionId: number, job: ClaimedJob, event: GradingEvent): Promise<void> {
    const attempt = job.attempt;
    switch (event.type) {
      case 'dispatched':
        return void (await this.setState(submissionId, job, 'queued'));
      case 'compiling':
        return void (await this.setState(submissionId, job, 'compiling'));
      case 'compileMessage':
        return void (await this.db
          .update(submissions)
          .set({ compileOutput: event.message })
          .where(this.fencedById(submissionId, job)));
      case 'compileError':
        return void (await this.writeTerminal(submissionId, job, {
          state: 'done',
          verdict: 'CE',
          compileOutput: event.message,
          points: 0,
          judgedAt: new Date(),
        }));
      case 'caseResult':
        // The first case result is the only signal that grading has actually
        // started running tests, as opposed to still compiling — without
        // this, `state` jumps straight from `compiling` to `done` and the UI
        // shows "Compiling" for the submission's entire run. Idempotent
        // (every subsequent case result re-sets the same value), and safe to
        // do unconditionally: within one attempt, `DmojDriver`'s `translate`
        // chain processes packets strictly in the order judge-server sends
        // them, so a case result can never arrive after `finished` has
        // already moved this submission to `done`.
        await this.setState(submissionId, job, 'grading');
        // Fenced in the statement, exactly as every `submissions` UPDATE above
        // is — final review's m7. `isCurrentAttempt` at the top of `apply` is a
        // separate SELECT, so this used to be check-then-act: `requeueAll`
        // bumps this job's `attempt` and DELETEs the old case rows, and a stale
        // insert landing in that gap re-created them. `getVisible` picks the
        // attempt by `max(attempt)`, so until the re-claim's first case the UI
        // showed the superseded attempt's per-case verdicts beside a `queued`
        // submission. A `WHERE` on the same subselect makes a superseded insert
        // match zero rows instead.
        //
        // `on conflict do nothing` is kept: at-least-once delivery means the
        // same case can arrive twice, and colliding harmlessly is the design.
        return void (await this.db.execute(sql`
          insert into submission_cases
            (submission_id, attempt, group_index, case_index, verdict, skipped,
             flags, time_ms, memory_kb, points, max_points, feedback)
          select ${submissionId}, ${attempt}, ${event.groupIndex}, ${event.caseIndex},
                 ${event.verdict}::case_verdict, ${event.skipped},
                 ${sql.param(event.flags)}::text[], ${event.timeMs}, ${event.memoryKb},
                 ${event.points}, ${event.maxPoints}, ${event.feedback}
           where (select attempt from grading_jobs where id = ${job.id}) = ${attempt}
          on conflict do nothing
        `));
      case 'finished':
        return void (await this.writeTerminal(submissionId, job, {
          state: 'done',
          verdict: event.verdict,
          points: event.points,
          maxPoints: event.maxPoints,
          timeMs: event.timeMs,
          memoryKb: event.memoryKb,
          judgedAt: new Date(),
        }));
      case 'internalError':
        // The raw message (judge-internal traceback) is operator-only: log
        // it here, and never let it reach `compileOutput`, which `submission
        // .access.ts` returns verbatim to whoever owns the submission.
        console.error(
          JSON.stringify({ msg: 'judge internal error', submissionId, attempt, error: event.message }),
        );
        return void (await this.writeTerminal(submissionId, job, {
          state: 'errored',
          verdict: 'IE',
          compileOutput: GENERIC_INTERNAL_ERROR_MESSAGE,
          judgedAt: new Date(),
        }));
      case 'terminated':
        // Not a requeue: `worker.ts` already treats `terminated` as terminal
        // — it resolves the dispatch promise and calls `jobs.complete`, so
        // the grading job ends up `done` regardless of what this writes. If
        // this set the submission back to `queued`, nothing would ever claim
        // it again (the job is already done) and the UI would show "Queued"
        // forever. `errored`/`IE` mirrors `internalError`'s precedent: an
        // abnormal halt is not a real graded outcome, but it must still land
        // on a state a user can understand. `compileOutput` reuses the same
        // generic message as `internalError` — a terminated attempt has no
        // judge-provided explanation of its own, and the field must never be
        // left blank, which reads to the user as an unexplained "Errored".
        return void (await this.writeTerminal(submissionId, job, {
          state: 'errored',
          verdict: 'IE',
          compileOutput: GENERIC_INTERNAL_ERROR_MESSAGE,
          judgedAt: new Date(),
        }));
      default: {
        // Exhaustiveness guard: `noImplicitReturns` is not part of the
        // `strict` family, so without this, a new `GradingEvent` variant
        // would fall off the end of the switch, compile cleanly, perform no
        // write, and `apply` would still return true and still publish —
        // announcing state that was never persisted. This turns that into a
        // compile error at the switch instead.
        const _exhaustive: never = event;
        throw new Error(`unhandled grading event: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /**
   * Every write that ENDS a submission's grading, and the only place D100's
   * counters move from this process.
   *
   * Four events land here — `compileError`, `finished`, `internalError`,
   * `terminated` — and all four have to be transactional now, because the
   * monitor's per-problem panel no longer aggregates `contest_submissions`:
   * it reads counters, and a verdict that landed without its counter (or a
   * counter without its verdict) is a panel that is permanently wrong by one,
   * with nothing left in the database to notice the drift.
   *
   * **The prior outcome is read `for update` inside the same transaction**,
   * because the delta depends on it: `pending` moves only if this submission
   * was NOT already terminal, and `accepted` moves only if it was not already
   * `AC`. Reading it outside the transaction would be check-then-act on
   * exactly the row two attempts can race for.
   *
   * **The deltas apply only when the fenced UPDATE actually matched a row.**
   * `fencedById` makes a superseded attempt's write match nothing (that is
   * the whole point of the fence), and a counter that moved anyway would
   * drift by one for every stale packet a partitioned judge eventually
   * delivers. `.returning()` is how this method knows.
   *
   * Wrapping this in a transaction keeps `apply`'s contract intact rather
   * than breaking it: "after `write` resolves" still means "after commit",
   * which is what makes publishing afterwards safe. What `apply` must still
   * never do is run inside a caller-managed transaction.
   */
  private async writeTerminal(
    submissionId: number,
    job: ClaimedJob,
    values: { state: 'done' | 'errored'; verdict: string } & Record<string, unknown>,
  ): Promise<void> {
    const { attempt } = job;
    await this.db.transaction(async (tx) => {
      const [before] = await tx
        .select({ state: submissions.state, verdict: submissions.verdict })
        .from(submissions)
        .where(eq(submissions.id, submissionId))
        .for('update');
      if (!before) return;

      // D165. The summary is written by the SAME fenced UPDATE that writes the
      // verdict, from the cases this attempt actually graded, read inside this
      // transaction. Three properties fall out of that placement and none of
      // them would survive a separate statement:
      //
      // - it inherits D29's fencing for free — a superseded attempt's write
      //   matches no row, so it can neither set a verdict nor a summary;
      // - there is no window in which a submission is terminal with a verdict
      //   and no summary, or the reverse;
      // - it is `summariseCases` — the same function the scoreboard fold would
      //   have applied to the same rows in the same order — so equality with
      //   the fold it replaces is by construction rather than by test. The
      //   silent counter drift the rejudge path once had was drift in state
      //   that was INCREMENTED; this is state that is REPLACED, from its own
      //   source, in one statement.
      const cases = await tx
        .select({
          groupIndex: submissionCases.groupIndex,
          points: submissionCases.points,
          maxPoints: submissionCases.maxPoints,
        })
        .from(submissionCases)
        .where(
          and(eq(submissionCases.submissionId, submissionId), eq(submissionCases.attempt, attempt)),
        )
        .orderBy(asc(submissionCases.id));

      const applied = await tx
        .update(submissions)
        .set({
          ...(values as Partial<typeof submissions.$inferInsert>),
          subtaskSummary: summariseCases(
            cases.map((row) => ({
              batch: row.groupIndex,
              // `case` and `status` are required by `TestCaseSpec` and read by
              // nothing: the summariser only ever looks at the batch and the
              // two point values. Filling them with constants is honest here
              // in a way it would not be if anything downstream read them.
              case: 0,
              points: row.points,
              total: row.maxPoints,
              status: 'AC',
            })),
          ),
        })
        .where(this.fencedById(submissionId, job))
        .returning({ id: submissions.id });
      if (applied.length === 0) return;

      // D167. Every other reader of these rows picks the latest attempt
      // PRESENT rather than the attempt that graded: `getVisible`'s
      // `max(attempt)` (`submission.access.ts`), the fold's residue read
      // (`loadSubtasksFromCases`), and migration 0045's backfill all do.
      // `JobStore.claim` bumps `attempt` on EVERY claim and deletes nothing,
      // so an attempt that ends having graded no case at all — an unhealthy
      // judge answering `internalError` one lease after it abandoned the
      // previous attempt — leaves a superseded attempt answering
      // `max(attempt)`. The summary then says 0 while every other reader says
      // whatever the dead attempt reached: the scoreboard and the submission
      // page disagreeing about one submission, which is D36's shape.
      //
      // Dropping the superseded rows here makes `max(attempt)` and
      // `job.attempt` the same number for every terminal submission, which is
      // the invariant that lets the summary be an OPTIMISATION of the residue
      // read rather than a second answer to the same question. Same reasoning
      // as `requeueAll`'s own DELETE — no reader has ever wanted a superseded
      // attempt's rows — and after the fence for the same reason the counters
      // are: a superseded write must touch nothing.
      await tx
        .delete(submissionCases)
        .where(
          and(eq(submissionCases.submissionId, submissionId), lt(submissionCases.attempt, attempt)),
        );

      await noteContestVerdict(tx as unknown as Db, submissionId, before, {
        state: values.state,
        verdict: values.verdict,
      });
    });
  }

  private async setState(
    submissionId: number,
    job: ClaimedJob,
    state: 'queued' | 'compiling' | 'grading' | 'done' | 'errored',
  ): Promise<void> {
    await this.db.update(submissions).set({ state }).where(this.fencedById(submissionId, job));
  }
}
