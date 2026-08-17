import { eq } from 'drizzle-orm';
import { submissions, submissionCases } from '@qhhoj/db/guarded';
import type { Db } from '@qhhoj/db';
import type { GradingEvent } from '@qhhoj/judge-protocol';
import type { ClaimedJob } from './job-store.js';
import type { JobStore } from './job-store.js';
import type { SubmissionEvents } from './submission-events.js';

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
        return void (await this.db
          .update(submissions)
          .set({ state: 'errored', verdict: 'IE', compileOutput: event.message, judgedAt: new Date() })
          .where(eq(submissions.id, submissionId)));
      case 'terminated':
        return void (await this.setState(submissionId, 'queued'));
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
