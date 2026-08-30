import { open, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema } from '@duckoj/db';
import type { Db } from '@duckoj/db';
import { problemRevisions, problems } from '@duckoj/db/guarded';
import { DRAFT_MAX_FILES, DRAFT_MAX_TOTAL_BYTES, DraftFileName } from '@duckoj/contracts';
import { DRAFT_STORE, type DraftStore } from '../src/packages/draft.store.js';
import { DraftSweeper } from '../src/problems/draft.sweeper.js';
import { buildApp, type BuildAppOptions } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin } from './submissions.fixtures.js';

/**
 * D87 — browser authoring. Every test here drives the real HTTP surface:
 * open a draft, PUT files into it, ask for a build. The draft store is the
 * real filesystem one `buildApp` roots in a per-call temp directory, because
 * what these tests are ABOUT is the file handling — a fake store would prove
 * only that the service calls it.
 */

const MANIFEST = {
  schemaVersion: 1,
  name: 'A plus B',
  checker: { kind: 'standard' },
  limits: { timeMs: 1000, memoryKb: 65536 },
  tests: [
    { input: '01.in', answer: '01.out', points: 0, group: 0 },
    { input: '02.in', answer: '02.out', points: 100, group: 0 },
  ],
};

/** A setter (`canCreateProblem` requires the role) with a problem of their own. */
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
  if (created.status !== 201) throw new Error(`could not create ${code}: ${created.status} ${JSON.stringify(created.body)}`);
  return agent;
}

function putFile(
  agent: ReturnType<typeof request.agent>,
  code: string,
  draftId: string,
  name: string,
  body: string | Buffer,
) {
  return agent
    .put(`/api/v1/problems/${code}/drafts/${draftId}/files/${name}`)
    .set('Content-Type', 'application/octet-stream')
    .send(body);
}

/** Fills a draft with a manifest and the four files it names. */
async function fillDraft(agent: ReturnType<typeof request.agent>, code: string, draftId: string): Promise<void> {
  await putFile(agent, code, draftId, 'manifest.json', JSON.stringify(MANIFEST));
  await putFile(agent, code, draftId, '01.in', '1 2\n');
  await putFile(agent, code, draftId, '01.out', '3\n');
  await putFile(agent, code, draftId, '02.in', '4 5\n');
  await putFile(agent, code, draftId, '02.out', '9\n');
}

