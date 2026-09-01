/**
 * D175 — the digits a `double precision` is rendered with are pinned where the
 * connection is made, and migration 0045's own `SET LOCAL` is asserted rather
 * than assumed.
 *
 * **What this is defending.** `submissions.subtask_summary` (D165) is the cold
 * scoreboard fold's only input for a finished submission, and the numbers in
 * it are `double precision`. Migration 0045 backfilled it with
 * `to_jsonb(sc.points)` and had to set `extra_float_digits` to do it: at 0,
 * `float8out` writes 15 digits rather than the shortest exactly-round-tripping
 * form, and 48 861 of 50 000 generated values failed to survive the trip on
 * the live cluster.
 *
 * B-32 then checked the doors around that guard and found one still open,
 * recorded as **O1**: the sessions that *read* `submission_cases.points` as
 * `float8` over the wire before summing — `EventWriter.writeTerminal` and the
 * fold's residue read — took the cluster's default, pinned by nothing. This
 * cluster reports 1, which is safe. A province's Postgres is not this one, and
 * `ALTER DATABASE … SET extra_float_digits = 0` is a thing an administrator
 * can do; the consequence is a value read back for a fold that differs in its
 * last bits from the value the judge wrote — a wrong scoreboard, reported as a
 * right one, on their hardware and not ours.
 *
 * So every test below runs against a database whose **own default has been set
 * to 0**. That is the hostile province, built rather than imagined, and it is
 * also what settles by measurement a question that would otherwise be settled
 * by reading the manual: a startup-packet parameter wins over `ALTER DATABASE
 * … SET`.
 *
 * The last describe block is B-32's **O3** — 0045's `SET LOCAL` holds only
 * because drizzle wraps a migration's statements in one transaction, which was
 * verified by reading a dependency and which a drizzle upgrade can change
 * silently. It carries its own negative control, so it cannot go quietly
 * vacuous the way an assertion about a setting that was already right can.
 *
 * Its own container, not `harness.ts`'s: the harness hands out a rolled-back
 * transaction on one shared migrated database, and `ALTER DATABASE` is neither
 * transactional nor something to do to a database other specs are using.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { createDb } from '../src/index.js';

// The same podman shim `harness.ts` carries — repeated rather than imported
// because importing that module would also install its `afterAll`, which
// stops a container this file never starts.
if (!process.env.DOCKER_HOST) {
  const podmanSocket = `/run/user/${process.getuid?.() ?? 1000}/podman/podman.sock`;
  if (!existsSync('/var/run/docker.sock') && existsSync(podmanSocket)) {
    process.env.DOCKER_HOST = `unix://${podmanSocket}`;
  }
}

/**
 * A value chosen because it is one B-32 measured failing: at
 * `extra_float_digits = 0`, `to_jsonb(1::float8/3)` renders
 * `0.333333333333333`, which parses back to a *different* double. At any
 * value above 0 it renders the shortest form that parses back to the same one.
 */
const ADVERSARIAL = '(1::float8 / 3::float8)';
/** What `1/3` is, exactly, in JavaScript — the same double Postgres holds. */
const ONE_THIRD = 1 / 3;

let container: StartedPostgreSqlContainer | undefined;
/** A database whose OWN default is 0 — the province whose cluster is not ours. */
let hostileUrl: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const adminUrl = container.getConnectionUri();
  const admin = postgres(adminUrl, { max: 1 });
  try {
    // `CREATE DATABASE` cannot run inside a transaction block, and postgres.js
    // does not open one for a bare query, so these go straight through.
    await admin.unsafe('create database province_zero');
    await admin.unsafe('alter database province_zero set extra_float_digits = 0');
  } finally {
    await admin.end({ timeout: 5 });
  }
  const parsed = new URL(adminUrl);
  parsed.pathname = '/province_zero';
  hostileUrl = parsed.toString();
}, 180_000);

afterAll(async () => {
  await container?.stop();
  container = undefined;
}, 60_000);

/**
 * What the database itself says this session's setting is.
 *
 * `current_setting(...)`, not `SHOW`: `SHOW` names its column after the
 * setting and takes no alias, so reading it by a fixed key silently yields
 * `undefined` and every assertion below would compare `undefined` to `'3'` —
 * red for the wrong reason, and worse, green for the wrong reason if anybody
 * later asserted `not.toBe`.
 */
