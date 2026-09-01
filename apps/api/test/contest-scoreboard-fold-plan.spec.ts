/**
 * The cold scoreboard fold, as a query PLAN and as an equality (D165, D166).
 *
 * F-44's statement 34 is the only real hazard it found on any contest-morning
 * route: the fold read **every subtask case row of the contest** — two
 * `Parallel Seq Scan`s of `submission_cases` under a `submission_id =
 * ANY(<every submission id in the contest>)` list, an external merge sort
 * spilling to disk, and 240 000 rows shipped to Node so that Node could reduce
 * them per group. No index fixes it; a sequential scan is the optimal plan for
 * reading 96 % of a table. The query was the finding.
 *
 * D165's answer is that the reduction happens once, at write time, and the fold
 * reads it. This file holds the two claims that have to be true together,
 * because either alone is worthless:
 *
 * 1. **The fold stops reading `submission_cases`.** Not "reads it more
 *    cheaply" — the whole statement is gone for a contest whose submissions
 *    have finished grading, and what remains is the read that was already
 *    loading every submission of the contest.
 * 2. **Every number is the same number.** Migration 0045's backfill is checked
 *    bit-for-bit against `summariseCases` over the raw case rows, on ~16 000
 *    generated submissions; and a submission still grading is folded from its
 *    case rows exactly as it always was, which is what stops the summary from
 *    being a second source of truth. A faster scoreboard that is wrong is
 *    strictly worse than a slow one that is right (D36).
 *
 * **The backfill is read out of the migration file**, not transcribed. A copy
 * would drift, and a drifted copy would go on certifying SQL nobody runs.
 *
 * **The statement is captured, never transcribed either.** `progress-plan
 * .spec.ts`'s harness: the real service is driven through a `createDb` carrying
 * a logger, and the statements drizzle actually emitted are what get asserted
 * on and `EXPLAIN`ed. The *old* case read is a literal here, and only here: it
 * is the "before" half of the measurement, and a file that asserted only the
 * new shape would be claiming an improvement it never observed.
 *
 * **The fixture size is load-bearing**, per `contest-monitor-plan.spec.ts`:
 * below a few thousand rows a sequential scan is genuinely the cheaper plan and
 * every assertion would pass for the wrong reason. This seeds the province
 * round F-44 measured — 2 000 pupils, 8 problems, ~16 000 contest submissions,
 * ~300 000 case rows including a regraded quarter.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { eq, sql, type SQLChunk } from 'drizzle-orm';
import { createDb, type Db } from '@duckoj/db';
import { summariseCases, type SubtaskSummary } from '@duckoj/contest-formats';
import { contestProblems, contests, problemRevisions, problems, submissions } from '@duckoj/db/guarded';
import { schema } from '@duckoj/db';
import { testDbUrl } from './db.harness.js';
import { insertUser, seedProblemAndLanguage } from './submissions.fixtures.js';
import { ContestAccessService } from '../src/authz/contest.access.js';
import { uncachedScoreboards } from './scoreboard.fixtures.js';

/** The province round F-44 measured: 2 000 pupils over 8 problems. */
const PUPILS = 2_000;
const PROBLEMS_PER_CONTEST = 8;
/** ~16 000 contest submissions, the figure in F-44's table. */
const SUBMISSIONS_PER_PUPIL = 8;
/** Fifteen cases each, which is what put 240 000 rows under the old scan. */
const CASES_PER_SUBMISSION = 15;

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * A logged connection to this file's own container, **committed rather than
 * rolled back** — `progress-plan.spec.ts`'s reasoning, for the same reason:
 * `VACUUM (ANALYZE)` cannot run inside a transaction, and an un-vacuumed
 * synthetic table measures the seeding rather than the query.
 */
async function withLoggedTestDb(
  fn: (db: Db, captured: Captured[]) => Promise<void>,
): Promise<void> {
  const captured: Captured[] = [];
  const { db, close } = createDb(await testDbUrl(), {
    logger: {
      logQuery(query: string, params: unknown[]) {
        captured.push({ sql: query, params });
      },
    },
  });
  try {
    await fn(db, captured);
  } finally {
    await close();
  }
}

/**
 * `EXPLAIN (ANALYZE, BUFFERS)` over a captured statement, binds included.
 *
 * Postgres plans a parameterised statement differently from the same statement
 * with literals pasted in, so the captured `$n` placeholders are split out and
 * the captured values re-bound in their original positions.
 */
