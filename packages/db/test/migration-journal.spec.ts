/**
 * F-4's concern: `migrations/` jumps from `0019_totp_recovery_codes` to
 * `0021_editorials` with no `0020`, so is the journal still coherent and does
 * a fresh database still migrate from zero?
 *
 * **It does, and the gap is harmless** — but nothing checked either claim, and
 * both are the kind that stay true only until they suddenly are not. `0020`
 * was a number reserved in a brief and never spent; drizzle-kit derives the
 * next index from `lastEntry.idx + 1`, not from `entries.length`, so it will
 * hand out `0022` rather than colliding with the existing `0021`, and
 * drizzle-orm's migrator walks the journal's entries in order and never
 * infers anything from the numbers themselves.
 *
 * What this file pins is the set of invariants that would actually break if
 * somebody hand-edited the journal, deleted a `.sql`, renamed one, or resolved
 * a merge conflict in `_journal.json` by keeping both sides:
 *
 *  - journal <-> `.sql` <-> snapshot are the same set, exactly;
 *  - `idx` and `when` are strictly increasing (order is what the migrator
 *    executes by — a journal reordered by a bad merge would run 0018 after
 *    0021 with every file still present);
 *  - the snapshot chain's `prevId`/`id` links are intact, which is what
 *    `drizzle-kit generate` diffs the next migration against;
 *  - and, over a real Postgres started from nothing, every entry actually
 *    applies and lands in `drizzle.__drizzle_migrations`.
 *
 * The last one is the only proof that matters for "a fresh province can
 * deploy this". Every other spec in this package migrates a container too,
 * but all of them do it inside a shared harness that would report a broken
 * migration as "some unrelated test could not find a table".
 *
 * D131 then found the hole every assertion above leaves open: production had
 * applied 34 of 35 migrations, and *nothing here could have said so*. The
 * journal was monotonic, the files were all present, a fresh database applied
 * every one of them — and `0025_dashboard_bounds` was still missing from the
 * live database forever, because it reached `main` after a later-stamped
 * migration had already been applied there and drizzle's migrator only runs
 * entries newer than the newest already applied. No property of the
 * repository distinguishes that state; only a particular database's ledger
 * does. So the guard that actually closes this class lives in
 * `runMigrations` (D133) — every journal entry must be present in the ledger
 * once the migrator has finished, or the run throws instead of exiting 0 —
 * and the last describe block below is that guard put through the exact
 * production shape: 34 rows, 0025 skipped, 0041 repairing it.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { runMigrations } from '../src/index.js';

// The same podman shim `harness.ts` carries — repeated rather than imported
// because importing that module would also install its `afterAll`, which
// stops a container this file never starts.
if (!process.env.DOCKER_HOST) {
  const podmanSocket = `/run/user/${process.getuid?.() ?? 1000}/podman/podman.sock`;
  if (!existsSync('/var/run/docker.sock') && existsSync(podmanSocket)) {
    process.env.DOCKER_HOST = `unix://${podmanSocket}`;
  }
}

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function journal(): { entries: JournalEntry[] } {
  return JSON.parse(readFileSync(`${migrationsDir}/meta/_journal.json`, 'utf8')) as {
    entries: JournalEntry[];
  };
}

function names(dir: string, suffix: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .map((f) => f.slice(0, -suffix.length))
    .sort();
}

/**
 * The objects `0025_dashboard_bounds` creates — the ones D131 found missing
 * from production — and `0041_dashboard_bounds_repair` re-creates with
 * `IF NOT EXISTS`.
 */
const DASHBOARD_INDEXES = [
  'grading_jobs_active_idx',
  'grading_jobs_submission_idx',
  'submissions_failed_idx',
  'submissions_judged_at_idx',
];

async function indexNames(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ indexname: string }[]>`
    select indexname from pg_indexes
     where schemaname = 'public' and indexname = any(${DASHBOARD_INDEXES})
     order by indexname
  `;
  return rows.map((r) => r.indexname);
}

async function stamps(sql: postgres.Sql): Promise<number[]> {
  const rows = await sql<{ created_at: string }[]>`
    select created_at::text as created_at from drizzle.__drizzle_migrations order by created_at
  `;
  return rows.map((r) => Number(r.created_at));
}

