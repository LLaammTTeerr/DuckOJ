/**
 * `scripts/org-import.ts` — D61's roster import for an admin with no browser
 * (docs/DECISIONS.md D61, "the CLI goes through the database").
 *
 * Driven as a SUBPROCESS, exactly as `bootstrap-admin.spec.ts` drives its
 * neighbour and for the same reasons: the thing under test is the command an
 * operator types, including its exit codes and what it writes to which
 * stream, and its writes must be real committed rows visible over a second
 * connection.
 *
 * The property that makes this file worth having is not that the CLI works —
 * it is that the CLI and the API agree. Both run
 * `apps/api/src/authz/org-import.core.ts`, so the assertions here are the
 * same ones `apps/api/test/org-member-import.spec.ts` makes over HTTP: the
 * accounts are flagged, they land on the roster, and one bad row creates
 * nothing at all.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrations, schema, type Db } from '../src/index.js';
import { orgMembers, organizations } from '../src/schema/guarded.js';

const execFileAsync = promisify(execFile);

// Same podman shim as harness.ts — see its comment.
if (!process.env.DOCKER_HOST) {
  const podmanSocket = `/run/user/${process.getuid?.() ?? 1000}/podman/podman.sock`;
  if (!existsSync('/var/run/docker.sock') && existsSync(podmanSocket)) {
    process.env.DOCKER_HOST = `unix://${podmanSocket}`;
  }
}

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'org-import.ts');
const TSX_BIN = join(REPO_ROOT, 'packages', 'db', 'node_modules', '.bin', 'tsx');

let container: StartedPostgreSqlContainer | undefined;
let url: string | undefined;

afterAll(async () => {
  if (!container) return;
  try {
    await container.stop();
  } catch {
    // Rootless podman occasionally fails to tear a netns down; a stopped
    // container is not worth failing this file over (see db.harness.ts).
  }
}, 30_000);

async function dbUrl(): Promise<string> {
  if (url) return url;
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  url = container.getConnectionUri();
  await runMigrations(url);
  return url;
}

async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const { db, close } = createDb(await dbUrl());
  try {
    return await fn(db);
  } finally {
    await close();
  }
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(args: string[]): Promise<RunResult> {
  const connectionUrl = await dbUrl();
  try {
    const { stdout, stderr } = await execFileAsync(TSX_BIN, [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: connectionUrl },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** A school with one owner, and the owner's id. */
async function seedSchool(slug: string): Promise<number> {
  return withDb(async (db) => {
    const [owner] = await db
      .insert(schema.users)
      .values({
        username: `${slug}-owner`,
        email: `${slug}-owner@e.com`,
        displayName: 'Hieu truong',
        passwordHash: 'x',
      })
      .returning({ id: schema.users.id });
    const [org] = await db
      .insert(organizations)
      .values({ slug, name: `THPT ${slug}` })
      .returning({ id: organizations.id });
    await db.insert(orgMembers).values({ orgId: org!.id, userId: owner!.id, role: 'owner' });
    return owner!.id;
  });
}

async function csvFile(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'duckoj-roster-'));
  const path = join(dir, name);
  await writeFile(path, body, 'utf8');
  return path;
}

describe('org-import.ts', () => {
  it('creates flagged accounts on the roster and prints the credentials once', async () => {
    const ownerId = await seedSchool('cli-a');
    const file = await csvFile('roster.csv', 'username,name\nhs101,Nguyễn Văn A\nhs102,Trần Thị B\n');

    const result = await run(['cli-a', file]);
    expect(result.code).toBe(0);
    // The sheet goes to stdout so `> accounts.csv` works, and the warning to
    // stderr so it is not captured into that file. `> accounts.csv` is
    // exactly why the BOM and the CRLF belong here too (D71's rule, now
    // shared by every CSV this judge exports): the file that redirect
    // produces is opened in Excel by the teacher who ran the import.
    expect(result.stdout.split('\r\n')[0]).toBe('\ufeffusername,displayName,password');
    expect(result.stdout).toContain('hs101');
    expect(result.stderr).toContain('cannot be recovered');

    await withDb(async (db) => {
      const rows = await db
        .select()
        .from(schema.users)
        .where(sql`${schema.users.username} in ('hs101','hs102')`);
      expect(rows).toHaveLength(2);
      // The same rule the API runs, because it is literally the same module.
      for (const row of rows) {
        expect(row.mustChangePassword).toBe(true);
        expect(row.email).toBe(`${row.username}@cli-a.import.invalid`);
        expect(row.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      }
      const [org] = await db.select().from(organizations).where(eq(organizations.slug, 'cli-a'));
      const roster = await db.select().from(orgMembers).where(eq(orgMembers.orgId, org!.id));
      expect(roster.filter((m) => m.role === 'member')).toHaveLength(2);
      // D14 — the owners hear about it even though nobody was signed in.
      const notes = await db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.userId, ownerId));
      expect(notes).toHaveLength(1);
      expect(notes[0]!.kind).toBe('org_members_imported');
      expect(notes[0]!.payload).toMatchObject({ orgSlug: 'cli-a', count: 2, by: null });
    });
  }, 120_000);

  it('creates nothing on --dry-run', async () => {
    await seedSchool('cli-b');
    const file = await csvFile('roster.csv', 'hs201,Nguyễn Văn C\n');
    const result = await run(['cli-b', file, '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('1 row(s) validated');
    await withDb(async (db) => {
      expect(await db.select().from(schema.users).where(eq(schema.users.username, 'hs201'))).toHaveLength(0);
    });
  }, 120_000);

  it('exits 2 naming every bad row, and creates nothing at all', async () => {
    await seedSchool('cli-c');
    const file = await csvFile('roster.csv', 'hs301,Ổn\nx,Tên đăng nhập quá ngắn\nhs303,\n');
    const result = await run(['cli-c', file]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('refused: nothing was created');
    expect(result.stderr).toContain('row 2 (username)');
    expect(result.stderr).toContain('row 3 (displayName)');
    await withDb(async (db) => {
      expect(await db.select().from(schema.users).where(eq(schema.users.username, 'hs301'))).toHaveLength(0);
    });
  }, 120_000);

  it('refuses an unknown option rather than ignoring it, and names a school it cannot find', async () => {
    const file = await csvFile('roster.csv', 'hs401,A\n');
    // A mistyped `--dry-run` that is silently dropped creates a roster.
    const typo = await run(['cli-a', file, '--dryrun']);
    expect(typo.code).toBe(1);
    expect(typo.stderr).toContain('unknown option: --dryrun');

    const missing = await run(['no-such-school', file]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('no such organization: no-such-school');
  }, 120_000);
});
