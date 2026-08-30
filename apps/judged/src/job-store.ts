import { and, eq, sql } from 'drizzle-orm';
import { reclaimExpiredLeases, schema, type Db } from '@duckoj/db';

/**
 * How long a claim is valid without a heartbeat.
 *
 * A worker is never *assumed dead* — it is only ever *out of lease*. That
 * distinction is what makes crash recovery a clock comparison rather than a
 * judgement call.
 */
export const LEASE_SECONDS = 60;

/**
 * Everything a driver needs to grade, resolved in one claim.
 *
 * The source and limits are joined here rather than fetched later so that a
 * claim is self-sufficient: the worker never has to go back to the database
 * mid-dispatch, and a submission deleted after claiming cannot leave a job
 * half-dispatched.
 */
export interface ClaimedJob {
  id: number;
  attempt: number;
  submissionId: number | null;
  revisionId: number;
  packageHash: string;
  source: string;
  languageKey: string;
  timeMs: number;
  memoryKb: number;
  /** From the revision; `null` on rows predating the column. */
  testCount: number | null;
}

export class JobStore {
  constructor(private readonly db: Db) {}

  async enqueue(input: {
    revisionId: number;
    packageHash: string;
    submissionId: number | null;
  }): Promise<number> {
    const [row] = await this.db
      .insert(schema.gradingJobs)
      .values({
        revisionId: input.revisionId,
        packageHash: input.packageHash,
        submissionId: input.submissionId,
      })
      .returning({ id: schema.gradingJobs.id });
    return row!.id;
  }