describe('the migration journal', () => {
  it('lists exactly the .sql files on disk, and nothing else', () => {
    const tags = journal().entries.map((e) => e.tag);
    expect([...tags].sort()).toEqual(names(migrationsDir, '.sql'));
  });

  it('has one snapshot per entry', () => {
    const prefixes = journal().entries.map((e) => e.tag.slice(0, 4));
    expect([...prefixes].sort()).toEqual(names(`${migrationsDir}/meta`, '_snapshot.json'));
  });

  it('is strictly ordered by idx and by timestamp', () => {
    const entries = journal().entries;
    for (let i = 1; i < entries.length; i += 1) {
      // Strictly increasing, not merely non-decreasing: two entries sharing
      // an idx is the shape a merge conflict resolved by keeping both sides
      // produces, and it silently makes execution order depend on array
      // position alone.
      expect(entries[i]!.idx).toBeGreaterThan(entries[i - 1]!.idx);
      expect(entries[i]!.when).toBeGreaterThan(entries[i - 1]!.when);
    }
    // The gap itself is fine and deliberately not asserted away: `0020` was
    // reserved and never used, and drizzle-kit's next index is
    // `lastEntry.idx + 1`, so nothing downstream counts on contiguity.
    expect(entries.map((e) => e.idx)).not.toContain(20);
  });

  it('keeps the snapshot chain intact', () => {
    let previousId: string | undefined;
    for (const prefix of names(`${migrationsDir}/meta`, '_snapshot.json')) {
      const snapshot = JSON.parse(
        readFileSync(`${migrationsDir}/meta/${prefix}_snapshot.json`, 'utf8'),
      ) as { id: string; prevId: string };
      if (previousId !== undefined) {
        expect(snapshot.prevId, `${prefix}_snapshot.json is not chained to its predecessor`).toBe(
          previousId,
        );
      }
      previousId = snapshot.id;
    }
  });
});

