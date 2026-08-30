/**
 * The admin dashboard's query PLANS (D47 as amended, migration 0025).
 *
 * `admin-dashboard.spec.ts` checks that every panel reports the right
 * numbers. This file checks the thing that file cannot see: that it reports
 * them without reading the whole history of the deployment. D47 shipped three
 * queries that were linear in how much grading had ever happened, on two
 * tables that keep every row forever (D11), behind a page that refreshes
 * every fifteen seconds — a cost that is invisible on a seeded test database
 * and becomes the dominant one on a real judge after a season.
 *
 * **How the red half works.** The indexes live in migration 0025, so a
 * harness database always has them and "run the suite without the migration"
 * is not a thing a spec can ask for. Instead each test DROPs them inside the
 * transaction `withTestDb` is already going to roll back, and asserts the
 * plan on exactly the same rows both ways. That is the mutation check, run on
 * every CI pass rather than once by hand: delete migration 0025 and the
 * "with" assertions fail; write the WHERE clause so it no longer matches an
 * index predicate and they fail too.
 *
 * **Why plans and not timings.** A millisecond threshold on a shared CI box
 * measures the box. `Seq Scan on grading_jobs` measures the query, and it is
 * the exact fact that stops being true as the table grows.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import { problems } from '@duckoj/db/guarded';
import { withTestDb } from './db.harness.js';
import { seedProblemAndLanguage } from './submissions.fixtures.js';

/**
 * Enough rows that an index is genuinely the cheaper plan.
 *
 * The planner is not being tricked here, it is being informed, and the
 * number had to be measured rather than guessed. Below a few thousand rows a
 * sequential scan really IS faster than an index descent, so a spec that
 * seeded fifty rows would assert `Seq Scan` in both directions and prove
 * nothing. At 30 000 the throughput join still (correctly) prefers to hash
 * 30 000 job rows rather than make 280 index descents — measured, that plan
 * runs in 4.8 ms. 100 000 is where the choice flips, which is the scale at
 * which the unbounded version starts costing what this migration exists to
 * stop it costing. D47's amendment quotes 200 000.
 */
const ROWS = 100_000;

/**
 * How far apart the seeded submissions are in time.
 *
 * Not cosmetic. The throughput panel windows on the last hour, and the plan
 * it gets depends entirely on what FRACTION of the table that hour is: seed
 * 30 000 rows one second apart and the "last hour" is 12% of everything,
 * where a hash join really is the cheaper plan and the assertions below fail
 * for a reason that has nothing to do with the code under test. Thirteen
 * seconds spreads 30 000 rows over four and a half days, so an hour is ~280
 * rows — the shape a judge's history actually has, and the shape the 200 000
 * row measurement in D47's amendment was taken on.
 */
const SECONDS_APART = 13;

/**
 * One failure, and it is OLD — row 500 of 30 000.
 *
 * This is the distribution that matters and the one the original spec never
 * had. An internal error is an infrastructure failure, not a wrong answer, so
 * a healthy judge produces none for days; the failures panel then walks every
 * clean submission since the last incident to find its twenty rows. The bug
 * gets WORSE the longer judging goes well, which is why seeding failures
 * evenly (as a naive fixture does) hides it completely.
 */
const FAILURE_ROW = 500;

