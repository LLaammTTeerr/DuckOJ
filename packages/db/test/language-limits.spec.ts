import { readFile } from 'node:fs/promises';
import { asc, eq, sql, type SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  MEMORY_EXTRA_KB_MAX,
  MEMORY_EXTRA_KB_MIN,
  TIME_MULTIPLIER_PCT_MAX,
  TIME_MULTIPLIER_PCT_MIN,
  effectiveLimits,
  resolveLanguageTuning,
  schema,
  type Db,
} from '../src/index.js';
import { problems } from '../src/schema/guarded.js';
import {
  TIME_MULTIPLIER_PCT_MIN as sharedTimeMin,
  effectiveLimits as sharedEffectiveLimits,
  resolveLanguageTuning as sharedResolveLanguageTuning,
} from '@duckoj/language-limits';
import { withTestDb } from './harness.js';

/**
 * D159 — the arithmetic itself now lives in `@duckoj/language-limits`, and
 * its own spec is there. What is asserted HERE is the re-export: `apps/api`
 * and `apps/judged` both import `effectiveLimits` from `@duckoj/db`, which is
 * where D154 put it, and a move that quietly stopped exporting it from this
 * package would break both of them at their call sites rather than here.
 */
describe('@duckoj/db re-exports the limit arithmetic (D159)', () => {
  it('hands back the same functions, and the bounds with them', () => {
    expect(effectiveLimits).toBe(sharedEffectiveLimits);
    expect(resolveLanguageTuning).toBe(sharedResolveLanguageTuning);
    expect(TIME_MULTIPLIER_PCT_MIN).toBe(sharedTimeMin);
  });
});

/**
 * Migrations 0042's and 0046's seeds, asserted against a database that has
 * only ever had the migrations run on it.
 *
 * The executor names are the load-bearing half. A key mapped to an executor
 * no judge announces is a language whose submissions sit `queued` forever
 * with nothing to grade them (D68), which is strictly worse than not offering
 * the language at all — so these are pinned to what the live judge's own
 * self-test reports, not to what a table in a brief guessed.
 */
describe('migrations 0042 and 0046 seed the language catalogue', () => {
  it('seeds seven languages: C++/C unadjusted, python3, pascal and java adjusted', async () => {
    await withTestDb(async (db) => {
      const rows = await db
        .select({
          key: schema.languages.key,
          name: schema.languages.name,
          extension: schema.languages.extension,
          isActive: schema.languages.isActive,
          timeMultiplierPct: schema.languages.timeMultiplierPct,
          memoryExtraKb: schema.languages.memoryExtraKb,
        })
        .from(schema.languages)
        .orderBy(asc(schema.languages.key));

      expect(rows).toEqual([
        {
          key: 'c11',
          name: 'C11',
          extension: 'c',
          isActive: true,
          timeMultiplierPct: 100,
          memoryExtraKb: 0,
        },
        {
          key: 'cpp14',
          name: 'C++14',
          extension: 'cpp',
          isActive: true,
          timeMultiplierPct: 100,
          memoryExtraKb: 0,
        },
        {
          key: 'cpp17',
          name: 'C++17',
          extension: 'cpp',
          isActive: true,
          timeMultiplierPct: 100,
          memoryExtraKb: 0,
        },
        {
          key: 'cpp20',
          name: 'C++20',
          extension: 'cpp',
          isActive: true,
          timeMultiplierPct: 100,
          memoryExtraKb: 0,
        },
        // D169. Java's 300 % pays a FIXED 55 ms JVM start out of a
        // proportional instrument, and its +64 MB pays a PROPORTIONAL heap
        // need (1.57x the live data, because the judge hands `-Xmx<limit>`)
        // out of an additive one — the reverse of D154's interpreter case,
        // in both columns.
        {
          key: 'java',
          name: 'Java 17',
          extension: 'java',
          isActive: true,
          timeMultiplierPct: 300,
          memoryExtraKb: 65_536,
        },
        // Pascal is native code and 1.05-1.37x C++ on everything measured
        // except line-oriented string input; its memory floor (196-204 KB)
        // is BELOW C++'s, so the addend is 0 and not a token amount.
        {
          key: 'pascal',
          name: 'Pascal',
          extension: 'pas',
          isActive: true,
          timeMultiplierPct: 200,
          memoryExtraKb: 0,
        },
        {
          key: 'python3',
          name: 'Python 3',
          extension: 'py',
          isActive: true,
          timeMultiplierPct: 300,
          memoryExtraKb: 32_768,
        },
      ]);
    });
  });

  it('maps every language to the executor the live judge actually announces', async () => {
    await withTestDb(async (db) => {
      const rows = await db
        .select({ key: schema.languages.key, executorKey: schema.languageDriverKeys.executorKey })
        .from(schema.languageDriverKeys)
        .innerJoin(schema.languages, eq(schema.languages.id, schema.languageDriverKeys.languageId))
        .where(eq(schema.languageDriverKeys.driver, 'dmoj'))
        .orderBy(asc(schema.languages.key));

      // `c11 -> C11`, not `c17 -> C17`: the image ships `C` (-std=c99) and
      // `C11` (-std=c11) and nothing that compiles C17, so a key named `c17`
      // would be exactly the lie `language_driver_keys` exists to prevent.
      // `python3 -> PY3` is the first key whose executor is not its own name
      // uppercased, which is what retired the hard-coded closure in
      // `apps/judged/src/main.ts`.
      // Free Pascal announces itself as `PAS`, not `PASCAL`, and the JDK as
      // `JAVA`. `JAVA8` is in the image and unusable — its own autoconf says
      // "Could not find JVM" — so nothing maps to it (F-46).
      expect(rows).toEqual([
        { key: 'c11', executorKey: 'C11' },
        { key: 'cpp14', executorKey: 'CPP14' },
        { key: 'cpp17', executorKey: 'CPP17' },
        { key: 'cpp20', executorKey: 'CPP20' },
        { key: 'java', executorKey: 'JAVA' },
        { key: 'pascal', executorKey: 'PAS' },
        { key: 'python3', executorKey: 'PY3' },
      ]);
    });
  });
});