  /**
   * Takes the oldest job that is queued, or leased with an expired lease.
   * `FOR UPDATE SKIP LOCKED` lets several workers claim concurrently without
   * blocking each other or handing out the same row twice.
   *
   * `languages`, when given, restricts the pick to jobs the caller's judge
   * fleet can actually grade (`JudgeDriver.supportedLanguages`). This is a
   * filter on the *pick*, not a check after it, and that ordering is the
   * whole of D68's answer to a heterogeneous fleet: a job claimed and then
   * refused would be re-claimed by the same oldest-first query on the very
   * next turn, forever, starving every job behind it. Filtered out, it
   * simply stays `queued` — claimable the instant a capable judge connects
   * — and `markBlocked` is what makes that visible rather than silent.
   *
   * `undefined` means "no filter", which keeps every caller with a driver
   * that declares nothing (each in-process double) behaving exactly as
   * before. An empty array is a real answer — "the connected judges can run
   * nothing" — and claims nothing but language-less jobs.
   *
   * A job with no language at all (`submission_id` null, or a submission
   * whose language row vanished) is always claimable: `ClaimedJob` falls
   * back to `cpp17` for it, and refusing to claim a job on the strength of a
   * language nobody recorded would hide it from the queue with no way to
   * ever get it back.
   */
  async claim(workerId: string, languages?: string[]): Promise<ClaimedJob | null> {
    // `sql.raw('true')` rather than an omitted clause: the predicate has to
    // be one expression either way, and a boolean literal is not a parameter
    // an injection could reach.
    const languageFilter =
      languages === undefined
        ? sql`true`
        : sql`(languages.key is null or languages.key = any(${sql.param(languages)}::text[]))`;
    const rows = await this.db.execute<{
      id: number;
      attempt: number;
      submission_id: number | null;
      revision_id: number;
      package_hash: string;
      source: string | null;
      language_key: string | null;
      revision_time_ms: number | null;
      revision_memory_kb: number | null;
      revision_test_count: number | null;
    }>(sql`
      with claimed as (
        update grading_jobs
           set state       = 'leased',
               attempt     = attempt + 1,
               worker_id   = ${workerId},
               -- Being claimed disproves whatever this said: the row was only
               -- ever marked because no connected judge could run it, and the
               -- language filter above means the claimant can (D68). Cleared
               -- here rather than by a second statement so the flag and the
               -- state can never disagree.
               blocked_reason = null,
               lease_until = now() + interval '${sql.raw(String(LEASE_SECONDS))} seconds'
         where id = (
           select grading_jobs.id from grading_jobs
            -- LEFT, both of them: a job with no submission (a future
            -- invocation kind) and a submission whose language row is gone
            -- must still be claimable, so neither join may drop a row.
            left join submissions on submissions.id = grading_jobs.submission_id
            left join languages   on languages.id   = submissions.language_id
            where (grading_jobs.state = 'queued'
               or (grading_jobs.state = 'leased' and grading_jobs.lease_until < now()))
              and ${languageFilter}
            order by grading_jobs.created_at
            limit 1
            -- "of grading_jobs", not a bare FOR UPDATE: Postgres refuses to
            -- lock the nullable side of an outer join, and the rows worth
            -- locking are the ones being updated anyway.
            --
            -- Throughput only: removing SKIP LOCKED was checked empirically
            -- and left every asserted outcome unchanged (a blocked claimant
            -- just waits, then gets the next row). Not covered by any test.
            for update of grading_jobs skip locked
         )
        returning id, attempt, submission_id, revision_id, package_hash
      )
      select claimed.*, submissions.source, languages.key as language_key,
             problem_revisions.time_ms   as revision_time_ms,
             problem_revisions.memory_kb as revision_memory_kb,
             problem_revisions.test_count as revision_test_count
        from claimed
        left join submissions       on submissions.id       = claimed.submission_id
        left join languages         on languages.id         = submissions.language_id
        left join problem_revisions on problem_revisions.id = claimed.revision_id
    `);

    const row = rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      attempt: Number(row.attempt),
      submissionId: row.submission_id === null ? null : Number(row.submission_id),
      revisionId: Number(row.revision_id),
      packageHash: row.package_hash,
      source: row.source ?? '',
      languageKey: row.language_key ?? 'cpp17',
      // The revision's own limits — the constants this replaced ("Phase 1
      // fixes these at 1000 ms / 65536 KB") had quietly outlived the phase:
      // a problem declaring 2000 ms displayed 2000 everywhere and GRADED at
      // 1000. The fallbacks only cover a revision predating the columns.
      timeMs: row.revision_time_ms === null ? 1000 : Number(row.revision_time_ms),
      memoryKb: row.revision_memory_kb === null ? 65536 : Number(row.revision_memory_kb),
      testCount: row.revision_test_count === null ? null : Number(row.revision_test_count),
    };
  }

  /**
   * Records which judge node this attempt went to — the node↔job join
   * `judge_nodes` never had (D47's report: "no column relates them").
   *
   * Fenced on `(id, attempt)` like every other write here, so a `dispatched`
   * event from a superseded attempt cannot relabel the retry's row with the
   * judge that dropped it.
   *
   * A name matching no `judge_nodes` row leaves the column alone rather than
   * nulling it: the only way that happens is an operator deleting a node
   * mid-grade, and forgetting which judge is running the job is strictly
   * worse than remembering a stale one. Returns whether anything was written.
   */
  async recordJudgeNode(jobId: number, attempt: number, nodeName: string): Promise<boolean> {
    const rows = await this.db.execute<{ id: number }>(sql`
      update grading_jobs
         set judge_node_id = (select id from judge_nodes where name = ${nodeName})
       where id = ${jobId}
         and attempt = ${attempt}
         and exists (select 1 from judge_nodes where name = ${nodeName})
      returning id
    `);
    return rows.length > 0;
  }

  /**
   * Reconciles `blocked_reason` across the queue against what the fleet can
   * currently grade: a queued job in a language no connected judge speaks is
   * marked with the reason, and one that becomes runnable is unmarked. Both
   * directions in one idempotent statement, because a flag that is only ever
   * set is a flag that lies as soon as the missing judge arrives.
   *
   * Returns the ids whose value actually changed — nothing on a steady
   * queue, so a caller may log every result without producing a heartbeat of
   * noise.
   *
   * Deliberately NOT a claim-time check (D68): `claim` filters these rows out
   * of the pick, so nothing here affects what runs. This exists purely so an
   * operator watching a stuck queue is told *why* instead of seeing jobs sit
   * at `queued` with a healthy judge connected.
   */
  async markBlocked(languages: string[]): Promise<number[]> {
    const rows = await this.db.execute<{ id: number }>(sql`
      update grading_jobs
         set blocked_reason = want.reason
        from (
          select grading_jobs.id as id,
                 case when languages.key = any(${sql.param(languages)}::text[]) then null
                      else 'no connected judge supports language ' || languages.key
                 end as reason
            from grading_jobs
            join submissions on submissions.id = grading_jobs.submission_id
            join languages   on languages.id   = submissions.language_id
           where grading_jobs.state = 'queued'
        ) as want
       where want.id = grading_jobs.id
         -- "is distinct from", not "<>": both sides are nullable, and the
         -- whole point is to touch only the rows whose answer changed.
         and grading_jobs.blocked_reason is distinct from want.reason
      returning grading_jobs.id
    `);
    return rows.map((row) => Number(row.id));
  }

  /** Extends the lease. Returns false when this attempt has been superseded. */
  async heartbeat(jobId: number, attempt: number): Promise<boolean> {
    const rows = await this.db.execute<{ id: number }>(sql`
      update grading_jobs
         set lease_until = now() + interval '${sql.raw(String(LEASE_SECONDS))} seconds'
       where id = ${jobId} and attempt = ${attempt} and state = 'leased'
      returning id
    `);
    return rows.length > 0;
  }

  /**
   * Hands a leased job straight back to the queue, without waiting for its
   * lease to lapse.
   *
   * The lease exists because a worker is never *assumed dead* — it is only
   * ever out of lease. Releasing is the one case where that inference is not
   * needed: the worker is alive, it is the thing calling, and it knows the
   * judge holding the job is gone (`JudgeDriver`'s `abandon` channel). Making
   * it wait `LEASE_SECONDS` for a fact it already has just makes a student
   * watch a spinner for another minute.
   *
   * `attempt` is bumped for exactly the reason `reclaimExpiredLeases` bumps
   * it: `(id, attempt)` is the fencing token every event write consults, so
   * moving it here cuts off any straggler packet from the old attempt the
   * instant the job is requeued, instead of trusting that the vanished judge
   * really has vanished.
   *
   * Fenced on `(id, attempt, state='leased')` like `complete`, so a release
   * for a superseded attempt matches zero rows rather than requeueing
   * somebody else's live grade.
   */
  async release(jobId: number, attempt: number): Promise<boolean> {
    const rows = await this.db.execute<{ id: number }>(sql`
      update grading_jobs
         set state       = 'queued',
             attempt     = attempt + 1,
             worker_id   = null,
             lease_until = null
       where id = ${jobId} and attempt = ${attempt} and state = 'leased'
      returning id
    `);
    return rows.length > 0;
  }

  async complete(jobId: number, attempt: number): Promise<boolean> {
    const rows = await this.db.execute<{ id: number }>(sql`
      update grading_jobs
         set state = 'done', lease_until = null
       where id = ${jobId} and attempt = ${attempt} and state = 'leased'
      returning id
    `);
    return rows.length > 0;
  }

  /**
   * The fencing check. Every event write consults this: a packet arriving for
   * a superseded attempt is rejected, not merged, so a judge that kept working
   * after we gave its job away cannot overwrite the retry's verdict.
   */
  async isCurrentAttempt(jobId: number, attempt: number): Promise<boolean> {
    const rows = await this.db
      .select({ attempt: schema.gradingJobs.attempt })
      .from(schema.gradingJobs)
      .where(and(eq(schema.gradingJobs.id, jobId), eq(schema.gradingJobs.attempt, attempt)))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Requeues jobs whose lease lapsed while still leased, and returns their
   * ids — their drivers should be told to stop.
   *
   * Delegates to `@duckoj/db`'s `reclaimExpiredLeases` rather than owning
   * the statement, because the API's `POST /admin/grading/reclaim` runs the
   * same sweep from the other process (D47). See that function for why the
   * requeue also bumps `attempt`.
   */
  async reclaimExpired(): Promise<number[]> {
    return reclaimExpiredLeases(this.db);
  }
}