async function planOf(db: Db, statement: Captured): Promise<string> {
  const parts = statement.sql.split(/\$(\d+)/);
  const chunks: SQLChunk[] = parts.map((part, i) =>
    i % 2 === 0 ? sql.raw(part) : sql`${statement.params[Number(part) - 1]}`,
  );
  const rows = await db.execute<{ 'QUERY PLAN': string }>(
    sql`explain (analyze, buffers, costs off) ${sql.join(chunks)}`,
  );
  return rows.map((row) => row['QUERY PLAN']).join('\n');
}

/**
 * The fold's case read as it stood at `d72441e`, kept as a literal.
 *
 * Two statements in the original, both carrying the same `ANY(...)` list of
 * every submission id in the contest; the id list is passed here as one array
 * parameter, which is exactly what drizzle's `inArray` emitted. The second
 * statement is the one that dominated — this is it, self-joined to the
 * `max(attempt)` aggregate that was the first.
 */
function oldCaseRead(submissionIds: number[]): Captured {
  return {
    sql: `select "submission_cases"."id", "submission_cases"."submission_id", "submission_cases"."group_index", "submission_cases"."case_index", "submission_cases"."points", "submission_cases"."max_points", "submission_cases"."verdict" from "submission_cases" inner join (select "submission_id", max("attempt") as "max_attempt" from "submission_cases" where "submission_cases"."submission_id" in $1 group by "submission_cases"."submission_id") "latest_attempt" on ("latest_attempt"."submission_id" = "submission_cases"."submission_id" and "latest_attempt"."max_attempt" = "submission_cases"."attempt") where "submission_cases"."submission_id" in $1 order by "submission_cases"."id" asc`
      // drizzle spells `in` as `in (?, ?, …)`; an equivalent single-parameter
      // `= any($1)` is what keeps this literal from being 16 000 placeholders
      // long, and Postgres plans the two identically (`ScalarArrayOpExpr`).
      .replace(/in \$1/g, '= any($1::bigint[])'),
    // One array parameter rather than 16 000 placeholders. Postgres plans
    // `= ANY($1::bigint[])` and drizzle's `in (?, ?, …)` through the same
    // `ScalarArrayOpExpr`, and the point being measured is the width of the
    // read, not the width of the parse.
    params: [`{${submissionIds.join(',')}}`],
  };
}

interface Fixture {
  contestId: number;
  contestKey: string;
  submissionIds: number[];
}

/**
 * One province round, seeded set-based.
 *
 * 16 000 round trips would make this file unaffordable to keep in the suite —
 * `contest-monitor-plan.spec.ts`'s reasoning and its statement shape.
 *
 * The case points are **fractional and spread over several magnitudes**, and
 * every fourth submission carries a superseded earlier attempt. Both are
 * deliberate: integer points make IEEE addition associative, so an integer
 * fixture cannot see a sum computed in the wrong order, and a single-attempt
 * fixture cannot see a latest-attempt filter that stopped filtering.
 */