/**
 * D159 — migration 0043's bounds, as the database really enforces them.
 *
 * B-30 measured what their absence bought: `pct 0 -> {"timeMs":0}`, evaluated
 * against the built function, on a column an operator could only ever write
 * with raw SQL. That is D154's forbidden outcome — a refusal presented as a
 * TLE — reached by a typo instead of by a decision.
 *
 * Read out of `pg_constraint` rather than restated as literals, and compared
 * against the exported constants, because the whole hazard here is three
 * layers (the CHECK, the contract's zod bounds, the form) drifting apart. If
 * `@duckoj/language-limits` moves a number and this migration does not, this
 * fails.
 */
describe('migration 0043 bounds a limit adjustment (D159)', () => {
  /**
   * The constraint that refused a statement, or `null` if it was accepted.
   *
   * Drizzle wraps the driver's error in a `Failed query: …` of its own and
   * keeps the Postgres error — the half that names the CHECK — on `cause`, so
   * a bare `rejects.toThrow(/…_ck/)` passes for the WRONG reason on a
   * statement that failed for any other cause at all. This reads the name.
   */
  async function refusedBy(db: Db, statement: SQL): Promise<string | null> {
    try {
      // A SAVEPOINT, not a bare statement: the first refusal aborts the
      // surrounding transaction, and every statement after it in the same one
      // fails with 25P02 instead of with the CHECK — which would make this
      // helper report the wrong constraint for every case but the first.
      await db.transaction(async (tx) => {
        await tx.execute(statement);
      });
      return null;
    } catch (error) {
      const cause = (error as { cause?: { constraint_name?: string } }).cause;
      return cause?.constraint_name ?? String(error);
    }
  }

  async function constraintSource(db: Db, name: string): Promise<string | null> {
    const rows = await db.execute<{ def: string }>(
      sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}`,
    );
    return rows[0]?.def ?? null;
  }

  it('states the exported bounds, on BOTH tables', async () => {
    await withTestDb(async (db) => {
      const lo = String(TIME_MULTIPLIER_PCT_MIN);
      const hi = String(TIME_MULTIPLIER_PCT_MAX);
      const mlo = String(MEMORY_EXTRA_KB_MIN);
      const mhi = String(MEMORY_EXTRA_KB_MAX);

      const langTime = await constraintSource(db, 'languages_time_multiplier_pct_ck');
      expect(langTime).toContain(lo);
      expect(langTime).toContain(hi);
      const langMem = await constraintSource(db, 'languages_memory_extra_kb_ck');
      expect(langMem).toContain(mlo);
      expect(langMem).toContain(mhi);

      // The override's copy carries the same two numbers AND an `IS NULL`
      // escape the language default has no use for.
      const overTime = await constraintSource(db, 'problem_language_limits_time_multiplier_pct_ck');
      expect(overTime).toContain(lo);
      expect(overTime).toContain(hi);
      expect(overTime).toContain('IS NULL');
      const overMem = await constraintSource(db, 'problem_language_limits_memory_extra_kb_ck');
      expect(overMem).toContain(mlo);
      expect(overMem).toContain(mhi);
      expect(overMem).toContain('IS NULL');
    });
  });

  it('refuses the typo that made every submission in a language TLE', async () => {
    await withTestDb(async (db) => {
      const refused = async (pct: number): Promise<string | null> =>
        refusedBy(db, sql`update languages set time_multiplier_pct = ${pct} where key = 'python3'`);
      expect(await refused(0)).toBe('languages_time_multiplier_pct_ck');
      expect(await refused(-100)).toBe('languages_time_multiplier_pct_ck');
      // 99 % is the same lie in miniature: it takes time away from a language
      // rather than refusing it, and a correct program fails as if it were slow.
      expect(await refused(TIME_MULTIPLIER_PCT_MIN - 1)).toBe('languages_time_multiplier_pct_ck');
      // And the floor itself is admitted: "Python gets no bonus on this
      // problem" is the brief's own example, and it is exactly 100.
      expect(await refused(TIME_MULTIPLIER_PCT_MIN)).toBeNull();
    });
  });

  it('refuses a multiplier that would hold the province’s one judge for a lesson', async () => {
    await withTestDb(async (db) => {
      expect(
        await refusedBy(
          db,
          sql`update languages set time_multiplier_pct = ${TIME_MULTIPLIER_PCT_MAX + 1} where key = 'python3'`,
        ),
      ).toBe('languages_time_multiplier_pct_ck');
      expect(
        await refusedBy(
          db,
          sql`update languages set memory_extra_kb = ${MEMORY_EXTRA_KB_MAX + 1} where key = 'python3'`,
        ),
      ).toBe('languages_memory_extra_kb_ck');
      // Below the floor is a language handed LESS memory than the problem
      // authorised — D154's interpreter floor in reverse, and an MRE for a
      // correct program.
      expect(
        await refusedBy(db, sql`update languages set memory_extra_kb = -1 where key = 'python3'`),
      ).toBe('languages_memory_extra_kb_ck');
    });
  });

  it('admits everything migration 0042 seeds, so a fresh install survives its own seed', async () => {
    await withTestDb(async (db) => {
      // 0042 runs immediately before 0043 on an empty database. If the bounds
      // excluded a seeded value, `runMigrations` in the harness above would
      // already have thrown — this asserts the values rather than relying on
      // that, so a later widening of the seed is caught here by name.
      const rows = await db
        .select({
          key: schema.languages.key,
          pct: schema.languages.timeMultiplierPct,
          extra: schema.languages.memoryExtraKb,
        })
        .from(schema.languages);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.pct).toBeGreaterThanOrEqual(TIME_MULTIPLIER_PCT_MIN);
        expect(row.pct).toBeLessThanOrEqual(TIME_MULTIPLIER_PCT_MAX);
        expect(row.extra).toBeGreaterThanOrEqual(MEMORY_EXTRA_KB_MIN);
        expect(row.extra).toBeLessThanOrEqual(MEMORY_EXTRA_KB_MAX);
      }
    });
  });

  it('leaves NULL alone, because NULL is “inherit” and not zero', async () => {
    await withTestDb(async (db) => {
      const [author] = await db
        .insert(schema.users)
        .values({
          username: 'd159setter',
          email: 'd159setter@example.invalid',
          passwordHash: 'x',
          displayName: 'D159',
        })
        .returning({ id: schema.users.id });
      const [problem] = await db
        .insert(problems)
        .values({
          code: 'd159-bounds',
          name: 'D159',
          statement: '',
          createdBy: author!.id,
        })
        .returning({ id: problems.id });
      const problemId = problem!.id;
      const language = await db.execute<{ id: number }>(
        sql`select id from languages where key = 'python3'`,
      );
      const languageId = language[0]!.id;

      // The ordinary override: pin the time, say nothing about memory. It is
      // the row D154 names explicitly, and a CHECK without `IS NULL OR` would
      // have made it unwritable.
      await db.execute(
        sql`insert into problem_language_limits (problem_id, language_id, time_multiplier_pct, memory_extra_kb, allowed)
            values (${problemId}, ${languageId}, 150, null, true)`,
      );
      const stored = await db.execute<{
        time_multiplier_pct: number | null;
        memory_extra_kb: number | null;
      }>(
        sql`select time_multiplier_pct, memory_extra_kb from problem_language_limits
             where problem_id = ${problemId} and language_id = ${languageId}`,
      );
      expect(stored[0]).toEqual({ time_multiplier_pct: 150, memory_extra_kb: null });

      // And the typo is refused here too — the override replaces the default
      // column by column, so a range one table admits and the other refuses
      // would let an override say what a default could not.
      expect(
        await refusedBy(
          db,
          sql`update problem_language_limits set time_multiplier_pct = 0
               where problem_id = ${problemId} and language_id = ${languageId}`,
        ),
      ).toBe('problem_language_limits_time_multiplier_pct_ck');
    });
  });

  it('re-runs without failing, because a migration nobody dares re-run is D133 again', async () => {
    await withTestDb(async (db) => {
      const migration = await readFile(
        new URL('../migrations/0043_language_limit_bounds.sql', import.meta.url),
        'utf8',
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim() === '') continue;
        await db.execute(sql.raw(statement));
      }
      // Still exactly one of each, not two.
      const rows = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from pg_constraint
             where conname in ('languages_time_multiplier_pct_ck', 'languages_memory_extra_kb_ck',
                               'problem_language_limits_time_multiplier_pct_ck',
                               'problem_language_limits_memory_extra_kb_ck')`,
      );
      expect(rows[0]!.n).toBe(4);
    });
  });
});

