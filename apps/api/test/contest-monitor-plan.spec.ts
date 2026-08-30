/**
 * The monitor's per-problem panel, as a query PLAN (D100, migration 0037).
 *
 * `contest-monitor.spec.ts` checks that the panel reports the right numbers
 * and `contest-monitor-stats.spec.ts` checks that the counters behind it are
 * maintained. This file checks the thing neither can see: that the panel
 * reports them without reading every contest submission the deployment has
 * ever taken.
 *
 * **The fixture is B-17's**, because that is the measurement D100 exists to
 * answer: 100 000 `contest_submissions` rows belonging to a DIFFERENT contest
 * and 200 to the one being watched. The distribution is the whole point — the
 * old query's cost had nothing to do with how big THIS contest was, which is
 * exactly what D47's amendment says an index (or, here, a counter) is for.
 *
 * **Both queries are run on the same rows, in the same transaction.** The old
 * grouped join is kept here as a literal so the improvement is measured
 * rather than asserted from memory: this file is the only place the two plans
 * are ever compared, and the report's before/after numbers come from it. The
 * old statement is dead code everywhere else, which is why it lives in a test
 * and not in the service.
 *
 * **Why plans and not timings.** A millisecond threshold on a shared box
 * measures the box. `Seq Scan on contest_submissions` measures the query, and
 * it is the exact fact that stops being true as the deployment grows.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  contestParticipations,
  contestProblems,
  contests,
  problemRevisions,
  problems,
} from '@duckoj/db/guarded';
import { recomputeContestStats, schema, type Db } from '@duckoj/db';
import { withTestDb } from './db.harness.js';
import { insertUser, seedProblemAndLanguage } from './submissions.fixtures.js';

/**
 * How many contest submissions belong to the OTHER contest.
 *
 * B-17 measured at 100 000 and that number is load-bearing rather than
 * decorative: below a few thousand rows a sequential scan genuinely is the
 * cheaper plan, so a fixture with fifty rows would produce `Seq Scan` in both
 * directions and prove nothing at all. At 100 000 the planner's choice is the
 * one a province's second season produces.
 */
const FOREIGN_ROWS = 100_000;

/** And how many belong to the contest an organiser is actually watching. */
const WATCHED_ROWS = 200;

/** Ten problems per contest — the shape the 32 ms measurement was taken on. */
const PROBLEMS_PER_CONTEST = 10;

/**
 * The widest node the new plan is allowed.
 *
 * Not a tuned number: the panel's inputs are `contest_problems`,
 * `contest_problem_stats` and the `problems` rows they name — twenty, twenty
 * and twenty-one in this fixture — and every one of them is bounded by how
 * many problems exist, not by how much has been submitted. Fifty leaves room
 * for a fixture that grows a few more problems and still fails loudly the
 * moment a node starts reading submissions again.
 */
const MAX_PLAN_ROWS = 50;

interface Fixture {
  watchedId: number;
  foreignId: number;
  ownerId: number;
  problemId: number;
  revisionId: number;
  foreignProblemId: number;
  foreignRevisionId: number;
}

async function seedTwoContests(db: Db): Promise<Fixture> {
  await seedProblemAndLanguage(db);
  const [seed] = await db
    .select({ id: problems.id, currentRevisionId: problems.currentRevisionId })
    .from(problems);
  const owner = await insertUser(db, 'plan-owner');
  const revisionId = seed!.currentRevisionId!;
  const [pkg] = await db
    .select({ hash: problemRevisions.packageHash })
    .from(problemRevisions)
    .where(eq(problemRevisions.id, revisionId));

  // Twenty problems, ten per contest: `contest_problems_problem_idx` is
  // unique on `(contest_id, problem_id)`, so one problem cannot stand in for
  // a whole problem set, and ten is the size D95's 32 ms measurement was
  // taken on.
  const problemIds: number[] = [];
  const revisionIds: number[] = [];
  for (let i = 0; i < PROBLEMS_PER_CONTEST * 2; i += 1) {
    const [problem] = await db
      .insert(problems)
      .values({
        code: `plan-p${String(i)}`,
        name: `Bài ${String(i)}`,
        statement: 's',
        visibility: 'public',
        createdBy: owner.id,
      })
      .returning({ id: problems.id });
    const [revision] = await db
      .insert(problemRevisions)
      .values({
        problemId: problem!.id,
        version: 1,
        packageHash: pkg!.hash,
        state: 'published',
        createdBy: owner.id,
        timeMs: 1000,
        memoryKb: 256_000,
        testCount: 5,
        totalPoints: 100,
        checkerKind: 'wcmp',
      })
      .returning({ id: problemRevisions.id });
    await db
      .update(problems)
      .set({ currentRevisionId: revision!.id })
      .where(eq(problems.id, problem!.id));
    problemIds.push(problem!.id);
    revisionIds.push(revision!.id);
  }

  const ids: number[] = [];
  for (const [index, key] of ['plan-watched', 'plan-foreign'].entries()) {
    const [contest] = await db
      .insert(contests)
      .values({
        key,
        name: key,
        startTime: new Date(Date.now() - 3_600_000),
        endTime: new Date(Date.now() + 3_600_000),
        format: 'icpc',
        visibility: 'public',
        createdBy: owner.id,
      })
      .returning({ id: contests.id });
    for (let i = 0; i < PROBLEMS_PER_CONTEST; i += 1) {
      await db.insert(contestProblems).values({
        contestId: contest!.id,
        problemId: problemIds[index * PROBLEMS_PER_CONTEST + i]!,
        label: String.fromCharCode(65 + i),
        points: 100,
        order: i,
      });
    }
    ids.push(contest!.id);
  }

  return {
    watchedId: ids[0]!,
    foreignId: ids[1]!,
    ownerId: owner.id,
    problemId: problemIds[0]!,
    revisionId: revisionIds[0]!,
    foreignProblemId: problemIds[PROBLEMS_PER_CONTEST]!,
    foreignRevisionId: revisionIds[PROBLEMS_PER_CONTEST]!,
  };
}