async function seedHistory(db: Db): Promise<void> {
  await seedProblemAndLanguage(db);
  const [problem] = await db
    .select({ id: problems.id, currentRevisionId: problems.currentRevisionId })
    .from(problems);
  const [language] = await db.select({ id: schema.languages.id }).from(schema.languages);
  const [user] = await db.select({ id: schema.users.id }).from(schema.users);
  const problemId = problem!.id;
  const revisionId = problem!.currentRevisionId!;
  const languageId = language!.id;
  const userId = user!.id;

  // Set-based, not 30 000 round trips: the point of this file is to be
  // affordable enough to keep in the suite.
  await db.execute(sql`
    insert into submissions (user_id, problem_id, revision_id, language_id, source, state, verdict, created_at, judged_at)
    select ${userId}, ${problemId}, ${revisionId}, ${languageId}, 'src',
           case when g = ${FAILURE_ROW} then 'errored'::submission_state else 'done'::submission_state end,
           case when g = ${FAILURE_ROW} then 'IE'::case_verdict else 'AC'::case_verdict end,
           now() - make_interval(secs => g * ${SECONDS_APART}),
           now() - make_interval(secs => g * ${SECONDS_APART})
      from generate_series(1, ${ROWS}) g
  `);
  // One grading job per submission, all but a handful finished — the shape
  // D11's "keep the history" leaves behind.
  await db.execute(sql`
    insert into grading_jobs (submission_id, revision_id, package_hash, state, worker_id, lease_until, created_at)
    select s.id, ${revisionId}, 'phase1-aplusb',
           case when s.id % 5000 = 0 then 'queued'::grading_job_state
                when s.id % 5000 = 1 then 'leased'::grading_job_state
                else 'done'::grading_job_state end,
           'worker-' || (s.id % 4),
           case when s.id % 5000 = 1 then now() + interval '30 seconds' else null end,
           s.created_at
      from submissions s
  `);
  // Without this the planner is working from the estimates it had when the
  // tables were empty and will seq-scan whatever it is given. Every EXPLAIN
  // below would then pass for the wrong reason.
  await db.execute(sql`analyze submissions`);
  await db.execute(sql`analyze grading_jobs`);
}

async function plan(db: Db, query: ReturnType<typeof sql>): Promise<string> {
  const rows = await db.execute<{ 'QUERY PLAN': string }>(sql`explain (analyze, costs off) ${query}`);
  return rows.map((row) => row['QUERY PLAN']).join('\n');
}

/**
 * The three statements exactly as `dashboard.access.ts` issues them.
 *
 * Copied, not imported — they are private to the service and `explain` needs
 * the statement, not its result. A copy can drift, and a drifted copy would
 * go on asserting a beautiful plan for SQL nobody runs, so
 * `keeps the service's SQL and this file's copies in step` below reads the
 * service's source and fails if the load-bearing fragment is not still in it.
 */
const QUEUE = sql`
  select count(*) filter (where state = 'queued')                          as queued,
         count(*) filter (where state = 'leased' and lease_until >= now()) as running,
         count(*) filter (where state = 'leased' and lease_until <  now()) as expired,
         count(*) filter (where state = 'failed')                          as failed,
         extract(epoch from (now() - min(created_at) filter (where state = 'queued'))) as oldest_queued_seconds
    from grading_jobs
   where state <> 'done'
`;

/**
 * The OTHER half of `workers()`, and the one nothing pinned until B-19.
 *
 * B-8 recorded `workers()` as unbounded and B-9's migration 0025 answered
 * the half that was measured — the throughput join below. This half was
 * rewritten in the same commit and then asserted by nothing, so the only
 * evidence that "bounded by the work in flight" is true of the SHIPPED query
 * (rather than of the sentence in D47's amendment) was that somebody had
 * read it. It reaches `grading_jobs` through the same partial index the
 * queue panel does, and it carries one extra restriction — `worker_id is not
 * null` — which is exactly the kind of addition that can cost a partial
 * index without anybody noticing.
 */
const WORKERS_LIVE = sql`
  select worker_id,
         max(case when state = 'leased' and lease_until >= now()
                  then submission_id end) as current_submission_id,
         max(case when state = 'leased' and lease_until >= now()
                  then id end)            as current_job_id
    from grading_jobs
   where state <> 'done'
     and worker_id is not null
   group by worker_id
`;

const WORKERS_THROUGHPUT = sql`
  select j.worker_id,
         count(*)                                 as graded_last_hour,
         count(*) filter (where s.verdict = 'IE') as ie_last_hour
    from submissions s
    join grading_jobs j on j.submission_id = s.id
   where s.judged_at > now() - interval '1 hour'
     and j.worker_id is not null
   group by j.worker_id
`;