/**
 * F-46/F-47. The rule F-39 wrote down:
 *
 * > `--only-executors` must stay a superset of the `executor_key`s in
 * > `language_driver_keys`.
 *
 * It is the flag that kept this judge at one language for a fortnight, and it
 * appears on EVERY judge service in `docker-compose.yml` — the profiled
 * `judge-2` is the easy one to forget, and a fleet where two judges disagree
 * is a fleet where a submission's fate depends on which one claimed it. The
 * check reads the real compose file against a real migrated database, so a
 * migration that seeds a language nobody widened the flag for fails here
 * rather than as D68's `blocked_reason` in production.
 *
 * **F-47 closed two holes in F-46's version of this**, both found by asking
 * what the guard would actually have caught:
 *
 *  1. It matched `--only-executors` occurrences and asserted there were
 *     `2` of them. A third judge service added WITHOUT the flag would have
 *     left exactly two matches and passed — the very case the comment
 *     claimed to cover. The services are now derived from the file's own
 *     structure, and a judge service missing the flag is named.
 *  2. It asserted a superset in one direction only. The other direction is
 *     what D172 turned from a wrong answer into a silent one: an executor on
 *     the allow-list that no row names is announced by the judge, dropped by
 *     `judged`, and visible nowhere. Equality is the honest rule — announce
 *     what we can grade, and nothing else.
 */