describe('a database with nothing in it', () => {
  let container: StartedPostgreSqlContainer | undefined;

  afterAll(async () => {
    await container?.stop();
    container = undefined;
  }, 60_000);

  it('migrates from zero, applying every journal entry', async () => {
    // Its own container, not the shared harness's: the harness migrates once
    // at module load and hands out a transaction, so a fresh-database claim
    // proved through it would be proving something about a database the
    // harness had already migrated.
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    const url = container.getConnectionUri();

    await runMigrations(url);

    const sql = postgres(url, { max: 1 });
    try {
      const applied = await sql<{ count: string }[]>`
        select count(*)::text as count from drizzle.__drizzle_migrations
      `;
      expect(Number(applied[0]!.count)).toBe(journal().entries.length);

      // A column added mid-journal (0021_editorials), so this fails if an
      // entry is listed but never actually runs — the failure a numbering gap
      // was suspected of causing.
      const editorial = await sql<{ present: boolean }[]>`
        select count(*) > 0 as present
          from information_schema.columns
         where table_name = 'problems' and column_name = 'editorial_published_at'
      `;
      expect(editorial[0]!.present).toBe(true);

      // The four indexes 0025 creates and 0041 re-creates idempotently. On a
      // fresh database 0025 makes them and 0041 is a no-op; asserting them
      // here pins that the repair migration did not disturb the fresh path
      // (it is the last entry, so this doubles as "the final entry ran").
      expect(await indexNames(sql)).toEqual(DASHBOARD_INDEXES);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 300_000);
});

/**
 * Production, reproduced exactly (D131/D133).
 *
 * The setup does not hand-replay SQL: it copies the real migrations folder to
 * a temporary directory, removes `0025_dashboard_bounds` and the repair from
 * *the copy's* journal, and lets drizzle's own migrator apply what is left.
 * That leaves a database in the precise state the live one was measured in —
 * 34 ledger rows, newest stamp `0040`'s, and not one of 0025's indexes — and
 * it leaves it there the way production got there, by drizzle's own rules
 * rather than by a fixture asserting itself.
 */
describe('a database that skipped a migration, the way production did', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let tempFolder: string | undefined;

  afterAll(async () => {
    await container?.stop();
    container = undefined;
    if (tempFolder) rmSync(tempFolder, { recursive: true, force: true });
    tempFolder = undefined;
  }, 60_000);

  const SKIPPED = '0025_dashboard_bounds';
  const REPAIR = '0041_dashboard_bounds_repair';

  it('is repaired by 0041, and repairing it twice changes nothing', async () => {
    tempFolder = mkdtempSync(join(tmpdir(), 'duckoj-migrations-'));
    cpSync(migrationsDir, tempFolder, { recursive: true });
    // The database this reconstructs is production AS IT STOOD the moment
    // before the repair shipped: 0025 skipped, 0041 not yet written, and
    // therefore nothing that came after 0041 applied either.
    //
    // The last clause is not tidiness — it is the same D131 rule the whole
    // test is about, turned on the fixture. Drizzle runs only entries newer
    // than the newest already applied, so leaving a POST-repair migration in
    // this journal stamps the ledger past 0041's `when` and the repair can
    // never run: the test would fail claiming the repair is broken, when what
    // is really broken is the scenario. Found when 0042 was added (F-39).
    const repairWhen = journal().entries.find((e) => e.tag === REPAIR)!.when;
    const withoutSkipped = journal().entries.filter(
      (e) => e.tag !== SKIPPED && e.tag !== REPAIR && e.when < repairWhen,
    );
    writeFileSync(
      join(tempFolder, 'meta', '_journal.json'),
      JSON.stringify({ version: '7', dialect: 'postgresql', entries: withoutSkipped }, null, 2),
    );

    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    const url = container.getConnectionUri();

    // --- production's state, produced by drizzle itself -------------------
    const setup = postgres(url, { max: 1 });
    try {
      await migrate(drizzle(setup), { migrationsFolder: tempFolder });
    } finally {
      await setup.end({ timeout: 5 });
    }

    const sql = postgres(url, { max: 1 });
    try {
      expect(await stamps(sql)).toHaveLength(withoutSkipped.length);
      // The defect itself: 0025's stamp is older than the newest applied one,
      // so drizzle's `created_at desc limit 1` rule can never reach it again.
      const skipped = journal().entries.find((e) => e.tag === SKIPPED)!;
      expect(Math.max(...(await stamps(sql)))).toBeGreaterThan(skipped.when);
      expect(await indexNames(sql)).toEqual([]);

      // --- the repair -----------------------------------------------------
      await runMigrations(url);

      expect(await indexNames(sql)).toEqual(DASHBOARD_INDEXES);
      // 0041 back-stamps 0025 as well as re-creating its objects, so the
      // ledger stops lying about what this database contains and the drift
      // check in `runMigrations` has something true to verify against.
      expect(await stamps(sql)).toContain(skipped.when);
      expect(await stamps(sql)).toHaveLength(journal().entries.length);

      // --- and again: a no-op ---------------------------------------------
      const afterRepair = await stamps(sql);
      await runMigrations(url);
      expect(await stamps(sql)).toEqual(afterRepair);
      expect(await indexNames(sql)).toEqual(DASHBOARD_INDEXES);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 300_000);

  /**
   * The guard itself, on the database the previous test left healthy: take
   * one row back out of the ledger and the next run has nothing to apply
   * (every stamp is older than the newest one) — which used to mean "exit 0,
   * say nothing" and now means a named failure. Runs second on purpose, so it
   * reuses that container rather than paying for a third one.
   */
  it('refuses to report success while a journal entry is unapplied', async () => {
    const url = container!.getConnectionUri();
    const skipped = journal().entries.find((e) => e.tag === SKIPPED)!;
    const sql = postgres(url, { max: 1 });
    try {
      await sql`delete from drizzle.__drizzle_migrations where created_at = ${skipped.when}`;

      await expect(runMigrations(url)).rejects.toThrow(/0025_dashboard_bounds/);
      // Nothing was applied — drizzle had no entry newer than the newest
      // stamp — so without this check the run would have exited 0.
      expect(await stamps(sql)).toHaveLength(journal().entries.length - 1);

      // The operator's documented way past it, for a drift that is understood
      // and being repaired by hand.
      process.env.DUCKOJ_ALLOW_MIGRATION_DRIFT = '1';
      try {
        await expect(runMigrations(url)).resolves.toBeUndefined();
      } finally {
        delete process.env.DUCKOJ_ALLOW_MIGRATION_DRIFT;
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 120_000);
});
