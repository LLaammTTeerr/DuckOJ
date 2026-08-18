import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, hashJudgeToken, runMigrations, schema } from '../src/index.js';
import { problemRevisions, problems } from '../src/schema/guarded.js';

const execFileAsync = promisify(execFile);

// Same podman shim as harness.ts (see its comment) — this file starts its
// own container rather than sharing that one, because it needs the seed
// script's real, committed writes (a subprocess, over its own connection),
// not a transaction `withTestDb` would roll back.
if (!process.env.DOCKER_HOST) {
  const podmanSocket = `/run/user/${process.getuid?.() ?? 1000}/podman/podman.sock`;
  if (!existsSync('/var/run/docker.sock') && existsSync(podmanSocket)) {
    process.env.DOCKER_HOST = `unix://${podmanSocket}`;
  }
}

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SEED_SCRIPT = join(REPO_ROOT, 'scripts', 'seed-problem.ts');
const TSX_BIN = join(REPO_ROOT, 'packages', 'db', 'node_modules', '.bin', 'tsx');
const REAL_APLUSB_HASH = '7b2e67c5cb918aa58b9ef91a433ae3e40944c7a26d0367641410ac44775f6cc7';
const JUDGE_TOKEN = 'test-judge-token';

let container: StartedPostgreSqlContainer | undefined;

afterAll(async () => {
  await container?.stop();
}, 30_000);

async function runSeed(url: string): Promise<void> {
  await execFileAsync(TSX_BIN, [SEED_SCRIPT], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: url, JUDGE_TOKEN },
  });
}

describe('seed-problem.ts', () => {
  it(
    // Controller addendum B1's required test: seeding twice leaves one
    // `judge_nodes` row, and the stored hash matches `hashJudgeToken(token)`.
    // Also proves the ordering this whole task exists for, the other way
    // around from the manual verification in the report: migrating fully
    // (through 0004, the FK migration) *before* seeding at all, mirroring
    // every future bring-up (migrate runs first, seed second) — the seed's
    // own inserts must not trip the constraint it motivated.
    'seeds a real package, repoints the revision, and registers one judge_nodes row across two runs against an already-migrated database',
    async () => {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      const url = container.getConnectionUri();
      await runMigrations(url);

      await runSeed(url);
      await runSeed(url);

      const { db, close } = createDb(url);
      try {
        const judgeRows = await db.select().from(schema.judgeNodes);
        expect(judgeRows).toHaveLength(1);
        expect(judgeRows[0]!.name).toBe('judge-1');
        expect(judgeRows[0]!.tokenHash).toBe(hashJudgeToken(JUDGE_TOKEN));

        const [problem] = await db.select().from(problems);
        const revisionRows = await db.select().from(problemRevisions);
        expect(revisionRows).toHaveLength(1);
        expect(revisionRows[0]!.packageHash).toBe(REAL_APLUSB_HASH);
        expect(revisionRows[0]!.id).toBe(problem!.currentRevisionId);
      } finally {
        await close();
      }
    },
    120_000,
  );
});
