/**
 * D49's window exclusion, as a query PLAN (D194).
 *
 * `contestWindowOpenWhere` decides who may see what and WHEN — a submission
 * joins the public statistics at the instant its own participation's window
 * closes, and not before, for every viewer including admins. Nothing about
 * that question is about how much contest activity a deployment has ever had,
 * and until migration 0048 the answer cost exactly that: the `EXISTS` joined
 * `contest_submissions ⋈ contest_participations ⋈ contests` and filtered on a
 * `CASE` Postgres can put no number on, so the planner either hashed **every
 * contest submission the deployment had ever taken** or walked three index
 * probes for every row of the page. This file is what stops that returning.
 *
 * **It asserts on the SQL the ORM actually emits, and on both shapes over the
 * same rows.** `progress-plan.spec.ts`'s harness: the real services are driven
 * through a `createDb` carrying a logger, the emitted statements are captured
 * with their bind values, and it is those statements — verbatim, parameters
 * and all — that are handed to `EXPLAIN`. The predicate as it stood before
 * 0048 is a literal below, spliced into the SAME captured statement and
 * planned in the same connection on the same rows, which is the only way a
 * before/after comparison means anything (F-45's model, and the reason its
 * statement 34 lives in a spec rather than in a report).
 *
 * **The fixture size is load-bearing.** Below a few thousand contest
 * submissions a sequential scan genuinely is the cheaper plan and the old
 * shape would be the right one, so a small fixture would assert nothing. Six
 * thousand participations over thirty finished rounds with one in flight is a
 * province one term in, and the "before" assertions below are what prove the
 * fixture is big enough — if they stop holding, the fixture shrank, not the
 * defect.
 */
import { describe, expect, it } from 'vitest';
import { sql, type SQLChunk } from 'drizzle-orm';
import { createDb, type Db } from '@duckoj/db';
import { testDbUrl } from './db.harness.js';
import { ProblemAccessService } from '../src/authz/problem.access.js';
import { ProgressService } from '../src/authz/progress.access.js';
import { ScoreboardCache } from '../src/authz/scoreboard.cache.js';
import type { Actor } from '../src/authz/actor.js';

/** Thirty finished weekly rounds and one in flight — a province one term in. */
const ROUNDS = 30;
const PARTICIPANTS = 200;
const PROBLEMS_PER_ROUND = 8;
const PRACTICE_ROWS = 20_000;

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * A logged connection to this file's own container — **committed, not rolled
 * back**, for `progress-plan.spec.ts`'s reason: only `VACUUM` sets the
 * visibility map, `VACUUM` cannot run inside a transaction, and without it
 * `Heap Fetches: 0` is unreachable however right the index is.
 */
