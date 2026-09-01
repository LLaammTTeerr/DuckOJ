/**
 * The progress page's two per-pupil reads, as query PLANS (D83, D163, D164).
 *
 * `user-progress.spec.ts` checks what the page counts. This file checks the
 * thing it cannot see: that "your last ten verdicts" and "your last twelve
 * months" are answered out of an index over ONE pupil's rows, rather than out
 * of a table that grows with every submission the province ever takes.
 *
 * **It asserts on the SQL the ORM actually emits, not on a transcription of
 * it.** A plan measured against a statement drizzle does not send is worth
 * nothing, so the service is driven for real through a `createDb` carrying a
 * logger, the emitted statements are captured with their bind values, and it
 * is those statements — verbatim, parameters and all — that are handed to
 * `EXPLAIN`. That is also what makes the "no `problems` join" assertion below
 * meaningful: it is a fact about the text drizzle built, not about this file.
 *
 * **The fixture size is load-bearing**, exactly as `notifications-plan.spec.ts`
 * and `contest-monitor-plan.spec.ts` say: below a few thousand rows a
 * sequential scan genuinely is the cheaper plan, so a fifty-row fixture would
 * produce the same node whatever the index says and prove nothing. 60 000
 * rows belong to other pupils and 600 to the reader, spread over four hundred
 * days — the shape one province term produces.
 *
 * **Plans, not timings.** A millisecond threshold on a shared box measures the
 * box. `Index Only Scan … Heap Fetches: 0` measures the query, and it is the
 * exact fact that stops being true when either half of D164 is reverted.
 */
import { describe, expect, it } from 'vitest';
import { sql, type SQLChunk } from 'drizzle-orm';
import { createDb, type Db } from '@duckoj/db';
import { testDbUrl } from './db.harness.js';
import { insertUser, seedProblemAndLanguage } from './submissions.fixtures.js';
import { ProgressService } from '../src/authz/progress.access.js';
import { ScoreboardCache } from '../src/authz/scoreboard.cache.js';
import type { Actor } from '../src/authz/actor.js';

/**
 * How many submissions the table holds, and how many of them are the
 * reader's.
 *
 * Both numbers are load-bearing and so is the RATIO. A province is ~2 000
 * pupils, so any one pupil owns a fraction of a percent of the table — and it
 * is precisely that fraction the planner reasons about when it decides
 * whether "walk the primary key backwards and discard everybody else" is
 * cheap. A fixture where the reader owns 10 % of the rows makes the backward
 * walk genuinely cheap and proves nothing; one row in six hundred is the
 * shape a province produces.
 */
const TOTAL_ROWS = 60_000;
const ONE_IN = 600;

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * A logged connection to this file's own container — **committed, not rolled
 * back**, which `withTestDb` cannot offer and this file cannot do without.
 *
 * An index-only scan is only possible over pages the visibility map marks
 * all-visible, and only `VACUUM` sets that map; `VACUUM` cannot run inside a
 * transaction. So `withTestDb`'s rollback would make `Heap Fetches: 0`
 * unreachable no matter how right the index is — the assertion would be
 * measuring the harness. Committing is safe here because Vitest gives every
 * spec file its own module graph and therefore its own container, torn down
 * by `db.harness.ts`'s `afterAll`; nothing in this file is shared with
 * another spec.
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
 * The captured text carries drizzle's own `$1 … $n`, and `sql.raw` has no
 * parameters of its own, so the placeholders are split back out and the
 * captured values re-bound in their original positions. A plan measured with
 * literals substituted would be a plan of a DIFFERENT statement — Postgres
 * plans a parameterised query and a literal one differently — which is the
 * whole reason this file captures instead of transcribing.
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

