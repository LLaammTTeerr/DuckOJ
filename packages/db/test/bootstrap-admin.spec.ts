/**
 * `scripts/bootstrap-admin.ts` — the one command that mints the first admin
 * on a fresh database (docs/runbook.md, "Bootstrapping the first admin").
 *
 * Driven as a SUBPROCESS, the way `seed-script.spec.ts` drives the seed
 * script and for the same reason: the thing under test is the CLI an
 * operator actually types, including its exit codes and what it prints, and
 * its writes must be real committed rows visible over a second connection —
 * not a transaction `withTestDb` would roll back.
 *
 * This file starts its own container rather than sharing `harness.ts`'s.
 */
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrations, schema } from '../src/index.js';

const execFileAsync = promisify(execFile);

// Same podman shim as harness.ts — see its comment.
if (!process.env.DOCKER_HOST) {
  const podmanSocket = `/run/user/${process.getuid?.() ?? 1000}/podman/podman.sock`;
  if (!existsSync('/var/run/docker.sock') && existsSync(podmanSocket)) {
    process.env.DOCKER_HOST = `unix://${podmanSocket}`;
  }
}

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'bootstrap-admin.ts');
const TSX_BIN = join(REPO_ROOT, 'packages', 'db', 'node_modules', '.bin', 'tsx');

/**
 * The API's own argon2id parameters (`apps/api/src/authn/password.hash.ts`:
 * 19 MiB, 2 iterations, 1 lane), asserted through the encoded hash rather
 * than by importing across the workspace. This is the whole point of the
 * script not rolling its own KDF: a bootstrap admin whose password was
 * hashed with weaker parameters is a silently weaker account, and nothing
 * else in the system would ever notice.
 */
const API_ARGON2_PREFIX = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/;

let container: StartedPostgreSqlContainer | undefined;
let url: string | undefined;

const STOP_RETRY_DELAYS_MS = [500, 1000, 2000];

async function stopWithRetry(target: { stop(): Promise<unknown> }): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await target.stop();
      return;
    } catch (error) {
      if (attempt >= STOP_RETRY_DELAYS_MS.length) {
        console.warn('[packages/db bootstrap-admin.spec] failed to stop container after retries:', error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, STOP_RETRY_DELAYS_MS[attempt]));
    }
  }
}

afterAll(async () => {
  if (!container) return;
  await stopWithRetry(container);
}, 30_000);

async function dbUrl(): Promise<string> {
  if (url) return url;
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  url = container.getConnectionUri();
  await runMigrations(url);
  return url;
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

async function readUser(username: string): Promise<typeof schema.users.$inferSelect | undefined> {
  const { db, close } = createDb(await dbUrl());
  try {
    const rows = await db
      .select()
      .from(schema.users)
      .where(sql`lower(${schema.users.username}) = lower(${username})`);
    return rows[0];
  } finally {
    await close();
  }
}

describe('bootstrap-admin.ts', () => {
  it("creates a missing user as a verified admin, hashed with the API's own parameters", async () => {
    const result = await run([
      'bootadmin',
      '--email',
      'bootadmin@example.com',
      '--password',
      'a-long-enough-password',
    ]);
    expect(result.code).toBe(0);

    const user = await readUser('bootadmin');
    expect(user).toBeDefined();
    expect(user!.globalRole).toBe('admin');
    expect(user!.email).toBe('bootadmin@example.com');
    // `email_verified=true` in the brief; the real column is a timestamp.
    // A bootstrap admin must not be stuck behind a verification mail that
    // no configured SMTP server would deliver on a fresh install.
    expect(user!.emailVerifiedAt).not.toBeNull();
    // Never the plaintext, and never a KDF of the script's own invention.
    expect(user!.passwordHash).not.toBe('a-long-enough-password');
    expect(user!.passwordHash).toMatch(API_ARGON2_PREFIX);
    // It says what it did — an operator running this against a live
    // database must be able to tell "created" from "promoted" without
    // opening a psql session to check.
    expect(result.stdout).toMatch(/created/i);
  }, 180_000);

  it('only promotes an existing user — password and email are left alone', async () => {
    await run(['promoteme', '--email', 'promoteme@example.com', '--password', 'a-long-enough-password']);
    const before = await readUser('promoteme');
    expect(before).toBeDefined();

    // Demote so the second run has something to do.
    const { db, close } = createDb(await dbUrl());
    try {
      await db
        .update(schema.users)
        .set({ globalRole: 'user' })
        .where(sql`lower(${schema.users.username}) = lower('promoteme')`);
    } finally {
      await close();
    }

    const result = await run(['promoteme', '--password', 'a-different-password']);
    expect(result.code).toBe(0);

    const after = await readUser('promoteme');
    expect(after!.globalRole).toBe('admin');
    // The whole risk of a "bootstrap" command: silently resetting the
    // password of a real, in-use account because someone re-ran it.
    expect(after!.passwordHash).toBe(before!.passwordHash);
    expect(after!.email).toBe('promoteme@example.com');
    expect(result.stdout).toMatch(/promoted/i);
  }, 180_000);

  it('refuses an empty password instead of creating an unloggable admin', async () => {
    const result = await run(['emptypw', '--password', '']);
    expect(result.code).not.toBe(0);
    expect(await readUser('emptypw')).toBeUndefined();
  }, 180_000);

  it('generates and prints a random password when none is given', async () => {
    const first = await run(['randompw1']);
    const second = await run(['randompw2']);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);

    const shown = /password:\s*(\S+)/i;
    const a = shown.exec(first.stdout)?.[1];
    const b = shown.exec(second.stdout)?.[1];
    expect(a).toBeDefined();
    expect(a!.length).toBeGreaterThanOrEqual(16);
    // Random, not a constant the next operator could read off these docs.
    expect(b).not.toBe(a);

    const user = await readUser('randompw1');
    expect(user!.globalRole).toBe('admin');
    expect(user!.passwordHash).toMatch(API_ARGON2_PREFIX);
    // Printed once, never stored in the clear.
    expect(user!.passwordHash).not.toContain(a!);
  }, 180_000);
});