async function withApp(
  db: Db,
  run: (app: INestApplication) => Promise<void>,
  options: BuildAppOptions = {},
): Promise<void> {
  const app = await buildApp(db, options);
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

describe('problem package drafts (D87)', () => {
  it('builds the PUT files into a package, attaches it as a revision, and deletes the draft', async () => {
    await withTestDb(async (db) => {
      await withApp(db, async (app) => {
        const agent = await setterWithProblem(db, app, 'draft-author', 'draft-ok');

        const opened = await agent.post('/api/v1/problems/draft-ok/drafts').send();
        expect(opened.status).toBe(201);
        const draftId = opened.body.draftId as string;
        expect(draftId).toMatch(/^[0-9a-f-]{36}$/);
        expect(Date.parse(opened.body.expiresAt as string)).toBeGreaterThan(Date.now());

        const first = await putFile(agent, 'draft-ok', draftId, 'manifest.json', JSON.stringify(MANIFEST));
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ name: 'manifest.json', fileCount: 1 });

        await putFile(agent, 'draft-ok', draftId, '01.in', '1 2\n');
        await putFile(agent, 'draft-ok', draftId, '01.out', '3\n');
        await putFile(agent, 'draft-ok', draftId, '02.in', '4 5\n');
        const last = await putFile(agent, 'draft-ok', draftId, '02.out', '9\n');
        expect(last.body.fileCount).toBe(5);

        // A `.tmp-…` orphan left in the draft ROOT by a worker killed
        // mid-PUT must not reach the package: `buildPackage` tars everything
        // in the directory it is given, so the temp file `putFile` renames
        // from lives one level up, outside `files/`. The exact path list
        // below is what proves it.
        const store = app.get<DraftStore>(DRAFT_STORE);
        await writeFile(join(store.filesDir(draftId), '..', '.tmp-orphan'), 'half a test');

        const built = await agent
          .post(`/api/v1/problems/draft-ok/drafts/${draftId}/build`)
          .send({ notes: 'from the browser', publish: true });
        expect(built.status).toBe(201);
        expect(built.body).toMatchObject({ version: 1, published: true });
        expect(built.body.packageHash).toMatch(/^[0-9a-f]{64}$/);

        // The revision carries the manifest's denormalised limits, and it is
        // the published one — the whole point of the flow.
        const [problem] = await db.select().from(problems).where(eq(problems.code, 'draft-ok'));
        const revisions = await db.select().from(problemRevisions).where(eq(problemRevisions.problemId, problem!.id));
        expect(revisions).toHaveLength(1);
        expect(revisions[0]).toMatchObject({
          state: 'published',
          timeMs: 1000,
          memoryKb: 65536,
          testCount: 2,
          totalPoints: 100,
          checkerKind: 'standard',
          notes: 'from the browser',
        });

        // The package really is in the store, with one row per packed file.
        const files = await db
          .select()
          .from(schema.packageFiles)
          .where(eq(schema.packageFiles.packageHash, built.body.packageHash as string));
        expect(files.map((f) => f.path).sort()).toEqual(['01.in', '01.out', '02.in', '02.out', 'manifest.json']);

        // And the draft is gone — a second build against it is a 404.
        const again = await agent.post(`/api/v1/problems/draft-ok/drafts/${draftId}/build`).send({});
        expect(again.status).toBe(404);
        expect(again.body.code).toBe('draft_not_found');
      });
    });
  }, 180_000);

  it("refuses a build whose manifest names a file the draft does not hold, and says which — leaving the draft alone", async () => {
    await withTestDb(async (db) => {
      await withApp(db, async (app) => {
        const agent = await setterWithProblem(db, app, 'draft-incomplete', 'draft-bad');
        const draftId = (await agent.post('/api/v1/problems/draft-bad/drafts').send()).body.draftId as string;

        await putFile(agent, 'draft-bad', draftId, 'manifest.json', JSON.stringify(MANIFEST));
        await putFile(agent, 'draft-bad', draftId, '01.in', '1 2\n');

        const refused = await agent.post(`/api/v1/problems/draft-bad/drafts/${draftId}/build`).send({});
        expect(refused.status).toBe(422);
        expect(refused.body.code).toBe('draft_build_failed');
        // `buildPackage`'s own message, verbatim: the setter has to be told
        // WHICH files are missing or the refusal is unactionable.
        expect(refused.body.detail).toContain('01.out');
        expect(refused.body.detail).toContain('02.in');

        // The draft survives a refusal, so the fix is one more PUT.
        await putFile(agent, 'draft-bad', draftId, '01.out', '3\n');
        await putFile(agent, 'draft-bad', draftId, '02.in', '4 5\n');
        await putFile(agent, 'draft-bad', draftId, '02.out', '9\n');
        const ok = await agent.post(`/api/v1/problems/draft-bad/drafts/${draftId}/build`).send({});
        expect(ok.status).toBe(201);
        expect(ok.body.published).toBe(false);
      });
    });
  }, 180_000);

  it('refuses a build with no manifest at all', async () => {
    await withTestDb(async (db) => {
      await withApp(db, async (app) => {
        const agent = await setterWithProblem(db, app, 'draft-nomanifest', 'draft-nom');
        const draftId = (await agent.post('/api/v1/problems/draft-nom/drafts').send()).body.draftId as string;
        await putFile(agent, 'draft-nom', draftId, '01.in', '1 2\n');

        const refused = await agent.post(`/api/v1/problems/draft-nom/drafts/${draftId}/build`).send({});
        expect(refused.status).toBe(422);
        expect(refused.body.code).toBe('draft_build_failed');
        expect(refused.body.detail).toContain('manifest.json');
      });
    });
  }, 180_000);

  it('refuses a traversing or otherwise unrepresentable file name before any byte lands on disk', async () => {
    await withTestDb(async (db) => {
      await withApp(db, async (app) => {
        const agent = await setterWithProblem(db, app, 'draft-paths', 'draft-path');
        const draftId = (await agent.post('/api/v1/problems/draft-path/drafts').send()).body.draftId as string;

        // A percent-encoded separator: Express decodes `%2F` into the param
        // rather than treating it as a path boundary, so the guard has to be
        // on the DECODED value, which it is.
        const encodedSlash = await putFile(agent, 'draft-path', draftId, '%2e%2e%2fescaped', 'x');
        expect(encodedSlash.status).toBe(422);

        const nul = await putFile(agent, 'draft-path', draftId, '01.in%00.txt', 'x');
        expect(nul.status).toBe(422);

        const spaced = await putFile(agent, 'draft-path', draftId, 'a b.in', 'x');
        expect(spaced.status).toBe(422);

        // `.` and `..` are spelled only with characters the class ADMITS —
        // `.` and `-` are both members of it — which is why the schema
        // refuses those two names BY NAME as well as by pattern. They are
        // asserted here rather than over HTTP because neither survives the
        // URL layer to reach a handler: every HTTP client (and every
        // browser) resolves a dot segment away before the request is
        // written, encoded or not, so an HTTP test of them would be a test
        // of superagent. The guard still has to exist — this endpoint is
        // reachable by anything that speaks HTTP, not only by clients that
        // normalise.
        for (const name of ['.', '..']) {
          expect(DraftFileName.safeParse(name).success).toBe(false);
        }

        // Nothing was written by any of them, and the store re-checks the
        // name itself rather than trusting the pipe that already did.
        const store = app.get<DraftStore>(DRAFT_STORE);
        await expect(store.putFile(draftId, '..', Buffer.from('x'))).rejects.toThrow(/invalid draft file name/);
        expect(await store.stats(draftId)).toEqual({ fileCount: 0, totalBytes: 0 });
        expect(await readdir(store.filesDir(draftId))).toEqual([]);
      });
    });
  }, 180_000);

  it("refuses a draft id that is not this problem's, and one that does not exist", async () => {
    await withTestDb(async (db) => {
      await withApp(db, async (app) => {
        const agent = await setterWithProblem(db, app, 'draft-two', 'draft-a');
        await agent.post('/api/v1/problems').send({ code: 'draft-b', name: 'b', statement: 's' });

        const draftId = (await agent.post('/api/v1/problems/draft-a/drafts').send()).body.draftId as string;

        // The SAME editor, the same live draft — but named under the other
        // problem. Without the problemId check this would write into A's
        // draft and build it into B.
        const crossed = await putFile(agent, 'draft-b', draftId, 'manifest.json', '{}');
        expect(crossed.status).toBe(404);
        expect(crossed.body.code).toBe('draft_not_found');

        const unknown = await putFile(agent, 'draft-a', '00000000-0000-4000-8000-000000000000', 'x.in', 'x');
        expect(unknown.status).toBe(404);

        // A malformed id never reaches the store at all.
        const malformed = await putFile(agent, 'draft-a', 'not-a-uuid', 'x.in', 'x');
        expect(malformed.status).toBe(422);
      });
    });
  }, 180_000);

  it('is refused for someone who may not edit the problem, and 404s for someone who may not see it', async () => {
    await withTestDb(async (db) => {
      await withApp(db, async (app) => {
        const owner = await setterWithProblem(db, app, 'draft-owner', 'draft-authz');
        const draftId = (await owner.post('/api/v1/problems/draft-authz/drafts').send()).body.draftId as string;

        // A private problem is invisible to a stranger: 404, never 403 —
        // a refusal that admitted the problem exists would be the leak.
        const stranger = request.agent(app.getHttpServer());
        await registerAndLogin(stranger, 'draft-stranger');
        expect((await stranger.post('/api/v1/problems/draft-authz/drafts').send()).status).toBe(404);
        expect((await putFile(stranger, 'draft-authz', draftId, '01.in', 'x')).status).toBe(404);
        expect((await stranger.post(`/api/v1/problems/draft-authz/drafts/${draftId}/build`).send({})).status).toBe(404);

        // Visible but not editable: a public problem, a signed-in
        // non-member. Now the answer is 403.
        await db.update(problems).set({ visibility: 'public' }).where(eq(problems.code, 'draft-authz'));
        expect((await stranger.post('/api/v1/problems/draft-authz/drafts').send()).status).toBe(403);
        expect((await putFile(stranger, 'draft-authz', draftId, '01.in', 'x')).status).toBe(403);

        // And an anonymous caller never gets past the guard.
        const anon = request.agent(app.getHttpServer());
        expect((await anon.post('/api/v1/problems/draft-authz/drafts').send()).status).toBe(401);
      });
    });
  }, 180_000);

  it('caps a draft by total bytes and by file count', async () => {
    await withTestDb(async (db) => {
      await withApp(
        db,
        async (app) => {
          const agent = await setterWithProblem(db, app, 'draft-caps', 'draft-cap');
          const draftId = (await agent.post('/api/v1/problems/draft-cap/drafts').send()).body.draftId as string;

          // One request over the wire cap is a 413 from `readRawBody`,
          // before the draft's own accounting is consulted at all.
          const tooBig = await putFile(agent, 'draft-cap', draftId, 'big.in', Buffer.alloc(2048, 0x61));
          expect(tooBig.status).toBe(413);
          expect(tooBig.body.code).toBe('draft_file_too_large');

          // The draft's own 512 MiB total, proved with a SPARSE file: it
          // reports its full length to `stat` — which is what the cap reads
          // — while occupying almost no blocks, so this asserts the real
          // bound rather than a shrunken stand-in for it.
          const store = app.get<DraftStore>(DRAFT_STORE);
          const handle = await open(join(store.filesDir(draftId), 'huge.in'), 'w');
          try {
            await handle.truncate(DRAFT_MAX_TOTAL_BYTES);
          } finally {
            await handle.close();
          }
          const overflowing = await putFile(agent, 'draft-cap', draftId, 'one.in', 'x');
          expect(overflowing.status).toBe(422);
          expect(overflowing.body.code).toBe('draft_too_large');
        },
        { configOverrides: { packageUploadMaxBytes: 1024 } },
      );
    });
  }, 180_000);

  it('measures a re-PUT as a replacement, not as a second copy', async () => {
    await withTestDb(async (db) => {
      await withApp(db, async (app) => {
        const agent = await setterWithProblem(db, app, 'draft-replace', 'draft-rep');
        const draftId = (await agent.post('/api/v1/problems/draft-rep/drafts').send()).body.draftId as string;

        const first = await putFile(agent, 'draft-rep', draftId, '01.out', 'wrong answer\n');
        expect(first.body).toMatchObject({ fileCount: 1, totalBytes: 13 });
        const second = await putFile(agent, 'draft-rep', draftId, '01.out', '3\n');
        expect(second.body).toMatchObject({ fileCount: 1, totalBytes: 2 });

        const store = app.get<DraftStore>(DRAFT_STORE);
        expect(await readFile(join(store.filesDir(draftId), '01.out'), 'utf8')).toBe('3\n');
      });
    });
  }, 180_000);

  it('refuses a draft past its 24 hours, and the sweeper reclaims it', async () => {
    await withTestDb(async (db) => {
      await withApp(db, async (app) => {
        const agent = await setterWithProblem(db, app, 'draft-expiry', 'draft-exp');
        const draftId = (await agent.post('/api/v1/problems/draft-exp/drafts').send()).body.draftId as string;
        await fillDraft(agent, 'draft-exp', draftId);

        const store = app.get<DraftStore>(DRAFT_STORE);
        const metaPath = join(store.filesDir(draftId), '..', 'meta.json');
        const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { createdAt: string };
        await writeFile(
          metaPath,
          JSON.stringify({ ...meta, createdAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString() }),
        );

        // Enforced at ACCESS time, not merely swept: an expired draft is
        // unreachable the instant it expires, not an hour later.
        expect((await putFile(agent, 'draft-exp', draftId, '03.in', 'x')).status).toBe(404);
        expect((await agent.post(`/api/v1/problems/draft-exp/drafts/${draftId}/build`).send({})).status).toBe(404);

        // The sweeper is what reclaims the disk.
        const sweeper = app.get(DraftSweeper);
        expect(await sweeper.sweep()).toBe(1);
        expect(await store.read(draftId)).toBeNull();

        // A live draft is left alone by the same sweep.
        const fresh = (await agent.post('/api/v1/problems/draft-exp/drafts').send()).body.draftId as string;
        expect(await sweeper.sweep()).toBe(0);
        expect(await store.read(fresh)).not.toBeNull();
      });
    });
  }, 180_000);

  it('discards a draft on request', async () => {
    await withTestDb(async (db) => {
      await withApp(db, async (app) => {
        const agent = await setterWithProblem(db, app, 'draft-discard', 'draft-dis');
        const draftId = (await agent.post('/api/v1/problems/draft-dis/drafts').send()).body.draftId as string;
        await fillDraft(agent, 'draft-dis', draftId);

        expect((await agent.delete(`/api/v1/problems/draft-dis/drafts/${draftId}`).send()).status).toBe(204);
        const store = app.get<DraftStore>(DRAFT_STORE);
        expect(await store.read(draftId)).toBeNull();
        expect((await agent.delete(`/api/v1/problems/draft-dis/drafts/${draftId}`).send()).status).toBe(404);
      });
    });
  }, 180_000);

  it('caps the file count of a draft', async () => {
    await withTestDb(async (db) => {
      await withApp(db, async (app) => {
        const agent = await setterWithProblem(db, app, 'draft-count', 'draft-cnt');
        const draftId = (await agent.post('/api/v1/problems/draft-cnt/drafts').send()).body.draftId as string;

        // Fill the store directly — 500 HTTP round trips would make this
        // test minutes long to prove one comparison.
        const store = app.get<DraftStore>(DRAFT_STORE);
        for (let i = 0; i < DRAFT_MAX_FILES; i++) {
          await store.putFile(draftId, `f${String(i)}.in`, Buffer.from('x'));
        }

        const refused = await putFile(agent, 'draft-cnt', draftId, 'one-too-many.in', 'x');
        expect(refused.status).toBe(422);
        expect(refused.body.code).toBe('draft_too_many_files');

        // Replacing an existing file still works at the cap — a setter
        // fixing one wrong answer must not be told the draft is full.
        const replaced = await putFile(agent, 'draft-cnt', draftId, 'f0.in', 'y');
        expect(replaced.status).toBe(200);
      });
    });
  }, 180_000);
});