/** The heatmap statement: the only one that buckets a day with `to_char`. */
function heatmapOf(captured: readonly Captured[]): Captured {
  const found = captured.filter((c) => c.sql.includes('to_char') && c.sql.includes('count(*)'));
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** The `recent` panel: the only one ordering by `submissions.id` descending. */
function recentOf(captured: readonly Captured[]): Captured {
  const found = captured.filter((c) => /order by "submissions"\."id" desc limit/.test(c.sql));
  expect(found).toHaveLength(1);
  return found[0]!;
}

describe('the progress page reads one pupil, not the table', () => {
  it(
    'answers the heatmap index-only and the recent panel through submissions_user_recent_idx',
    async () => {
      await withLoggedTestDb(async (db, captured) => {
        await seedProblemAndLanguage(db);
        const mine = await insertUser(db, 'plan-progress-mine');
        const theirs = await insertUser(db, 'plan-progress-theirs');

        // `generate_series` rather than a drizzle loop: sixty thousand round
        // trips would dominate this file's runtime for no gain, and the rows
        // only have to exist.
        //
        // **INTERLEAVED, not appended.** The reader's rows are scattered
        // through the table one in six hundred, because that is what a
        // province does: two thousand pupils submitting alongside each other
        // all term. Blocking the reader's rows at either end of the id range
        // would make the backward primary-key walk either trivially cheap or
        // absurdly expensive, and neither is the plan a deployment gets.
        //
        // `created_at` walks four hundred days so the heatmap's twelve-month
        // bound is a real restriction rather than a clause that happens to
        // select everything.
        await db.execute(sql`
          insert into submissions
            (user_id, problem_id, revision_id, language_id, source, state, verdict, created_at)
          select case when i % ${ONE_IN} = 0 then ${mine.id}::bigint else ${theirs.id}::bigint end,
                 p.id, p.current_revision_id, l.id,
                 'x', 'done',
                 (array['AC','WA','TLE'])[1 + (i % 3)]::case_verdict,
                 now() - ((i % 400) || ' days')::interval
            from generate_series(1, ${TOTAL_ROWS}) as i,
                 lateral (select id, current_revision_id from problems
                           where current_revision_id is not null order by id limit 1) p,
                 lateral (select id from languages order by id limit 1) l
        `);
        // ANALYZE for the statistics and VACUUM for the visibility map: the
        // second is what makes an index-only scan possible at all, and a
        // province's autovacuum has long since done both by the time anybody
        // opens their progress page.
        await db.execute(sql`vacuum (analyze) submissions`);

        const actor: Actor = {
          userId: mine.id,
          globalRole: 'user',
          via: 'session',
          scopes: [],
        };
        // A store that always misses and never writes: this file is about the
        // COLD path, which is the only one that reaches Postgres at all.
        const cache = new ScoreboardCache({
          get: async () => null,
          set: async () => undefined,
          del: async () => undefined,
        });
        const page = await new ProgressService(db, cache).myProgress(actor);
        // The answer is still the answer: the panel is the ten the contract
        // promises, and the calendar counts only the reader's own days.
        expect(page.recent).toHaveLength(10);
        expect(page.heatmap.days.length).toBeGreaterThan(0);

        const heatmap = heatmapOf(captured);
        // D164, as a fact about the emitted text rather than about this file:
        // your own calendar joins nothing, because nothing filters on it.
        expect(heatmap.sql).not.toMatch(/"problems"/);
        const heatmapPlan = await planOf(db, heatmap);
        // Index-only is the whole point — `user_id` and `created_at` are the
        // only columns the statement reads, so it never touches the heap.
        expect(heatmapPlan).toMatch(/Index Only Scan using submissions_user_created_idx/);
        expect(heatmapPlan).toMatch(/Heap Fetches: 0/);
        expect(heatmapPlan).not.toMatch(/Seq Scan on submissions/);

        const recentPlan = await planOf(db, recentOf(captured));
        // FORWARD, and that is the point: the index stores `id` descending,
        // so its own order already is "newest first" and the LIMIT stops
        // after ten entries. The absent `Sort` node below is the assertion
        // that actually holds this — an index that could not supply the
        // ordering would still be scanned and then sorted, which is the
        // 107-buffer plan this replaces.
        //
        // `DESC NULLS FIRST` in the migration is load-bearing for the same
        // reason: `ORDER BY id DESC` means NULLS FIRST in Postgres, and an
        // index declared `DESC NULLS LAST` carries a different pathkey, so
        // the planner silently declines it and sorts instead. `id` is NOT
        // NULL, so the two indexes are identical in content and only one of
        // them is usable here.
        expect(recentPlan).toMatch(/Index Scan using submissions_user_recent_idx/);
        expect(recentPlan).not.toMatch(/Seq Scan on submissions/);
        expect(recentPlan).not.toMatch(/Sort Key: submissions\.id DESC/);
        expect(recentPlan).not.toMatch(/Seq Scan on submissions/);
      });
    },
    120_000,
  );
});