async function seedProvinceRound(db: Db): Promise<Fixture> {
  await seedProblemAndLanguage(db);
  const owner = await insertUser(db, 'f45-owner');
  const [language] = await db.select({ id: schema.languages.id }).from(schema.languages);
  const [seed] = await db
    .select({ currentRevisionId: problems.currentRevisionId })
    .from(problems);
  const [pkg] = await db
    .select({ hash: problemRevisions.packageHash })
    .from(problemRevisions)
    .where(sql`${problemRevisions.id} = ${seed!.currentRevisionId!}`);

  const [contest] = await db
    .insert(contests)
    .values({
      key: 'f45-round',
      name: 'F-45 province round',
      startTime: new Date(Date.now() - 3_600_000),
      endTime: new Date(Date.now() + 3_600_000),
      format: 'icpc',
      visibility: 'public',
      createdBy: owner.id,
    })
    .returning({ id: contests.id });
  const contestId = contest!.id;

  for (let index = 0; index < PROBLEMS_PER_CONTEST; index += 1) {
    const [problem] = await db
      .insert(problems)
      .values({
        code: `f45-p${String(index)}`,
        name: `Bài ${String(index)}`,
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
        testCount: CASES_PER_SUBMISSION,
        totalPoints: 100,
        checkerKind: 'wcmp',
      })
      .returning({ id: problemRevisions.id });
    await db
      .update(problems)
      .set({ currentRevisionId: revision!.id })
      .where(sql`${problems.id} = ${problem!.id}`);
    await db.insert(contestProblems).values({
      contestId,
      problemId: problem!.id,
      label: String.fromCharCode(65 + index),
      points: 100,
      order: index,
    });
  }

  // 2 000 pupils, one participation each. Users and participations are the
  // only per-pupil rows; everything below is one statement.
  await db.execute(sql`
    insert into users (username, email, password_hash, display_name)
    select 'f45-pupil-' || g, 'f45-' || g || '@e.com', 'x', 'Pupil ' || g
      from generate_series(1, ${PUPILS}) g
  `);
  await db.execute(sql`
    insert into contest_participations (contest_id, user_id, virtual, start_time)
    select ${contestId}, u.id, 0, now() - interval '30 minutes'
      from users u
     where u.username like 'f45-pupil-%'
  `);
  await db.execute(sql`
    insert into submissions (user_id, problem_id, revision_id, language_id, source, state, verdict, points, max_points, time_ms, memory_kb, created_at)
    select part.user_id,
           cp.problem_id,
           p.current_revision_id,
           ${language!.id},
           'src',
           'done'::submission_state,
           case when (part.id + n) % 3 = 0 then 'AC'::case_verdict else 'WA'::case_verdict end,
           50, 100, 10, 1000,
           now() - interval '20 minutes' + ((part.id * 7 + n) % 1000) * interval '1 second'
      from contest_participations part
      join lateral (
        select cp.id, cp.problem_id, row_number() over (order by cp."order") as rn
          from contest_problems cp
         where cp.contest_id = ${contestId}
      ) cp on true
      join problems p on p.id = cp.problem_id
      cross join generate_series(1, ${Math.ceil(SUBMISSIONS_PER_PUPIL / PROBLEMS_PER_CONTEST)}) n
     where part.contest_id = ${contestId}
  `);
  await db.execute(sql`
    insert into contest_submissions (participation_id, contest_problem_id, submission_id)
    select part.id, cp.id, s.id
      from submissions s
      join contest_participations part on part.user_id = s.user_id and part.contest_id = ${contestId}
      join contest_problems cp on cp.contest_id = ${contestId} and cp.problem_id = s.problem_id
  `);
  // Fifteen cases per submission across four groups: group 0 is loose and
  // sums, groups 1-3 are batches and take min/max. Points are `id % 97 / 7`
  // scaled by a per-case power of ten, so no two magnitudes are alike.
  await db.execute(sql`
    insert into submission_cases (submission_id, attempt, group_index, case_index, verdict, time_ms, memory_kb, points, max_points)
    select cs.submission_id,
           1,
           (c % 4),
           c,
           'AC'::case_verdict,
           1, 1000,
           ((cs.submission_id + c) % 97) / 7.0 * power(10.0, ((cs.submission_id + c) % 7) - 3),
           20.0
      from contest_submissions cs
      cross join generate_series(0, ${CASES_PER_SUBMISSION - 1}) c
     where cs.participation_id in (select id from contest_participations where contest_id = ${contestId})
  `);
  // Every fourth submission has a superseded attempt 1 and a real attempt 2,
  // so the latest-attempt filter has something to filter.
  await db.execute(sql`
    insert into submission_cases (submission_id, attempt, group_index, case_index, verdict, time_ms, memory_kb, points, max_points)
    select cs.submission_id, 2, (c % 4), c, 'AC'::case_verdict, 1, 1000,
           ((cs.submission_id * 3 + c) % 89) / 11.0 * power(10.0, ((cs.submission_id + c) % 5) - 2),
           20.0
      from contest_submissions cs
      cross join generate_series(0, ${CASES_PER_SUBMISSION - 1}) c
     where cs.id % 4 = 0
       and cs.participation_id in (select id from contest_participations where contest_id = ${contestId})
  `);

  for (const table of [
    'users',
    'submissions',
    'submission_cases',
    'contest_submissions',
    'contest_participations',
    'contest_problems',
    'contests',
  ]) {
    await db.execute(sql.raw(`vacuum (analyze) ${table}`));
  }

  const ids = await db.execute<{ submission_id: number }>(sql`
    select cs.submission_id
      from contest_submissions cs
      join contest_participations part on part.id = cs.participation_id
     where part.contest_id = ${contestId}
     order by cs.id
  `);
  return {
    contestId,
    contestKey: 'f45-round',
    submissionIds: ids.map((row) => Number(row.submission_id)),
  };
}

