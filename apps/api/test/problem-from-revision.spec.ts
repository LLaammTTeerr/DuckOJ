import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema } from '@duckoj/db';
import type { Db } from '@duckoj/db';
import { problemRevisions, problems } from '@duckoj/db/guarded';
import { packDirectory, packageHash } from '@duckoj/package-format';
import { DRAFT_MAX_FILES } from '@duckoj/contracts';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin } from './submissions.fixtures.js';

/**
 * D88 — the authoring round trip: an existing revision read back into a
 * draft, so the browser tab can load a published test set, change two cases
 * and build a new revision, instead of retyping sixty of them.
 *
 * Every fixture here is a POLYGON-SHAPED package — `tests/01.in`,
 * `checker/check.cpp` — because the whole difficulty of reading one back is
 * that a draft's names are flat (D87) and a real package's are not.
 */

interface Fixture {
  hash: string;
  archive: Buffer;
}

async function nestedPackage(options: { tests: number; checker: boolean }): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'from-rev-src-'));
  await mkdir(join(dir, 'tests'), { recursive: true });
  const tests: { input: string; answer: string; points: number; group: number }[] = [];
  for (let i = 1; i <= options.tests; i++) {
    const stem = String(i).padStart(2, '0');
    await writeFile(join(dir, 'tests', `${stem}.in`), `${String(i)} ${String(i)}\n`);
    await writeFile(join(dir, 'tests', `${stem}.ans`), `${String(i * 2)}\n`);
    tests.push({
      input: `tests/${stem}.in`,
      answer: `tests/${stem}.ans`,
      // The first case is a sample: 0 points, group 0 (D87).
      points: i === 1 ? 0 : 10,
      group: i === 1 ? 0 : 1,
    });
  }
  if (options.checker) {
    await mkdir(join(dir, 'checker'), { recursive: true });
    await writeFile(join(dir, 'checker', 'check.cpp'), '// testlib checker\n');
  }
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'Nested problem',
      checker: options.checker
        ? { kind: 'source', path: 'checker/check.cpp', language: 'cpp17' }
        : { kind: 'standard' },
      limits: { timeMs: 2500, memoryKb: 131_072 },
      tests,
    }),
  );
  const { archive, files } = await packDirectory(dir);
  return { archive, hash: packageHash(files) };
}

async function setterWithProblem(
  db: Db,
  app: INestApplication,
  username: string,
  code: string,
): Promise<ReturnType<typeof request.agent>> {
  const agent = request.agent(app.getHttpServer());
  await registerAndLogin(agent, username);
  await db.update(schema.users).set({ globalRole: 'setter' }).where(eq(schema.users.username, username));
  const created = await agent.post('/api/v1/problems').send({ code, name: code, statement: 's' });
  if (created.status !== 201) {
    throw new Error(`could not create ${code}: ${String(created.status)} ${JSON.stringify(created.body)}`);
  }
  return agent;
}

/** Uploads the package and attaches it as a published revision of `code`. */
async function publishRevision(
  agent: ReturnType<typeof request.agent>,
  code: string,
  fixture: Fixture,
): Promise<void> {
  const uploaded = await agent
    .post('/api/v1/packages')
    .query({ hash: fixture.hash })
    .set('Content-Type', 'application/octet-stream')
    .send(fixture.archive);
  if (uploaded.status !== 201) {
    throw new Error(`upload failed: ${String(uploaded.status)} ${JSON.stringify(uploaded.body)}`);
  }
  const attached = await agent.post(`/api/v1/problems/${code}/revisions`).send({ packageHash: fixture.hash });
  if (attached.status !== 201) {
    throw new Error(`attach failed: ${String(attached.status)} ${JSON.stringify(attached.body)}`);
  }
  const published = await agent.post(`/api/v1/problems/${code}/revisions/${String(attached.body.version)}/publish`).send();
  if (published.status !== 200 && published.status !== 201) {
    throw new Error(`publish failed: ${String(published.status)}`);
  }
}

