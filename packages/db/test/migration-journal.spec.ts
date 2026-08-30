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
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
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

      // A column added by the LAST entry in the journal (0021_editorials),
      // so this fails if the final migration is listed but never actually
      // runs — the exact failure a numbering gap was suspected of causing.
      const editorial = await sql<{ present: boolean }[]>`
        select count(*) > 0 as present
          from information_schema.columns
         where table_name = 'problems' and column_name = 'editorial_published_at'
      `;
      expect(editorial[0]!.present).toBe(true);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 300_000);
});