/** What the old statement's rows reduce to, per submission, in id order. */
function summariesFromCaseRows(
  rows: { submission_id: number; group_index: number; points: number; max_points: number }[],
): Map<number, SubtaskSummary[]> {
  const casesBySubmission = new Map<number, { batch: number; case: number; points: number; total: number; status: string }[]>();
  for (const row of rows) {
    const bucket = casesBySubmission.get(Number(row.submission_id)) ?? [];
    bucket.push({
      batch: row.group_index,
      case: 0,
      points: Number(row.points),
      total: Number(row.max_points),
      status: 'AC',
    });
    casesBySubmission.set(Number(row.submission_id), bucket);
  }
  return new Map(
    [...casesBySubmission].map(([id, cases]) => [id, summariseCases(cases)]),
  );
}

/**
 * Migration 0045's backfill, read out of the migration file rather than copied.
 *
 * Only the `UPDATE`s: the `ALTER TABLE` and the `SET LOCAL` have already run
 * (the harness migrates the container), and `SET LOCAL` outside a transaction
 * is a no-op with a warning — so `extra_float_digits` is set for this
 * connection instead, which is the same guarantee by the same mechanism.
 */
async function backfillStatements(): Promise<string[]> {
  const source = await readFile(
    new URL('../../../packages/db/migrations/0045_f45_subtask_summary.sql', import.meta.url),
    'utf8',
  );
  const statements = source
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .filter((part) => /^UPDATE/im.test(part.replace(/^--.*$/gm, '').trim()));
  expect(statements, 'migration 0045 no longer contains its backfill').toHaveLength(2);
  return statements;
}

