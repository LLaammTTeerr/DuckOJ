/**
 * The organiser monitor's per-problem counters (D100) — the arithmetic, in
 * one place, for all three processes that write it.
 *
 * **Why it lives in `@duckoj/db` rather than in `apps/api`.**
 * `reclaimExpiredLeases`'s reason, exactly: two processes need this and
 * neither may import the other. `apps/judged` applies a terminal verdict and
 * must move `pending`/`accepted`/`solvers` with it; `apps/api` mints the
 * contest submission and requeues it. A second hand-written copy of these
 * deltas is precisely the kind of thing that later disagrees with the first
 * about what "pending" means — and a counter that disagrees with itself is
 * worse than the seq scan it replaced, because it is silent.
 *
 * **Every function here takes a `Db` and opens no transaction of its own**
 * (except `recomputeContestStats`, which is nobody's inner step). Each is
 * meant to be called with the caller's transaction handle, so the counter
 * moves if and only if the write it describes commits. Callers hold the lock
 * order `submissions` → `contest_problem_solvers` → `contest_problem_stats`
 * throughout; keep it, or judged and a rejudge running at the same instant
 * can deadlock.
 */
import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/**
 * The `submission_state` values that mean the judge is finished with it.
 *
 * `errored` counts: an internal error or a terminated attempt is not a
 * verdict anyone wants, but the submission is no longer waiting, and leaving
 * it in `pending` forever would make the panel report a queue that does not
 * exist.
 */
const TERMINAL_STATES = new Set(['done', 'errored']);

export function isTerminalSubmissionState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

/** A submission's grading outcome, as the counters care about it. */
export interface SubmissionOutcome {
  state: string;
  verdict: string | null;
}

/**
 * A contest submission has just been created: one more attempt, one more
 * thing the judge owes this problem.
 *
 * Called from inside `SubmissionAccessService.create`'s transaction, next to
 * the `contest_submissions` insert it counts, so a submission and its count
 * are one write or neither.
 *
 * The upsert is not defensive coding: `contest_problem_stats` has no row for
 * a contest problem created after 0037's backfill, and the read side left
 * joins for exactly that reason. A writer that assumed a row would silently
 * count nothing for every problem added since the deploy.
 */
export async function noteContestSubmissionCreated(
  db: Db,
  contestProblemId: number,
): Promise<void> {
  await db.execute(sql`
    insert into contest_problem_stats
      (contest_problem_id, submitted, accepted, solvers, pending, updated_at)
    values (${contestProblemId}, 1, 0, 0, 1, now())
    on conflict (contest_problem_id) do update
       set submitted  = contest_problem_stats.submitted + 1,
           pending    = contest_problem_stats.pending + 1,
           updated_at = now()
  `);
}

/**
 * A submission changed grading outcome: move whatever that implies.
 *
 * Called by `apps/judged`'s `EventWriter` inside the same transaction as the
 * fenced `submissions` UPDATE, and **only when that UPDATE actually matched a
 * row** — a superseded attempt's write matches nothing (the fence), and a
 * counter that moved anyway would drift by one per stale packet.
 *
 * Three deltas, in the order the lock hierarchy demands:
 *
 * - `pending` follows terminality, in either direction, so a state that goes
 *   backwards (it does not today, but `setState` is one call away from it)
 *   cannot leave the count stuck;
 * - `accepted` follows the verdict being `AC`;
 * - `solvers` moves only when `contest_problem_solvers` actually gained a
 *   row. That is the whole reason the set exists: asking "had this person
 *   solved it already?" is a scan of the problem's submissions, on the hot
 *   path of every verdict a province's judges produce.
 *
 * **An `AC` being taken away recomputes instead of decrementing.** It cannot
 * reach here from the ordinary path (a rejudge clears the verdict through
 * `RejudgeService`, which recomputes), so the only ways in are a bug or a
 * new event shape — and guessing whether the person still has another `AC`
 * is exactly the arithmetic that would be wrong. Recomputing one contest
 * problem is bounded by migration 0035's index and is correct by
 * construction.
 */