async function withLoggedTestDb(fn: (db: Db, captured: Captured[]) => Promise<void>): Promise<void> {
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

/** `EXPLAIN (ANALYZE, BUFFERS)` over a captured statement, binds included. */
async function planOf(db: Db, statement: Captured, text = statement.sql): Promise<string> {
  const parts = text.split(/\$(\d+)/);
  const chunks: SQLChunk[] = parts.map((part, i) =>
    i % 2 === 0 ? sql.raw(part) : sql`${statement.params[Number(part) - 1]}`,
  );
  const rows = await db.execute<{ 'QUERY PLAN': string }>(
    sql`explain (analyze, buffers, costs off) ${sql.join(chunks)}`,
  );
  return rows.map((row) => row['QUERY PLAN']).join('\n');
}

/**
 * `contestWindowOpenWhere` **as it stood at `bf2023a`**, before 0048 — kept
 * here and nowhere else, because a before/after measured against a
 * reconstruction is a measurement of the reconstruction.
 *
 * `-1` and `0` are `SPECTATE` and `LIVE`, written as literals rather than as
 * two more bind parameters only so that splicing this in does not renumber the
 * statement's own placeholders; they feed a `CASE`, never a selectivity
 * estimate, so no plan turns on the difference.
 */
const PREDICATE_BEFORE_0048 = (at: string): string => `exists (
    select 1
    from "contest_submissions"
    join "contest_participations"
      on "contest_participations"."id" = "contest_submissions"."participation_id"
    join "contests" on "contests"."id" = "contest_participations"."contest_id"
    where "contest_submissions"."submission_id" = "submissions"."id"
      and ${at} < (case
      when "contest_participations"."virtual" = -1 then "contests"."end_time"
      when "contest_participations"."virtual" = 0 then
        case
          when "contests"."time_limit_seconds" is null then "contests"."end_time"
          else least(
            "contest_participations"."start_time" + "contests"."time_limit_seconds" * interval '1 second',
            "contests"."end_time"
          )
        end
      else
        case
          when "contests"."time_limit_seconds" is null
            then "contest_participations"."start_time" + ("contests"."end_time" - "contests"."start_time")
          else "contest_participations"."start_time" + "contests"."time_limit_seconds" * interval '1 second'
        end
    end)
  )`;

/**
 * The captured statement with its D49 `EXISTS` replaced by the pre-0048 one.
 *
 * Paren-matched rather than regex-matched: the subquery contains parentheses
 * of its own, and a lazy match would cut it in the middle of the `CASE`.
 */
function withOldPredicate(statement: string): string {
  const start = statement.indexOf('exists (\n    select 1\n    from "contest_submissions"');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  let end = -1;
  for (let i = statement.indexOf('(', start); i < statement.length; i++) {
    if (statement[i] === '(') depth++;
    else if (statement[i] === ')' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  expect(end).toBeGreaterThan(start);
  const body = statement.slice(start, end);
  const at = /\$\d+::timestamptz/.exec(body)?.[0];
  expect(at).toBeTruthy();
  return statement.slice(0, start) + PREDICATE_BEFORE_0048(at!) + statement.slice(end);
}

/** Every captured statement carrying the D49 exclusion. */
function windowStatements(captured: readonly Captured[]): Captured[] {
  return captured.filter((c) => c.sql.includes('from "contest_submissions"'));
}

/**
 * The `GET /problems` page counters (D49's amendment) — the most public of the
 * statements carrying this predicate, and the one that keeps the hash shape
 * longest as a deployment fills up.
 *
 * Identified by its bind list rather than by its text: the detail route and
 * the progress bars group by `problem_id` too, and only the page asks about
 * twenty problems at once.
 */
function listCountsOf(captured: readonly Captured[]): Captured {
  const found = windowStatements(captured).filter(
    (c) => c.sql.includes('group by "submissions"."problem_id"') && c.params.length >= 20,
  );
  expect(found).toHaveLength(1);
  return found[0]!;
}

async function seedProvince(db: Db): Promise<void> {
  // A `DO` block takes no bind parameters (`42P18`), so the sizes above are
  // interpolated into the text and the statement is sent raw. Everything in it
  // is a numeric constant from this file, never anything from outside it.
  await db.execute(sql.raw(`
    do $f54$
    declare cid bigint; p0 bigint; q0 bigint; s0 bigint; lang bigint; r int;
    begin
      insert into users (id, username, email, password_hash, display_name)
      select g, 'cw'||g, 'cw'||g||'@example.com', 'x', 'Pupil '||g
        from generate_series(1, ${PARTICIPANTS} + 1) g;
      perform setval('users_id_seq', ${PARTICIPANTS} + 1);

      insert into packages (hash, size_bytes, file_count)
      select 'cwh'||g, 1, 1 from generate_series(1, ${ROUNDS * PROBLEMS_PER_ROUND}) g;
      insert into problems (id, code, name, statement, visibility, created_by, difficulty)
      select g, 'CW'||g, 'Bài '||g, 's', 'public', 1, 1 + (g % 10)
        from generate_series(1, ${ROUNDS * PROBLEMS_PER_ROUND}) g;
      perform setval('problems_id_seq', ${ROUNDS * PROBLEMS_PER_ROUND});
      insert into problem_revisions
        (id, problem_id, version, package_hash, state, created_by, time_ms, memory_kb, test_count, total_points, checker_kind)
      select g, g, 1, 'cwh'||g, 'published', 1, 1000, 65536, 10, 100, 'wcmp'
        from generate_series(1, ${ROUNDS * PROBLEMS_PER_ROUND}) g;
      perform setval('problem_revisions_id_seq', ${ROUNDS * PROBLEMS_PER_ROUND});
      update problems set current_revision_id = id;
      select id into lang from languages order by id limit 1;

      -- Practice submissions: attached to no contest at all, which is what the
      -- anti-join has to decide about for every row it reads.
      insert into submissions
        (user_id, problem_id, revision_id, language_id, source, state, verdict, points, max_points, created_at)
      select 1 + (g % ${PARTICIPANTS}), 1 + (g % ${ROUNDS * PROBLEMS_PER_ROUND}), 1 + (g % ${ROUNDS * PROBLEMS_PER_ROUND}), lang,
             'x', 'done', (array['AC','WA','TLE'])[1 + (g % 3)]::case_verdict,
             (g % 101)::double precision, 100, now() - ((g % 300) || ' days')::interval
        from generate_series(1, ${PRACTICE_ROWS}) g;

      for r in 0..${ROUNDS} loop
        -- Round 0 is IN FLIGHT — started an hour ago, ends in an hour. Every
        -- other round finished weeks ago. That ratio is the whole finding:
        -- what the predicate must read is the round happening now, and what it
        -- used to read is every round there has ever been.
        insert into contests (key, name, start_time, end_time, format, frozen_last_minutes, visibility, created_by)
        values ('cw-r'||r, 'Vòng '||r,
                case when r = 0 then now() - interval '1 hour' else now() - (r * interval '7 days') end,
                case when r = 0 then now() + interval '1 hour' else now() - (r * interval '7 days') + interval '3 hours' end,
                'ioi', 30, 'public', 1)
        returning id into cid;

        select coalesce(max(id),0) into q0 from contest_problems;
        insert into contest_problems (id, contest_id, problem_id, label, points, "order")
        select q0 + k, cid, ((r * ${PROBLEMS_PER_ROUND} + k - 1) % ${ROUNDS * PROBLEMS_PER_ROUND}) + 1, chr(64 + k), 100, k
          from generate_series(1, ${PROBLEMS_PER_ROUND}) k;
        perform setval('contest_problems_id_seq', q0 + ${PROBLEMS_PER_ROUND});

        select coalesce(max(id),0) into p0 from contest_participations;
        insert into contest_participations (id, contest_id, user_id, start_time, virtual)
        select p0 + u, cid, u,
               case when r = 0 then now() - interval '1 hour' else now() - (r * interval '7 days') end, 0
          from generate_series(1, ${PARTICIPANTS}) u;
        perform setval('contest_participations_id_seq', p0 + ${PARTICIPANTS});

        select coalesce(max(id),0) into s0 from submissions;
        insert into submissions
          (id, user_id, problem_id, revision_id, language_id, source, state, verdict, points, max_points, created_at)
        select s0 + k, 1 + (k % ${PARTICIPANTS}), cp.problem_id, cp.problem_id, lang, 'x', 'done',
               (array['AC','WA','TLE'])[1 + (k % 3)]::case_verdict, (k % 101)::double precision, 100, now()
          from generate_series(1, ${PARTICIPANTS * PROBLEMS_PER_ROUND}) k
          join contest_problems cp on cp.id = q0 + 1 + ((k - 1) % ${PROBLEMS_PER_ROUND});
        perform setval('submissions_id_seq', s0 + ${PARTICIPANTS * PROBLEMS_PER_ROUND});

        insert into contest_submissions (participation_id, contest_problem_id, submission_id)
        select p0 + 1 + ((k - 1) / ${PROBLEMS_PER_ROUND}), q0 + 1 + ((k - 1) % ${PROBLEMS_PER_ROUND}), s0 + k
          from generate_series(1, ${PARTICIPANTS * PROBLEMS_PER_ROUND}) k;
      end loop;
    end $f54$;
  `));
  // ANALYZE for the histogram `ends_at` exists to give the planner, VACUUM for
  // the visibility map an index-only scan needs. A province's autovacuum has
  // long since done both by the time anybody opens the catalogue.
  await db.execute(sql`vacuum (analyze)`);
}

describe("D49's window exclusion reads the contests that are open, not the ones that ever were", () => {
  it(
    'is driven from contest_participations_ends_at_idx, and joins no contests table at all',
    async () => {
      await withLoggedTestDb(async (db, captured) => {
        await seedProvince(db);

        const open = await db.execute<{ n: number }>(
          sql`select count(*)::int as n from contest_participations where ends_at > now()`,
        );
        const all = await db.execute<{ n: number }>(
          sql`select count(*)::int as n from contest_participations`,
        );
        // The fixture the numbers below mean something against: one round of
        // the thirty-one is open.
        expect(open[0]!.n).toBe(PARTICIPANTS);
        expect(all[0]!.n).toBe(PARTICIPANTS * (ROUNDS + 1));

        const actor: Actor = { userId: 1, globalRole: 'user', via: 'session', scopes: [] };
        // A store that always misses: this file is about the COLD path, the
        // only one that reaches Postgres at all (D49 caches both routes).
        const cache = new ScoreboardCache({
          get: async () => null,
          set: async () => undefined,
          del: async () => undefined,
        });
        const problems = new ProblemAccessService(db, { get: async () => null } as never, cache);
        const progress = new ProgressService(db, cache);

        captured.length = 0;
        const page = await problems.listVisible(actor, { limit: 20 });
        await problems.getStats(actor, 'CW1');
        await progress.myProgress(actor);
        // The answer is still the answer, and it is the D49 answer: the round
        // in flight is excluded from the counters on every row of the page.
        expect(page.items.length).toBe(20);

        const statements = windowStatements(captured);
        expect(statements.length).toBeGreaterThanOrEqual(5);

        for (const statement of statements) {
          // The `CASE`'s fingerprint. Its absence is the fact that the
          // predicate now reads one indexed column instead of reaching across
          // two more tables to recompute the same instant per row.
          expect(statement.sql).not.toMatch(/"contests"\."time_limit_seconds"/);
          expect(statement.sql).toMatch(/"contest_participations"\."ends_at" >/);
        }

        // ---------------------------------------------------------- before
        const counts = listCountsOf(captured);
        const before = await planOf(db, counts, withOldPredicate(counts.sql));
        // What F-44 measured and D163 recorded, reproduced here on these rows:
        // the inner side of the anti-join is the whole of the contest tables,
        // and its size has nothing to do with the page being rendered.
        expect(before).toMatch(/Seq Scan on contest_submissions/);
        expect(before).toMatch(/Seq Scan on contest_participations/);
        expect(before).toMatch(/Scan on contests/);

        // ----------------------------------------------------------- after
        const after = await planOf(db, counts);
        expect(after).toMatch(/Index Scan using contest_participations_ends_at_idx/);
        expect(after).toMatch(/Index Only Scan using contest_submissions_participation_idx/);
        // The contest submissions of the open participations are read out of
        // the index and never off the heap — which is what the second column
        // of `contest_submissions_participation_idx` is for, and without it
        // the planner prices this plan above a sequential scan and takes the
        // scan.
        expect(after).toMatch(/Heap Fetches: 0/);
        expect(after).not.toMatch(/Seq Scan on contest_submissions/);
        expect(after).not.toMatch(/Scan on contests/);

        // Every other statement carrying the predicate, held to the same two
        // claims: nothing in it may read a contest table sequentially, and the
        // open set must be reached through its index.
        for (const statement of statements) {
          const plan = await planOf(db, statement);
          expect([statement.sql.slice(0, 60), /Seq Scan on contest_submissions/.test(plan)]).toEqual([
            statement.sql.slice(0, 60),
            false,
          ]);
          expect([statement.sql.slice(0, 60), /Scan on contests\b/.test(plan)]).toEqual([
            statement.sql.slice(0, 60),
            false,
          ]);
        }
      });
    },
    600_000,
  );
});
