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
import {
  admittedJudgeCredentials,
  createDb,
  hashJudgeToken,
  runMigrations,
  schema,
  verifyJudgeCredential,
} from '../src/index.js';

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
    // And it names the command that DOES rotate it, rather than leaving an
    // operator to conclude they mistyped the name (D204).
    expect(second.stderr).toContain('rotate');
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

  it('admittedJudgeCredentials drops a revoked judge, which is how a live socket is closed (D81)', async () => {
    const live = printedToken((await run(['add', 'judge-live'])).stdout);
    const burned = printedToken((await run(['add', 'judge-burned'])).stdout);

    const { db, close } = createDb(await dbUrl());
    try {
      // What `BridgeServer` holds per connection: the name the judge
      // handshook as, and the digest of the key it handshook WITH.
      const connected = [
        { name: 'judge-live', tokenHash: hashJudgeToken(live) },
        { name: 'judge-burned', tokenHash: hashJudgeToken(burned) },
      ];

      // Before: both credentials are still the stored ones, so `judged`
      // keeps both connections.
      expect((await admittedJudgeCredentials(db, connected)).sort()).toEqual([
        'judge-burned',
        'judge-live',
      ]);

      await run(['revoke', 'judge-burned']);

      // After: the revoked one is absent from the answer, which is the whole
      // signal `BridgeServer.revalidate` acts on. Nothing on the wire says so
      // — that is why this is polled rather than pushed.
      expect(await admittedJudgeCredentials(db, connected)).toEqual(['judge-live']);
      // A name that was never registered is absent too: a judge whose row an
      // operator deleted by hand is not one to keep dispatching to.
      expect(
        await admittedJudgeCredentials(db, [
          { name: 'never-registered', tokenHash: hashJudgeToken('whatever') },
        ]),
      ).toEqual([]);
      // Nothing connected, no query — the caller uses this to keep an idle
      // bridge from polling for nothing.
      expect(await admittedJudgeCredentials(db, [])).toEqual([]);
    } finally {
      await close();
    }
  }, 180_000);

  it('rotate mints a new token and the OLD one stops being accepted (D204)', async () => {
    const added = await run(['add', 'judge-rot']);
    const oldToken = printedToken(added.stdout);

    const rotated = await run(['rotate', 'judge-rot']);
    expect(rotated.code).toBe(0);
    const newToken = printedToken(rotated.stdout);
    expect(newToken).toMatch(/^[0-9a-f]{64}$/);
    expect(newToken).not.toBe(oldToken);

    const { db, close } = createDb(await dbUrl());
    try {
      // The case that matters: the credential in this repository's history
      // is refused from the moment the command returns.
      expect(await verifyJudgeCredential(db, 'judge-rot', oldToken)).toBe(false);
      expect(await verifyJudgeCredential(db, 'judge-rot', newToken)).toBe(true);

      // The row — and therefore every `grading_jobs.judge_node_id` pointing
      // at it — survives, exactly as it does across a `revoke` (D68).
      const rows = await db
        .select()
        .from(schema.judgeNodes)
        .where(eq(schema.judgeNodes.name, 'judge-rot'));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tokenHash).not.toBe(newToken);

      // And the live-socket poll: a connection that handshook with the old
      // token is no longer admitted, while one holding the new token is.
      // This is what disconnects the judge that has not been recreated yet.
      expect(
        await admittedJudgeCredentials(db, [
          { name: 'judge-rot', tokenHash: hashJudgeToken(oldToken) },
        ]),
      ).toEqual([]);
      expect(
        await admittedJudgeCredentials(db, [
          { name: 'judge-rot', tokenHash: hashJudgeToken(newToken) },
        ]),
      ).toEqual(['judge-rot']);
    } finally {
      await close();
    }
  }, 180_000);

  it('rotate re-admits a REVOKED node, which is the only way out of the struck runbook sequence', async () => {
    const added = await run(['add', 'judge-stuck']);
    const oldToken = printedToken(added.stdout);
    await run(['revoke', 'judge-stuck']);
    // The dead end a province following `truoc-khi-trien-khai.md` §1 lands
    // in: the name is burned, `add` refuses it, and there is no way forward
    // except SQL.
    const readd = await run(['add', 'judge-stuck']);
    expect(readd.code).not.toBe(0);

    const rotated = await run(['rotate', 'judge-stuck']);

    expect(rotated.code).toBe(0);
    // It says so rather than silently un-burning a credential somebody
    // deliberately refused.
    expect(rotated.stdout).toContain('was revoked');
    const token = printedToken(rotated.stdout);
    const { db, close } = createDb(await dbUrl());
    try {
      expect(await verifyJudgeCredential(db, 'judge-stuck', token)).toBe(true);
      expect(await verifyJudgeCredential(db, 'judge-stuck', oldToken)).toBe(false);
      expect(
        await admittedJudgeCredentials(db, [
          { name: 'judge-stuck', tokenHash: hashJudgeToken(token) },
        ]),
      ).toEqual(['judge-stuck']);
    } finally {
      await close();
    }
  }, 180_000);

  it('rotate refuses a name that was never registered', async () => {
    const result = await run(['rotate', 'judge-never']);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('no judge node');
    // Never silently `add`s it: a typo on a rotation must not mint a
    // credential for a machine that does not exist.
    const listed = await run(['list']);
    expect(listed.stdout).not.toContain('judge-never');
  }, 180_000);

  it('rotate needs a node name, and says so with the usage line', async () => {
    const result = await run(['rotate']);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('rotate needs a node name');
    expect(result.stderr).toContain('usage:');
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