/**
 * `contest_submissions` rows for one contest, set-based.
 *
 * 100 000 round trips would make this file unaffordable to keep in the suite,
 * which is `admin-dashboard-plan.spec.ts`'s reasoning and its statement shape.
 */
async function handInMany(
  db: Db,
  contestId: number,
  userId: number,
  revisionId: number,
  languageId: number,
  problemId: number,
  rows: number,
): Promise<void> {
  const [participation] = await db
    .insert(contestParticipations)
    .values({ contestId, userId, virtual: 0, startTime: new Date(Date.now() - 1_800_000) })
    .returning({ id: contestParticipations.id });
  await db.execute(sql`
    insert into submissions (user_id, problem_id, revision_id, language_id, source, state, verdict)
    select ${userId}, ${problemId}, ${revisionId}, ${languageId}, 'src',
           'done'::submission_state,
           case when g % 3 = 0 then 'AC'::case_verdict else 'WA'::case_verdict end
      from generate_series(1, ${rows}) g
  `);
  await db.execute(sql`
    insert into contest_submissions (participation_id, contest_problem_id, submission_id)
    select ${participation!.id},
           cp.id,
           s.id
      from (
        select s.id, row_number() over (order by s.id desc) as rn
          from submissions s
         where not exists (select 1 from contest_submissions cs where cs.submission_id = s.id)
         order by s.id desc
         limit ${rows}
      ) s
      join lateral (
        select cp.id, row_number() over (order by cp."order") as rn
          from contest_problems cp
         where cp.contest_id = ${contestId}
      ) cp on cp.rn = ((s.rn - 1) % 10) + 1
  `);
}

async function plan(db: Db, query: ReturnType<typeof sql>): Promise<string> {
  const rows = await db.execute<{ 'QUERY PLAN': string }>(
    sql`explain (analyze, costs off) ${query}`,
  );
  return rows.map((row) => row['QUERY PLAN']).join('\n');
}

/**
 * The panel as D95 shipped it, kept here as a literal.
 *
 * Nothing runs this any more. It is the "before" half of the measurement, and
 * a spec that only asserted the new plan would be claiming an improvement it
 * never observed.
 */
function oldPanel(contestId: number) {
  return sql`
    select cp.id,
           p.code,
           cp.label,
           count(cs.id)                                              as submitted,
           count(*) filter (where s.verdict = 'AC')                  as accepted,
           count(distinct part.user_id) filter (where s.verdict = 'AC') as solvers
      from contest_problems cp
      join problems p                     on p.id = cp.problem_id
      left join contest_submissions cs    on cs.contest_problem_id = cp.id
      left join submissions s             on s.id = cs.submission_id
      left join contest_participations part on part.id = cs.participation_id
     where cp.contest_id = ${contestId}
     group by cp.id, p.code, cp.label, cp."order"
     order by cp."order", cp.id
  `;
}

/** The panel as `ContestMonitorService.problems` issues it today. */
function newPanel(contestId: number) {
  return sql`
    select p.code,
           cp.label,
           coalesce(st.submitted, 0) as submitted,
           coalesce(st.accepted, 0)  as accepted,
           coalesce(st.solvers, 0)   as solvers,
           coalesce(st.pending, 0)   as pending
      from contest_problems cp
      join problems p                    on p.id = cp.problem_id
      left join contest_problem_stats st on st.contest_problem_id = cp.id
     where cp.contest_id = ${contestId}
     order by cp."order", cp.id
  `;
}