export async function noteContestVerdict(
  db: Db,
  submissionId: number,
  before: SubmissionOutcome,
  after: SubmissionOutcome,
): Promise<void> {
  // One probe of `contest_submissions_submission_idx` (UNIQUE), and the
  // answer for a practice submission — which is most of them — is "no row",
  // so nothing else here runs at all.
  const [link] = await db.execute<{ contest_problem_id: string; user_id: string }>(sql`
    select cs.contest_problem_id, part.user_id
      from contest_submissions cs
      join contest_participations part on part.id = cs.participation_id
     where cs.submission_id = ${submissionId}
     limit 1
  `);
  if (!link) return;
  const contestProblemId = Number(link.contest_problem_id);
  const userId = Number(link.user_id);

  const pendingDelta =
    (isTerminalSubmissionState(after.state) ? 0 : 1) -
    (isTerminalSubmissionState(before.state) ? 0 : 1);
  const acceptedDelta = (after.verdict === 'AC' ? 1 : 0) - (before.verdict === 'AC' ? 1 : 0);

  if (acceptedDelta < 0) {
    await recomputeContestProblemStats(db, [contestProblemId]);
    return;
  }

  let solversDelta = 0;
  if (acceptedDelta > 0) {
    const inserted = await db.execute<{ user_id: string }>(sql`
      insert into contest_problem_solvers (contest_problem_id, user_id)
      values (${contestProblemId}, ${userId})
      on conflict do nothing
      returning user_id
    `);
    solversDelta = inserted.length > 0 ? 1 : 0;
  }

  if (pendingDelta === 0 && acceptedDelta === 0 && solversDelta === 0) return;
  await applyStatsDelta(db, contestProblemId, { acceptedDelta, solversDelta, pendingDelta });
}

/**
 * `greatest(…, 0)` on every column, and it is a claim rather than paranoia:
 * these counters are only ever read by a monitor, and a negative "pending"
 * would be a number an organiser cannot act on at all. A drift downwards is
 * repaired by `?recompute=1`; a negative number would just be nonsense on
 * the screen until somebody noticed.
 */
async function applyStatsDelta(
  db: Db,
  contestProblemId: number,
  deltas: { acceptedDelta: number; solversDelta: number; pendingDelta: number },
): Promise<void> {
  const { acceptedDelta, solversDelta, pendingDelta } = deltas;
  await db.execute(sql`
    insert into contest_problem_stats
      (contest_problem_id, submitted, accepted, solvers, pending, updated_at)
    values (${contestProblemId}, 0,
            greatest(${acceptedDelta}, 0),
            greatest(${solversDelta}, 0),
            greatest(${pendingDelta}, 0),
            now())
    on conflict (contest_problem_id) do update
       set accepted   = greatest(contest_problem_stats.accepted + ${acceptedDelta}, 0),
           solvers    = greatest(contest_problem_stats.solvers + ${solversDelta}, 0),
           pending    = greatest(contest_problem_stats.pending + ${pendingDelta}, 0),
           updated_at = now()
  `);
}

/**
 * Which contest problems these submissions belong to — what a rejudge needs
 * to know before it can repair anything.
 *
 * Rides `contest_submissions_submission_idx`; a rejudge of a practice-only
 * problem answers with an empty array and the caller does nothing.
 */
export async function contestProblemIdsForSubmissions(
  db: Db,
  submissionIds: number[],
): Promise<number[]> {
  if (submissionIds.length === 0) return [];
  const rows = await db.execute<{ contest_problem_id: string }>(sql`
    select distinct contest_problem_id
      from contest_submissions
     where submission_id = any(${sql.param(submissionIds)}::bigint[])
  `);
  return rows.map((row) => Number(row.contest_problem_id));
}

/**
 * Rebuild these contest problems' counters from the rows themselves.
 *
 * **The repair path, and the one a rejudge takes rather than decrementing.**
 * A requeue can move a verdict in any direction at once — a hundred `AC`s
 * become `null` and then become something else minutes later, one person's
 * only `AC` on a problem disappears while another's does not — and every
 * decrement rule that would have to be right about that is a rule that can
 * be subtly wrong forever. Recomputing is bounded by
 * `contest_submissions_contest_problem_idx` (migration 0035) and is
 * arithmetic-free.
 *
 * Takes the caller's transaction handle: the recompute must be atomic with
 * the requeue it repairs, or a monitor refreshing between the two reads
 * counters describing verdicts that no longer exist.
 */
