import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/**
 * Requeues every job whose lease lapsed while it was still leased, and hands
 * back the ids it moved.
 *
 * **Why this lives in `@duckoj/db` rather than in `apps/judged`'s `JobStore`
 * (D47).** Two processes need it and neither may import the other: judged's
 * worker pool owns the lease, and the API's admin dashboard owns the button
 * that sweeps one up when a judge died mid-grade. `grading_jobs` is not a
 * guarded table, so the API can reach it without going through `authz/**` —
 * but a second hand-written copy of this UPDATE is exactly the kind of thing
 * that later disagrees with the first about what "expired" means. One
 * statement, one definition, both callers.
 *
 * **Why it bumps `attempt`.** `claim` already treats an expired lease as
 * claimable, so requeueing alone would be nearly a no-op. The bump is the
 * point: `(id, attempt)` is the fencing token every event write consults
 * (`isCurrentAttempt`), so incrementing it here cuts off a judge that kept
 * working past its lease the INSTANT an operator reclaims, instead of at
 * whatever later moment somebody happens to claim the row. Nothing keys on
 * attempt numbers being contiguous — `submission_cases` merely wants them
 * distinct, and verdict folding reads the highest.
 *
 * **`state = 'leased'` is load-bearing in the WHERE.** A `done` or `failed`
 * row can still carry an old `lease_until` in the past; matching on the
 * timestamp alone would resurrect finished jobs forever.
 */
export async function reclaimExpiredLeases(db: Db): Promise<number[]> {
  const rows = await db.execute<{ id: number }>(sql`
    update grading_jobs
       set state       = 'queued',
           attempt     = attempt + 1,
           worker_id   = null,
           lease_until = null
     where state = 'leased' and lease_until < now()
    returning id
  `);
  return rows.map((r) => Number(r.id));
}