const RECENT_FAILURES = sql`
  select s.id, p.code, u.username, s.verdict, s.state, s.judged_at, s.created_at
    from submissions s
    join problems p on p.id = s.problem_id
    join users u    on u.id = s.user_id
   where s.verdict = 'IE' or s.state = 'errored'
   order by s.id desc
   limit 20
`;

async function dropIndexes(db: Db): Promise<void> {
  await db.execute(sql`drop index grading_jobs_active_idx`);
  await db.execute(sql`drop index grading_jobs_submission_idx`);
  await db.execute(sql`drop index submissions_failed_idx`);
  await db.execute(sql`drop index submissions_judged_at_idx`);
}

/**
 * The fragments each plan below depends on, as they must appear in the
 * service. Each one is load-bearing in a way that is invisible at the call
 * site: the first two are what let the planner prove a partial index applies,
 * and the third is a window without which the join is unbounded again.
 */
const LOAD_BEARING = [
  // queue(): implies grading_jobs_active_idx's predicate.
  `from grading_jobs\n       where state <> 'done'`,
  // recentFailures(): must match submissions_failed_idx's predicate WORD FOR
  // WORD, `or` included.
  `where s.verdict = 'IE' or s.state = 'errored'`,
  // workers(): the window that bounds the throughput half.
  `where s.judged_at > now() - interval '1 hour'`,
  // workers(): the restriction that bounds the LIVE half. `worker_id is not
  // null` rides along; `state <> 'done'` is what the planner proves against
  // grading_jobs_active_idx's predicate. Measured, so it is not a guess:
  // spelling it `state in ('queued', 'leased', 'failed')` still gets the
  // index (Postgres proves the implication), but dropping the state term as
  // redundant — `worker_id is not null` alone, which returns the same rows
  // on today's data — parallel-seq-scans all 100 000.
  `where state <> 'done'\n         and worker_id is not null`,
  // judges(): the per-node "grading now" count. `state = 'leased'` alone
  // would return the same rows; the `<> 'done'` term beside it is what the
  // planner can prove implies grading_jobs_active_idx's predicate, and
  // dropping it as redundant is how this panel goes back to a full scan.
  `where state <> 'done'\n         and state = 'leased'`,
  // blockedJobs(): the same bound, plus the `queued` term that keeps a
  // reason left on a job that has since been claimed out of the count.
  `where state <> 'done'\n         and state = 'queued'\n         and blocked_reason is not null`,
];