describe('the compose allow-list matches every seeded executor (F-39, F-46, F-47)', () => {
  /**
   * Every service in `docker-compose.yml` whose `command:` runs
   * `dmoj judged`, with the `--only-executors` list it passes (or
   * `undefined` when it passes none).
   *
   * Deliberately structural rather than a global regex over the file: the
   * whole point is to notice a judge service that did NOT get the flag, and
   * a scan that only sees the flag can never see its absence.
   */
  function judgeServices(compose: string): Map<string, string[] | undefined> {
    const lines = compose.split('\n');
    const found = new Map<string, string[] | undefined>();
    // Top-level service names sit at exactly two spaces of indent under
    // `services:`; anything deeper belongs to the service above it.
    const starts = lines
      .map((line, index) => ({ index, match: /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line) }))
      .filter((entry) => entry.match !== null);
    for (const [position, entry] of starts.entries()) {
      const from = entry.index;
      const to = starts[position + 1]?.index ?? lines.length;
      const block = lines.slice(from, to).join('\n');
      if (!/'dmoj',/.test(block) || !/'judged',/.test(block)) continue;
      const flag = /'--only-executors',\s*'([^']+)'/.exec(block);
      found.set(entry.match![1]!, flag ? flag[1]!.split(',') : undefined);
    }
    return found;
  }

  it('gives every judge service the same allow-list', async () => {
    const compose = await readFile(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
    const services = judgeServices(compose);

    // `judge` and the profiled `judge-2` today. The assertion is that there
    // is at least one and that they all agree — NOT that there are exactly
    // two, which is what let a third slip past, and not that they are these
    // two, which would fail a province that legitimately adds a third.
    expect([...services.keys()], 'no service in docker-compose.yml runs dmoj judged').not.toEqual(
      [],
    );
    const missing = [...services].filter(([, list]) => list === undefined).map(([name]) => name);
    expect(missing, 'judge services with no --only-executors').toEqual([]);

    const lists = [...services.values()].map((list) => list!.join(','));
    expect(new Set(lists).size, `allow-lists disagree: ${lists.join(' | ')}`).toBe(1);
  });

  it('allows exactly the executors the migrations seed, in both directions', async () => {
    const compose = await readFile(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
    const allowed = [...judgeServices(compose).values()].flatMap((list) => list ?? []);

    await withTestDb(async (db) => {
      const rows = await db
        .select({ executorKey: schema.languageDriverKeys.executorKey })
        .from(schema.languageDriverKeys)
        .where(eq(schema.languageDriverKeys.driver, 'dmoj'))
        .orderBy(asc(schema.languageDriverKeys.executorKey));

      const seeded = rows.map((row) => row.executorKey);
      expect(seeded.length).toBeGreaterThan(0);

      // Superset (F-39's rule): a seeded language the judge is not allowed to
      // load is a language nobody can grade — D160's `blocked_reason`, with
      // the picker offering it anyway.
      const notAllowed = seeded.filter((executor) => !allowed.includes(executor));
      expect(notAllowed, 'seeded executors missing from --only-executors').toEqual([]);

      // Subset (F-47's addition): an allow-listed executor with no row is
      // announced by the judge and then DROPPED by `judged` (D172). Before
      // D172 it was silently renamed; after D172 it is silently ignored.
      // Either way the fix is the same one, and it belongs in CI.
      const notSeeded = [...new Set(allowed)].filter((executor) => !seeded.includes(executor));
      expect(notSeeded, 'allow-listed executors no language_driver_keys row names').toEqual([]);
    });
  });
});

/**
 * D133's lesson applied to 0046: a seed nobody dares re-run is a seed that
 * cannot be replayed onto a database that took a different path to today.
 */
describe('migration 0046 is idempotent', () => {
  it('re-runs and still leaves seven languages and seven executor mappings', async () => {
    await withTestDb(async (db) => {
      const migration = await readFile(
        new URL('../migrations/0046_pascal_and_java.sql', import.meta.url),
        'utf8',
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim() === '') continue;
        await db.execute(sql.raw(statement));
      }
      const counts = await db.execute<{ languages: number; mappings: number }>(
        sql`select (select count(*)::int from languages) as languages,
                   (select count(*)::int from language_driver_keys where driver = 'dmoj') as mappings`,
      );
      expect(counts[0]).toEqual({ languages: 7, mappings: 7 });
    });
  });
});