describe('the cold scoreboard fold (F-44 statement 34, D165)', () => {
  it('stops reading submission_cases, and every number it stops deriving is unchanged', async () => {
    await withLoggedTestDb(async (db, captured) => {
      const fixture = await seedProvinceRound(db);

      // --- what the old fold read, measured before anything else runs -------
      const before = await planOf(db, oldCaseRead(fixture.submissionIds));
      const oldRows = await db.execute<{
        submission_id: number;
        group_index: number;
        points: number;
        max_points: number;
      }>(sql`
        select sc.submission_id, sc.group_index, sc.points, sc.max_points
          from submission_cases sc
          join (
            select submission_id, max(attempt) as max_attempt
              from submission_cases
             group by submission_id
          ) la on la.submission_id = sc.submission_id and la.max_attempt = sc.attempt
         order by sc.id asc
      `);
      const expected = summariesFromCaseRows(oldRows);
      expect(expected.size).toBe(fixture.submissionIds.length);

      // --- 2. the numbers: migration 0045's backfill against the summariser --
      await db.execute(sql`set extra_float_digits = 3`);
      for (const statement of await backfillStatements()) {
        await db.execute(sql.raw(statement));
      }

      const stored = await db
        .select({ id: submissions.id, summary: submissions.subtaskSummary })
        .from(submissions);
      const storedById = new Map(stored.map((row) => [row.id, row.summary as SubtaskSummary[]]));

      let compared = 0;
      for (const [id, want] of expected) {
        const got = storedById.get(id);
        expect(got, `submission ${String(id)} was not backfilled`).toBeDefined();
        expect(got!.length, `submission ${String(id)}: group count`).toBe(want.length);
        for (const [index, summary] of want.entries()) {
          const mine = got![index]!;
          // `Object.is`, not `toBeCloseTo`. `points` is `double precision`,
          // the fold divides by these numbers, and a board a fraction of a
          // point out is a wrong board reported as a right one (D36).
          const same =
            mine.batch === summary.batch &&
            Object.is(mine.minPoints, summary.minPoints) &&
            Object.is(mine.maxTotal, summary.maxTotal) &&
            Object.is(mine.sumPoints, summary.sumPoints) &&
            Object.is(mine.sumTotal, summary.sumTotal);
          expect(
            same,
            `submission ${String(id)} group ${String(index)}: ` +
              `postgres ${JSON.stringify(mine)} vs javascript ${JSON.stringify(summary)}`,
          ).toBe(true);
          compared += 1;
        }
      }
      // A proof that compared nothing is not a proof. Four groups on ~16 000
      // submissions is the shape seeded above.
      expect(compared).toBeGreaterThan(50_000);

      // --- 1. the plan ------------------------------------------------------
      captured.length = 0;
      const service = new ContestAccessService(db, uncachedScoreboards());
      const board = await service.getScoreboard(null, fixture.contestKey);
      expect(board.ranking.length).toBe(PUPILS);

      const readsCases = captured.filter((statement) =>
        statement.sql.includes('"submission_cases"'),
      );
      expect(
        readsCases.map((statement) => statement.sql),
        'the fold still reads submission_cases for a fully graded contest',
      ).toEqual([]);

      // What is left is the read that was already loading every submission of
      // the contest — F-44's statement 33 — now carrying the summary with it.
      const submissionRead = captured.filter(
        (statement) =>
          statement.sql.includes('"contest_submissions"') &&
          statement.sql.includes('"subtask_summary"'),
      );
      expect(submissionRead, 'no statement carries the stored summary').toHaveLength(1);
      const after = await planOf(db, submissionRead[0]!);

      // The old shape, as F-44 recorded it: two scans of `submission_cases`
      // and a sort by id that spilled to disk.
      expect(before.match(/Seq Scan on submission_cases/g)?.length ?? 0).toBeGreaterThan(1);
      expect(before, 'the old read did not sort by submission_cases.id').toMatch(/Sort Key/);
      expect(before, 'the old read did not spill').toMatch(/external merge/);

      // The new shape touches no case row at all.
      expect(after).not.toMatch(/submission_cases/);

      // What the summary COSTS: the same statement 33 with the column removed.
      // It rides a read that was already loading every submission of the
      // contest, but it is not free — the rows are wider. Measured rather than
      // waved away. (Wider rows are also why the `ORDER BY` moved into
      // JavaScript: sorting them in Postgres spilled ~10 MB of temp per fold.)
      const withoutSummary: Captured = {
        sql: submissionRead[0]!.sql.replace(/, "submissions"\."subtask_summary"/, ''),
        params: submissionRead[0]!.params,
      };
      expect(withoutSummary.sql, 'the column was not removable from the captured text').not.toBe(
        submissionRead[0]!.sql,
      );
      const afterWithout = await planOf(db, withoutSummary);
      // Neither form sorts in the database any more.
      expect(after, 'statement 33 sorts in Postgres again').not.toMatch(/external merge/);
      console.log(`[f45] AFTER, summary column removed\n${afterWithout}`);


      // --- 3. the residue ---------------------------------------------------
      // The fixture is committed (see `withLoggedTestDb`), so this shares the
      // province round above rather than seeding a second one — building a
      // 300 000-row fixture twice is heat spent to prove nothing new.
      //
      // One submission goes back to grading with a WRONG summary still on it.
      // The board must ignore that summary and re-derive from the case rows,
      // which is the whole reason the residue read exists and the reason a
      // reclaimed lease cannot show a stale score.
      const target = fixture.submissionIds[0]!;
      await db
        .update(submissions)
        .set({
          state: 'grading',
          subtaskSummary: [
            { batch: 0, minPoints: 999, maxTotal: 999, sumPoints: 999, sumTotal: 999 },
          ],
        })
        .where(eq(submissions.id, target));

      captured.length = 0;
      const live = await service.getScoreboard(null, fixture.contestKey);

      const residue = captured.filter((statement) => statement.sql.includes('"submission_cases"'));
      // One statement, because drizzle inlines the max(attempt) subquery — the
      // two the old fold sent are now one, and it is sent only when something
      // is in flight.
      expect(residue, 'the fold did not fall back to the case rows').toHaveLength(1);
      // Bounded by what is in flight, never by what the contest has ever taken:
      // one submission is grading, so its id is the only thing bound — twice,
      // once per `inArray`. Sixteen thousand ids is what the old shape sent on
      // every single fold, and that bind list is the growth F-44 named.
      expect(new Set(residue[0]!.params)).toEqual(new Set([target]));

      // 999 points would have moved a row, and the summary said 999. The board
      // is the one the case rows describe.
      expect(live.ranking).toEqual(board.ranking);

      // Printed rather than thresholded: a millisecond bound on a shared box
      // measures the box. The report quotes these.
      console.log(`[f45] BEFORE (statement 34)\n${before}\n\n[f45] AFTER (statement 33)\n${after}`);
    });
  }, 900_000);
});