async function showDigits(db: ReturnType<typeof createDb>['db']): Promise<string> {
  const rows = await db.execute<{ v: string }>(sql`select current_setting('extra_float_digits') as v`);
  return rows[0]!.v;
}

async function backendPid(db: ReturnType<typeof createDb>['db']): Promise<number> {
  const rows = await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
  return Number(rows[0]!.pid);
}

describe('createDb, against a cluster whose default would truncate a double (D175, B-32 O1)', () => {
  it('pins the digits the connection renders a float8 with, over the database own default', async () => {
    // The database really is hostile — asserted, not assumed, because every
    // claim below is only interesting if this is 0.
    const bare = postgres(hostileUrl, { max: 1 });
    try {
      const rows = await bare.unsafe<{ v: string }[]>(
        `select current_setting('extra_float_digits') as v`,
      );
      expect(rows[0]!.v).toBe('0');
    } finally {
      await bare.end({ timeout: 5 });
    }

    const { db, close } = createDb(hostileUrl);
    try {
      expect(await showDigits(db)).toBe('3');
    } finally {
      await close();
    }
  });

  it('survives a connection the server dropped, because it rides the startup packet', async () => {
    const { db, close } = createDb(hostileUrl);
    try {
      const first = await backendPid(db);
      expect(await showDigits(db)).toBe('3');

      // The pool recycles for real: the backend is killed from under it, and
      // postgres.js opens a replacement. A pin issued as a `SET` after
      // connecting — an `onconnect` hook, or a statement the first query runs
      // — would be gone on the connection that comes back, and a session
      // setting a pool resets is a pin that is not there.
      await db
        .execute(sql`select pg_terminate_backend(pg_backend_pid())`)
        .catch(() => undefined);

      let second = first;
      // The terminate can surface as a rejected query or as a closed socket
      // the next query reopens; either way the next successful statement is
      // on a new backend. Retry rather than sleep, so this is bounded by the
      // reconnect and not by a guess at how long one takes.
      for (let attempt = 0; attempt < 20 && second === first; attempt += 1) {
        try {
          second = await backendPid(db);
        } catch {
          second = first;
        }
      }
      expect(second, 'the pool never opened a replacement connection').not.toBe(first);
      expect(await showDigits(db)).toBe('3');
    } finally {
      await close();
    }
  });

  it('is the session RESET value, so DISCARD ALL returns to it rather than to the cluster default', async () => {
    const { db, close } = createDb(hostileUrl);
    try {
      // A startup-packet parameter becomes what `RESET` resets *to*. A `SET`
      // issued after connecting does not: `DISCARD ALL` would drop it back to
      // 0 and nothing in the application would notice. `DISCARD ALL` is what
      // a connection pooler in front of Postgres issues between clients, so
      // this is not a hypothetical for a province that puts one there.
      await db.execute(sql`set extra_float_digits = 0`);
      expect(await showDigits(db)).toBe('0');
      await db.execute(sql`discard all`);
      expect(await showDigits(db)).toBe('3');
      await db.execute(sql`set extra_float_digits = 0`);
      await db.execute(sql`reset all`);
      expect(await showDigits(db)).toBe('3');
    } finally {
      await close();
    }
  });

  it('is the difference between a double that round-trips and one that does not', async () => {
    // The property the pin exists for, rather than the setting it is spelled
    // with: the same value, over the same database, read by two connections.
    const bare = postgres(hostileUrl, { max: 1 });
    const { db, close } = createDb(hostileUrl);
    try {
      const truncated = await bare.unsafe<{ t: string }[]>(`select ${ADVERSARIAL}::text as t`);
      expect(Number(truncated[0]!.t)).not.toBe(ONE_THIRD);

      const pinned = await db.execute<{ t: string }>(sql.raw(`select ${ADVERSARIAL}::text as t`));
      expect(Number(pinned[0]!.t)).toBe(ONE_THIRD);

      // And through the seam D165 actually crosses — `to_jsonb` of a float8,
      // rendered by the server, parsed back by `JSON.parse`.
      const stored = await db.execute<{ j: string }>(
        sql.raw(`select to_jsonb(${ADVERSARIAL})::text as j`),
      );
      expect(JSON.parse(stored[0]!.j)).toBe(ONE_THIRD);
    } finally {
      await close();
      await bare.end({ timeout: 5 });
    }
  });
});