describe('admin dashboard query plans (D47 amended, migration 0025)', () => {
  it("keeps the service's SQL and this file's copies in step", async () => {
    const source = await readFile(new URL('../src/authz/dashboard.access.ts', import.meta.url), 'utf8');
    for (const fragment of LOAD_BEARING) {
      expect(source, `dashboard.access.ts no longer contains: ${fragment}`).toContain(fragment);
    }
  });

  /**
   * One seeded database for the whole file, and both directions measured
   * inside it.
   *
   * Seeding 100 000 rows costs about ten seconds, and `withTestDb` gives each
   * call its own rolled-back transaction — so four `it` blocks meant four
   * seeds and a two-minute spec file. Everything here is a read against one
   * fixture, in a fixed order, so it is one test: gather every plan WITH the
   * indexes, drop them, gather every plan WITHOUT, and only then assert. The
   * `expect`s carry their own messages, so a failure still names which panel
   * regressed.
   */
  it('bounds every panel that would otherwise grow with the deployment history', async () => {
    await withTestDb(async (db) => {
      await seedHistory(db);

      const queueWith = await plan(db, QUEUE);
      const liveWith = await plan(db, WORKERS_LIVE);
      const throughputWith = await plan(db, WORKERS_THROUGHPUT);
      const failuresWith = await plan(db, RECENT_FAILURES);

      // `where state <> 'done'` is a rewrite for the planner's benefit, not a
      // narrowing of what the panel reports — every state the aggregate
      // counts is already non-done. If that ever stops being true (a new
      // `grading_job_state`, say) this is what says so, rather than an
      // operator noticing the queue panel has quietly gone blank.
      const [bounded] = await db.execute<Record<string, string | null>>(QUEUE);
      const [unbounded] = await db.execute<Record<string, string | null>>(sql`
        select count(*) filter (where state = 'queued')                          as queued,
               count(*) filter (where state = 'leased' and lease_until >= now()) as running,
               count(*) filter (where state = 'leased' and lease_until <  now()) as expired,
               count(*) filter (where state = 'failed')                          as failed,
               extract(epoch from (now() - min(created_at) filter (where state = 'queued'))) as oldest_queued_seconds
          from grading_jobs
      `);

      await dropIndexes(db);
      const queueWithout = await plan(db, QUEUE);
      const liveWithout = await plan(db, WORKERS_LIVE);
      const throughputWithout = await plan(db, WORKERS_THROUGHPUT);
      const failuresWithout = await plan(db, RECENT_FAILURES);

      // --- the queue panel -------------------------------------------------
      expect(queueWith, 'queue panel should read grading_jobs_active_idx').toContain('grading_jobs_active_idx');
      expect(queueWith, 'queue panel should not scan all of grading_jobs').not.toContain('Seq Scan on grading_jobs');
      // Same rows, same SQL, no index: this is what D47 shipped.
      expect(queueWithout, 'without 0025 the queue panel scans the whole table').toContain('Seq Scan on grading_jobs');

      // --- the worker panel's live half -------------------------------------
      expect(liveWith, 'the live half should read grading_jobs_active_idx').toContain(
        'grading_jobs_active_idx',
      );
      expect(liveWith, 'the live half should not scan all of grading_jobs').not.toContain(
        'Seq Scan on grading_jobs',
      );
      expect(liveWithout, 'without 0025 the live half scans the whole table').toContain(
        'Seq Scan on grading_jobs',
      );

      // --- the worker panel's throughput half -------------------------------
      expect(throughputWith, 'throughput should drive off the judged_at window').toContain('submissions_judged_at_idx');
      expect(throughputWith, 'throughput should reach worker_id by index').toContain('grading_jobs_submission_idx');
      expect(throughputWith, 'throughput should not scan all of grading_jobs').not.toContain('Seq Scan on grading_jobs');
      expect(throughputWith, 'throughput should not scan all of submissions').not.toContain('Seq Scan on submissions');
      expect(throughputWithout, 'without 0025 throughput hash-joins both tables whole').toContain('Seq Scan on grading_jobs');

      // --- the failures panel ----------------------------------------------
      expect(failuresWith, 'failures should read submissions_failed_idx').toContain('submissions_failed_idx');
      // The shape of the bug, stated as the plan states it: the backward
      // primary-key scan throws away every healthy submission since the last
      // incident, one at a time. `Rows Removed by Filter` is only printed by
      // EXPLAIN ANALYZE, which is why this file runs the queries rather than
      // merely planning them.
      const removed = /Rows Removed by Filter: (\d+)/.exec(failuresWithout);
      expect(removed, 'without 0025 the failures panel filters row by row').not.toBeNull();
      expect(Number(removed![1]), 'and it discards most of the table to find twenty rows').toBeGreaterThan(ROWS / 2);

      // --- the rewrite reports the same numbers -----------------------------
      expect(bounded, 'the bound must not change what the queue panel reports').toEqual(unbounded);
      // And it is not vacuous — there really are queued and leased jobs.
      expect(Number(bounded!.queued)).toBeGreaterThan(0);
      expect(Number(bounded!.running)).toBeGreaterThan(0);
    });
  }, 180_000);
});
