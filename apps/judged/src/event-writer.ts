import { eq } from 'drizzle-orm';
import { submissions, submissionCases } from '@duckoj/db/guarded';
import type { Db } from '@duckoj/db';
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
    if (job.submissionId === null) return true;

    const submissionId = job.submissionId;
    await this.write(submissionId, job.attempt, event);

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

  private async write(submissionId: number, attempt: number, event: GradingEvent): Promise<void> {
    switch (event.type) {
      case 'dispatched':
        return void (await this.setState(submissionId, 'queued'));
      case 'compiling':
        return void (await this.setState(submissionId, 'compiling'));
      case 'compileMessage':
        return void (await this.db
          .update(submissions)
          .set({ compileOutput: event.message })
          .where(eq(submissions.id, submissionId)));
      case 'compileError':
        return void (await this.db
          .update(submissions)
          .set({
            state: 'done',
            verdict: 'IE',
            compileOutput: event.message,
            points: 0,
            judgedAt: new Date(),
          })
          .where(eq(submissions.id, submissionId)));
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
        await this.setState(submissionId, 'grading');
        return void (await this.db
          .insert(submissionCases)
          .values({
            submissionId,
            attempt,
            groupIndex: event.groupIndex,
            caseIndex: event.caseIndex,
            verdict: event.verdict,
            skipped: event.skipped,
            flags: event.flags,
            timeMs: event.timeMs,
            memoryKb: event.memoryKb,
            points: event.points,
            maxPoints: event.maxPoints,
            feedback: event.feedback,
          })
          // At-least-once delivery means the same case can arrive twice.
          // Colliding harmlessly is the design; failing would be a bug.
          .onConflictDoNothing());
      case 'finished':
        return void (await this.db
          .update(submissions)
          .set({
            state: 'done',
            verdict: event.verdict,
            points: event.points,
            maxPoints: event.maxPoints,
            timeMs: event.timeMs,
            memoryKb: event.memoryKb,
            judgedAt: new Date(),
          })
          .where(eq(submissions.id, submissionId)));
      case 'internalError':
        // The raw message (judge-internal traceback) is operator-only: log
        // it here, and never let it reach `compileOutput`, which `submission
        // .access.ts` returns verbatim to whoever owns the submission.
        console.error(
          JSON.stringify({ msg: 'judge internal error', submissionId, attempt, error: event.message }),
        );
        return void (await this.db
          .update(submissions)
          .set({
            state: 'errored',
            verdict: 'IE',
            compileOutput: GENERIC_INTERNAL_ERROR_MESSAGE,
            judgedAt: new Date(),
          })
          .where(eq(submissions.id, submissionId)));
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
        return void (await this.db
          .update(submissions)
          .set({
            state: 'errored',
            verdict: 'IE',
            compileOutput: GENERIC_INTERNAL_ERROR_MESSAGE,
            judgedAt: new Date(),
          })
          .where(eq(submissions.id, submissionId)));
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

  private async setState(
    submissionId: number,
    state: 'queued' | 'compiling' | 'grading' | 'done' | 'errored',
  ): Promise<void> {
    await this.db.update(submissions).set({ state }).where(eq(submissions.id, submissionId));
  }
}