/**
 * Migration 0045's `SET LOCAL` line, read out of the migration rather than
 * copied — `contest-scoreboard-fold-plan.spec.ts`'s idiom for its backfill.
 * Deleting the line from the migration reds this file rather than quietly
 * removing what it is about.
 */
function migration0045SetLocal(): string {
  const source = readFileSync(
    fileURLToPath(new URL('../migrations/0045_f45_subtask_summary.sql', import.meta.url)),
    'utf8',
  );
  const line = source
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^SET LOCAL extra_float_digits/i.test(l));
  expect(line, 'migration 0045 no longer contains its SET LOCAL (D165)').toBeTruthy();
  return line!;
}

/** A migrations folder holding exactly the statements handed to it. */
function scratchMigrations(statements: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'duckoj-float-pin-'));
  mkdirSync(join(dir, 'meta'));
  writeFileSync(join(dir, '0000_pin.sql'), statements.join('--> statement-breakpoint\n'));
  writeFileSync(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: [{ idx: 0, version: '7', when: 1, tag: '0000_pin', breakpoints: true }],
    }),
  );
  return dir;
}

describe("migration 0045's own SET LOCAL (B-32 O3)", () => {
  /**
   * The statements, in 0045's shape: a table, then the setting, then a write
   * that renders a `float8` **server-side** — which is the only kind of write
   * the setting can reach, and the kind 0045's backfill makes.
   */
  function statements(table: string): string[] {
    return [
      `create table ${table} (id int primary key, v jsonb)`,
      migration0045SetLocal(),
      `insert into ${table} (id, v) values (1, to_jsonb(${ADVERSARIAL}))`,
    ];
  }

  /** Read back over a PINNED connection, so the reader is not the variable. */
  async function storedValue(table: string): Promise<unknown> {
    const { db, close } = createDb(hostileUrl);
    try {
      const rows = await db.execute<{ j: string }>(sql.raw(`select v::text as j from ${table}`));
      return JSON.parse(rows[0]!.j);
    } finally {
      await close();
    }
  }

  it('holds across the statement below it, because drizzle runs a migration in one transaction', async () => {
    // Through the real migrator, on a plain pool with no pin of its own —
    // exactly what `runMigrations` builds. If a drizzle upgrade stops
    // wrapping migrations in a transaction, `SET LOCAL` becomes a no-op with
    // a warning and this goes red, which is the whole point of asserting a
    // mechanism that is currently true by dependency.
    const folder = scratchMigrations(statements('pin_via_migrator'));
    const client = postgres(hostileUrl, { max: 1 });
    try {
      await migrate(drizzle(client), { migrationsFolder: folder });
    } finally {
      await client.end({ timeout: 5 });
      rmSync(folder, { recursive: true, force: true });
    }
    expect(await storedValue('pin_via_migrator')).toBe(ONE_THIRD);
  });

  it('does nothing at all when those same statements are not in one transaction', async () => {
    // The negative control, and the reason the assertion above is not
    // vacuous: on a cluster whose default is already above 0 it would pass
    // with the `SET LOCAL` deleted. Here the identical statements, issued one
    // by one outside any transaction, store the truncated value — `SET LOCAL`
    // outside a transaction block is a no-op that Postgres only warns about.
    //
    // The warning is CAPTURED rather than printed: it is the mechanism's own
    // account of what went wrong, and asserting it is what distinguishes
    // "the setting did not apply" from "the statement never ran".
    const notices: string[] = [];
    const client = postgres(hostileUrl, {
      max: 1,
      onnotice: (notice) => notices.push(notice.message ?? ''),
    });
    try {
      for (const statement of statements('pin_without_transaction')) {
        await client.unsafe(statement);
      }
    } finally {
      await client.end({ timeout: 5 });
    }
    expect(notices).toContain('SET LOCAL can only be used in transaction blocks');
    expect(await storedValue('pin_without_transaction')).not.toBe(ONE_THIRD);
  });
});