/**
 * The fragment the assertions below actually depend on. A copy of a query can
 * drift, and a drifted copy would go on asserting a beautiful plan for SQL
 * nobody runs — `admin-dashboard-plan.spec.ts`'s guard, for its reason.
 */
const LOAD_BEARING = 'left join contest_problem_stats st on st.contest_problem_id = cp.id';

describe('the monitor’s per-problem panel (D100, migration 0037)', () => {
  it("keeps the service's SQL and this file's copy in step", async () => {
    const source = await readFile(
      new URL('../src/authz/contest.monitor.ts', import.meta.url),
      'utf8',
    );
    expect(source, `contest.monitor.ts no longer contains: ${LOAD_BEARING}`).toContain(
      LOAD_BEARING,
    );
  });

  it('stops scanning every contest submission the deployment has ever taken', async () => {
    await withTestDb(async (db) => {
      const fixture = await seedTwoContests(db);
      const [language] = await db.select({ id: schema.languages.id }).from(schema.languages);
      const stranger = await insertUser(db, 'plan-stranger');
      const local = await insertUser(db, 'plan-local');
      const { watchedId, foreignId } = fixture;

      // The foreign contest first, so the watched contest's rows are the
      // NEWEST — the arrangement that makes an id-ordered scan look cheapest
      // and therefore the least favourable one for the claim being made.
      await handInMany(
        db,
        foreignId,
        stranger.id,
        fixture.foreignRevisionId,
        language!.id,
        fixture.foreignProblemId,
        FOREIGN_ROWS,
      );
      await handInMany(
        db,
        watchedId,
        local.id,
        fixture.revisionId,
        language!.id,
        fixture.problemId,
        WATCHED_ROWS,
      );
      await recomputeContestStats(db, watchedId);
      await recomputeContestStats(db, foreignId);

      // Without this the planner is working from the estimates it had when
      // the tables were empty and will seq-scan whatever it is given — every
      // assertion below would then pass for the wrong reason.
      await db.execute(sql`analyze submissions`);
      await db.execute(sql`analyze contest_submissions`);
      await db.execute(sql`analyze contest_participations`);
      await db.execute(sql`analyze contest_problems`);
      await db.execute(sql`analyze contest_problem_stats`);

      const before = await plan(db, oldPanel(watchedId));
      const after = await plan(db, newPanel(watchedId));

      // --- what D95 shipped -------------------------------------------------
      expect(before, 'the old panel scanned all of contest_submissions').toContain(
        'Seq Scan on contest_submissions',
      );
      expect(before, 'the old panel scanned all of submissions').toContain(
        'Seq Scan on submissions',
      );

      // --- what D100 ships --------------------------------------------------
      expect(after, 'the panel must not touch contest_submissions at all').not.toContain(
        'contest_submissions',
      );
      expect(after, 'the panel must not touch submissions at all').not.toContain(
        ' on submissions',
      );
      expect(after, 'the panel must not touch contest_participations').not.toContain(
        'contest_participations',
      );
      // **The claim, stated as a number.** No node in the plan reads more rows
      // than the problem catalogue holds — twenty-one here — while
      // `contest_submissions` and `submissions` hold 100 200 each. The old
      // panel's widest node read all 100 200; this one's widest reads the
      // problems table, and that is the difference between "bounded by the
      // deployment's history" and "bounded by the contest".
      const widest = [...after.matchAll(/actual time=[\d.]+\.\.[\d.]+ rows=(\d+)/g)]
        .map((match) => Number(match[1]))
        .reduce((a, b) => Math.max(a, b), 0);
      expect(widest, `the widest node of:\n${after}`).toBeLessThanOrEqual(MAX_PLAN_ROWS);
      const oldWidest = [...before.matchAll(/actual time=[\d.]+\.\.[\d.]+ rows=(\d+)/g)]
        .map((match) => Number(match[1]))
        .reduce((a, b) => Math.max(a, b), 0);
      expect(oldWidest, 'the old panel read the whole of both tables').toBeGreaterThan(
        FOREIGN_ROWS,
      );

      // And the two agree about the numbers, which is what makes the plan
      // comparison meaningful rather than a comparison of two different
      // questions.
      const oldRows = await db.execute<Record<string, string>>(oldPanel(watchedId));
      const newRows = await db.execute<Record<string, string>>(newPanel(watchedId));
      const shape = (rows: Record<string, string>[]) =>
        rows.map((r) => [Number(r.submitted), Number(r.accepted), Number(r.solvers)]);
      expect(shape(newRows)).toEqual(shape(oldRows));
    });
  }, 600_000);
});