export async function recomputeContestProblemStats(
  db: Db,
  contestProblemIds: number[],
): Promise<void> {
  if (contestProblemIds.length === 0) return;
  const ids = sql`${sql.param(contestProblemIds)}::bigint[]`;

  // Lock every submission these contest problems own, FIRST — the same
  // `submissions` step at the head of the lock hierarchy every incremental
  // writer takes, which this path used to skip entirely. Without it the two
  // reads below run on a plain snapshot: a `judged` `writeTerminal` that
  // commits its verdict (and its own counter delta) between this snapshot and
  // the absolute `SET = excluded` upsert is then silently overwritten —
  // `accepted`/`solvers` drift DOWN by that verdict and the cached `solvers`
  // stops matching the set it counts, until the next recompute. Locking the
  // rows makes such a write either land before the snapshot or wait until this
  // transaction commits and then apply its delta on the recomputed base.
  await db.execute(sql`
    select s.id
      from contest_submissions cs
      join submissions s on s.id = cs.submission_id
     where cs.contest_problem_id = any(${ids})
     for update of s
  `);

  // The set first, then its cached count — the same order every incremental
  // writer takes, so the two paths cannot deadlock against each other.
  await db.execute(sql`
    delete from contest_problem_solvers where contest_problem_id = any(${ids})
  `);
  await db.execute(sql`
    insert into contest_problem_solvers (contest_problem_id, user_id)
    select cs.contest_problem_id, part.user_id
      from contest_submissions cs
      join submissions s               on s.id = cs.submission_id
      join contest_participations part on part.id = cs.participation_id
     where cs.contest_problem_id = any(${ids})
       and s.verdict = 'AC'
     group by cs.contest_problem_id, part.user_id
    -- Idempotent under a concurrent recompute of the same problem (an
    -- organiser's ?recompute=1 while a whole-problem rejudge recomputes, or
    -- two organisers at once): the incremental writer's insert already carries
    -- this, and without it here the second recompute's DELETE cannot see the
    -- first's uncommitted rows, re-inserts them, and dies on the primary key —
    -- 500ing the repair button at the one moment it is needed.
    on conflict do nothing
  `);
  await db.execute(sql`
    insert into contest_problem_stats
      (contest_problem_id, submitted, accepted, solvers, pending, updated_at)
    select cp.id,
           count(cs.id),
           count(*) filter (where s.verdict = 'AC'),
           count(distinct part.user_id) filter (where s.verdict = 'AC'),
           count(*) filter (where cs.id is not null and s.state not in ('done', 'errored')),
           now()
      from contest_problems cp
      left join contest_submissions cs      on cs.contest_problem_id = cp.id
      left join submissions s               on s.id = cs.submission_id
      left join contest_participations part on part.id = cs.participation_id
     where cp.id = any(${ids})
     group by cp.id
    on conflict (contest_problem_id) do update
       set submitted  = excluded.submitted,
           accepted   = excluded.accepted,
           solvers    = excluded.solvers,
           pending    = excluded.pending,
           updated_at = now()
  `);
}

/**
 * Rebuild every counter of one contest, and say how many problems it
 * rebuilt — the organiser's `?recompute=1`.
 *
 * Opens its own transaction, unlike everything above: this one is nobody's
 * inner step. It is the escape hatch that makes the whole design safe to
 * ship — a counter that has drifted for any reason at all (a crashed judge
 * mid-transaction on a future code path, a hand-written UPDATE during an
 * incident) is repaired by one organiser pressing one button, without an
 * operator, a migration, or a deploy.
 */
export async function recomputeContestStats(db: Db, contestId: number): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    select id from contest_problems where contest_id = ${contestId} order by id
  `);
  const ids = rows.map((row) => Number(row.id));
  if (ids.length === 0) return 0;
  await db.transaction(async (tx) => {
    await recomputeContestProblemStats(tx as Db, ids);
  });
  return ids.length;
}