async function withApp(db: Db, run: (app: INestApplication) => Promise<void>): Promise<void> {
  const app = await buildApp(db);
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

describe('a draft pre-filled from an existing revision (D88)', () => {
  it("flattens the revision's package into a draft, describes it, and reads every file back", async () => {
    await withTestDb(async (db) => {
      await withApp(db, async (app) => {
        const agent = await setterWithProblem(db, app, 'rev-author', 'from-rev');
        await publishRevision(agent, 'from-rev', await nestedPackage({ tests: 3, checker: true }));

        const opened = await agent.post('/api/v1/problems/from-rev/drafts/from-revision/1').send();
        expect(opened.status).toBe(201);
        expect(opened.body.fromVersion).toBe(1);
        expect(opened.body.prefill).toMatchObject({
          name: 'Nested problem',
          timeMs: 2500,
          memoryKb: 131_072,
          checker: { kind: 'source', path: 'checker.cpp', language: 'cpp17' },
        });
        // Flat names, and the sample recognised by "0 points in group 0".
        expect(opened.body.prefill.cases).toEqual([
          { input: '01.in', answer: '01.out', points: 0, group: 0, sample: true },
          { input: '02.in', answer: '02.out', points: 10, group: 1, sample: false },
          { input: '03.in', answer: '03.out', points: 10, group: 1, sample: false },
        ]);
        // manifest.json + three pairs + the checker.
        expect(opened.body.fileCount).toBe(8);

        const draftId = opened.body.draftId as string;
        // `application/octet-stream`, so supertest hands back a Buffer — the
        // point of the route: a test file is bytes, not JSON.
        const input = await agent.get(`/api/v1/problems/from-rev/drafts/${draftId}/files/02.in`);
        expect(input.status).toBe(200);
        expect(Buffer.from(input.body as Buffer).toString('utf8')).toBe('2 2\n');
        const answer = await agent.get(`/api/v1/problems/from-rev/drafts/${draftId}/files/03.out`);
        expect(Buffer.from(answer.body as Buffer).toString('utf8')).toBe('6\n');
        const checker = await agent.get(`/api/v1/problems/from-rev/drafts/${draftId}/files/checker.cpp`);
        expect(Buffer.from(checker.body as Buffer).toString('utf8')).toBe('// testlib checker\n');
        const missing = await agent.get(`/api/v1/problems/from-rev/drafts/${draftId}/files/99.in`);
        expect(missing.status).toBe(404);

        // The draft is an ORDINARY draft: building it as it stands produces a
        // second revision with the same limits and the flat paths.
        const built = await agent.post(`/api/v1/problems/from-rev/drafts/${draftId}/build`).send({});
        expect(built.status).toBe(201);
        expect(built.body.version).toBe(2);
        const files = await db
          .select()
          .from(schema.packageFiles)
          .where(eq(schema.packageFiles.packageHash, built.body.packageHash as string));
        expect(files.map((f) => f.path).sort()).toEqual([
          '01.in',
          '01.out',
          '02.in',
          '02.out',
          '03.in',
          '03.out',
          'checker.cpp',
          'manifest.json',
        ]);
        const [problem] = await db.select().from(problems).where(eq(problems.code, 'from-rev'));
        const revisions = await db
          .select()
          .from(problemRevisions)
          .where(eq(problemRevisions.problemId, problem!.id));
        expect(revisions.find((r) => r.version === 2)).toMatchObject({
          timeMs: 2500,
          memoryKb: 131_072,
          testCount: 3,
          totalPoints: 20,
          checkerKind: 'source',
          state: 'draft',
        });
      });
    });
  }, 180_000);

  it('copies only what the manifest names — a generator riding in the package is left behind', async () => {
    await withTestDb(async (db) => {
      await withApp(db, async (app) => {
        const agent = await setterWithProblem(db, app, 'gen-author', 'from-rev-gen');
        const dir = await mkdtemp(join(tmpdir(), 'from-rev-gen-'));
        await mkdir(join(dir, 'tests'), { recursive: true });
        await writeFile(join(dir, 'tests', '01.in'), '1\n');
        await writeFile(join(dir, 'tests', '01.ans'), '1\n');
        await writeFile(join(dir, 'gen.py'), 'print(1)\n');
        await writeFile(
          join(dir, 'manifest.json'),
          JSON.stringify({
            schemaVersion: 1,
            name: 'With a generator',
            checker: { kind: 'standard' },
            limits: { timeMs: 1000, memoryKb: 65_536 },
            tests: [{ input: 'tests/01.in', answer: 'tests/01.ans', points: 100, group: 0 }],
          }),
        );
        const { archive, files } = await packDirectory(dir);
        await publishRevision(agent, 'from-rev-gen', { archive, hash: packageHash(files) });

        const opened = await agent.post('/api/v1/problems/from-rev-gen/drafts/from-revision/1').send();
        expect(opened.status).toBe(201);
        expect(opened.body.fileCount).toBe(3);
        const draftId = opened.body.draftId as string;
        expect((await agent.get(`/api/v1/problems/from-rev-gen/drafts/${draftId}/files/gen.py`)).status).toBe(404);

        // A case worth points in group 0 is NOT a sample.
        expect(opened.body.prefill.cases).toEqual([
          { input: '01.in', answer: '01.out', points: 100, group: 0, sample: false },
        ]);
      });
    });
  }, 180_000);

  it("refuses a revision whose package holds more files than a draft may, without opening one", async () => {
    await withTestDb(async (db) => {
      await withApp(db, async (app) => {
        const agent = await setterWithProblem(db, app, 'big-author', 'from-rev-big');
        // Two files per case plus manifest.json: this is one file over the cap.
        const tests = Math.ceil(DRAFT_MAX_FILES / 2);
        await publishRevision(agent, 'from-rev-big', await nestedPackage({ tests, checker: false }));

        const opened = await agent.post('/api/v1/problems/from-rev-big/drafts/from-revision/1').send();
        expect(opened.status).toBe(422);
        expect(opened.body.code).toBe('draft_too_many_files');
      });
    });
  }, 300_000);

  it('404s an unknown version, a problem the caller cannot see, and 403s one they cannot edit', async () => {
    await withTestDb(async (db) => {
      await withApp(db, async (app) => {
        const owner = await setterWithProblem(db, app, 'rev-owner', 'from-rev-authz');
        await publishRevision(owner, 'from-rev-authz', await nestedPackage({ tests: 1, checker: false }));

        const unknown = await owner.post('/api/v1/problems/from-rev-authz/drafts/from-revision/9').send();
        expect(unknown.status).toBe(404);
        expect(unknown.body.code).toBe('revision_not_found');

        // A stranger cannot even learn the private problem exists.
        const stranger = request.agent(app.getHttpServer());
        await registerAndLogin(stranger, 'rev-stranger');
        const hidden = await stranger.post('/api/v1/problems/from-rev-authz/drafts/from-revision/1').send();
        expect(hidden.status).toBe(404);
        expect(hidden.body.code).toBe('problem_not_found');
        // A REAL draft, holding a real test file — a draft id is not a way
        // around the problem's own visibility.
        const opened = await owner.post('/api/v1/problems/from-rev-authz/drafts/from-revision/1').send();
        const draftId = opened.body.draftId as string;
        expect((await stranger.get(`/api/v1/problems/from-rev-authz/drafts/${draftId}/files/01.in`)).status).toBe(404);

        // Made public, the same stranger may see it and still may not author
        // it — nor read the tests it grades against.
        await owner.patch('/api/v1/problems/from-rev-authz').send({ visibility: 'public' });
        const seen = await stranger.post('/api/v1/problems/from-rev-authz/drafts/from-revision/1').send();
        expect(seen.status).toBe(403);
        expect(seen.body.code).toBe('problem_forbidden');
        const read = await stranger.get(`/api/v1/problems/from-rev-authz/drafts/${draftId}/files/01.in`);
        expect(read.status).toBe(403);
        expect(read.body.code).toBe('problem_forbidden');
      });
    });
  }, 180_000);
});
