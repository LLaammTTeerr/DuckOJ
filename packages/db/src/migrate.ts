import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Drizzle's migrator selects work by timestamp alone: it reads the single
 * newest `created_at` out of `drizzle.__drizzle_migrations` and runs every
 * journal entry stamped strictly after it. An entry that reaches the
 * repository *after* a later-stamped one has already been applied to a
 * database is therefore skipped on that database — silently, on every run,
 * forever, while `migrate` still prints success and exits 0. That is exactly
 * how production lost `0025_dashboard_bounds` (D131): four indexes behind the
 * admin dashboard existed on every fresh install and on no production row.
 *
 * Nothing in the repository can catch that — the journal is monotonic, the
 * files are all present, a fresh database applies all of them, and the guard
 * spec that asserts those things passed the whole time. Only the ledger of a
 * particular database can tell you, so this is checked here, after the
 * migrator has done its work, against the database being migrated (D133).
 *
 * Directional on purpose: every journal entry must be present in the ledger;
 * ledger rows the journal does not know about are left alone (a restored
 * backup, or an entry whose `when` was re-chained by
 * `scripts/merge-decisions.py`, can legitimately leave one behind).
 */
interface JournalEntry {
  when: number;
  tag: string;
}

function journalEntries(): JournalEntry[] {
  const raw = readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8');
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

export class MigrationDriftError extends Error {
  constructor(readonly missing: JournalEntry[]) {
    super(
      `migrations are missing from this database and drizzle will never apply them: ` +
        missing.map((e) => `${e.tag} (when=${e.when})`).join(', ') +
        `. Drizzle only runs entries newer than the newest already applied, so these ` +
        `are skipped on every future run (D131/D133). The remedy is an idempotent ` +
        `repair migration that also back-stamps the ledger, as ` +
        `0041_dashboard_bounds_repair does. Set DUCKOJ_ALLOW_MIGRATION_DRIFT=1 to ` +
        `proceed anyway.`,
    );
    this.name = 'MigrationDriftError';
  }
}

/**
 * `CREATE SCHEMA/TABLE/INDEX IF NOT EXISTS` raises a NOTICE per object that
 * was already there. Drizzle's own migrator raises two on every single run
 * (its schema and its ledger table), and 0041's four idempotent indexes add
 * four more — six lines of noise per migrate, in every deploy log and every
 * spec file that starts a container. They are the *expected* outcome of an
 * idempotent statement, so they are dropped; anything else Postgres has to
 * say still gets printed.
 */
const ALREADY_EXISTS = new Set(['42P06', '42P07', '42710']);

export async function runMigrations(url: string): Promise<void> {
  const sql = postgres(url, {
    max: 1,
    onnotice: (notice) => {
      if (!ALREADY_EXISTS.has(notice.code ?? '')) console.warn('[db]', notice.message);
    },
  });
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });

    const applied = await sql<{ created_at: string }[]>`
      select created_at::text as created_at from drizzle.__drizzle_migrations
    `;
    const stamps = new Set(applied.map((row) => Number(row.created_at)));
    const missing = journalEntries().filter((entry) => !stamps.has(entry.when));
    if (missing.length > 0) {
      if (process.env.DUCKOJ_ALLOW_MIGRATION_DRIFT === '1') {
        console.warn(
          `[db] DUCKOJ_ALLOW_MIGRATION_DRIFT=1: continuing with ${missing.length} unapplied ` +
            `migration(s): ${missing.map((e) => e.tag).join(', ')}`,
        );
      } else {
        throw new MigrationDriftError(missing);
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
