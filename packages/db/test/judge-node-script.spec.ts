/**
 * `scripts/judge-node.ts` — the command that registers a judge, replacing
 * the runbook's hand-typed `insert ... encode(sha256(...))` (D68).
 *
 * Driven as a SUBPROCESS, exactly as `bootstrap-admin.spec.ts` drives its
 * script and for the same reason: what is under test is the CLI an operator
 * types, including the token it prints, and the credential it mints has to
 * verify through the same `verifyJudgeCredential` the bridge and the API
 * both call.
 */
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrations, schema, verifyJudgeCredential } from '../src/index.js';

const execFileAsync = promisify(execFile);

// Same podman shim as harness.ts — see its comment.
if (!process.env.DOCKER_HOST) {
  const podmanSocket = `/run/user/${process.getuid?.() ?? 1000}/podman/podman.sock`;
  if (!existsSync('/var/run/docker.sock') && existsSync(podmanSocket)) {
    process.env.DOCKER_HOST = `unix://${podmanSocket}`;
  }
}

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'judge-node.ts');
const TSX_BIN = join(REPO_ROOT, 'packages', 'db', 'node_modules', '.bin', 'tsx');

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
        console.warn('[packages/db judge-node-script.spec] failed to stop container:', error);
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

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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

/** The token the script printed, from the one line that carries it. */
function printedToken(stdout: string): string {
  const match = /^token: (\S+)$/m.exec(stdout);
  if (!match) throw new Error(`no token in output:\n${stdout}`);
  return match[1]!;
}

describe('judge-node.ts', () => {
  it('mints a token that authenticates the node, and stores only its hash', async () => {
    const result = await run(['add', 'judge-7']);
    expect(result.code).toBe(0);
    const token = printedToken(result.stdout);
    // 32 bytes hex, the shape the runbook's `openssl rand -hex 32` produced.
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const { db, close } = createDb(await dbUrl());
    try {
      // The credential works through the same function the bridge handshake
      // and the API's package guard both call — the point of the script.
      expect(await verifyJudgeCredential(db, 'judge-7', token)).toBe(true);
      expect(await verifyJudgeCredential(db, 'judge-7', 'not-the-token')).toBe(false);

      const [row] = await db
        .select()
        .from(schema.judgeNodes)
        .where(eq(schema.judgeNodes.name, 'judge-7'));
      expect(row?.driver).toBe('dmoj');
      // The raw token must not be recoverable from the row.
      expect(row?.tokenHash).not.toBe(token);
    } finally {
      await close();
    }
  }, 180_000);

  it('refuses to re-register a name rather than silently rotating a live judge out', async () => {
    await run(['add', 'judge-dup']);

    const second = await run(['add', 'judge-dup']);

    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain('already exists');
  }, 180_000);

  it('lists nodes with their revoked state, and never a token', async () => {
    const added = await run(['add', 'judge-listed']);
    const token = printedToken(added.stdout);

    const listed = await run(['list']);

    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain('judge-listed');
    expect(listed.stdout).toContain('"revoked":false');
    expect(listed.stdout).not.toContain(token);
  }, 180_000);

  it('revoke refuses the credential but keeps the row, so grading history still joins', async () => {
    const added = await run(['add', 'judge-gone']);
    const token = printedToken(added.stdout);

    const revoked = await run(['revoke', 'judge-gone']);
    expect(revoked.code).toBe(0);

    const { db, close } = createDb(await dbUrl());
    try {
      expect(await verifyJudgeCredential(db, 'judge-gone', token)).toBe(false);
      // Deleting the row would SET NULL every `grading_jobs.judge_node_id`
      // that ever pointed at it — the join D68 exists to create.
      const rows = await db
        .select()
        .from(schema.judgeNodes)
        .where(eq(schema.judgeNodes.name, 'judge-gone'));
      expect(rows).toHaveLength(1);
    } finally {
      await close();
    }

    // Idempotent, and it says so rather than double-burning the hash.
    const again = await run(['revoke', 'judge-gone']);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('already revoked');
  }, 180_000);

  it('refuses an unknown name and an unknown command, with a usage line', async () => {
    const unknownNode = await run(['revoke', 'never-existed']);
    expect(unknownNode.code).not.toBe(0);
    expect(unknownNode.stderr).toContain('no judge node');

    const unknownCommand = await run(['frobnicate']);
    expect(unknownCommand.code).not.toBe(0);
    expect(unknownCommand.stderr).toContain('usage:');
  }, 180_000);
});
