import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema } from '@duckoj/db';
import type { Db } from '@duckoj/db';
import { problemMembers, problemRevisions, problems } from '@duckoj/db/guarded';
import { packDirectory, packageHash } from '@duckoj/package-format';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin } from './submissions.fixtures.js';

/**
 * D88 — cloning a problem. What a clone carries (statement, editorial, tags,
 * difficulty, and the published revision's package) and what it deliberately
 * does not (submissions, stats, membership, the org shares, the publication
 * of either the problem or its editorial).
 */

async function setter(
  db: Db,
  app: INestApplication,
  username: string,
): Promise<ReturnType<typeof request.agent>> {
  const agent = request.agent(app.getHttpServer());
  await registerAndLogin(agent, username);
  await db.update(schema.users).set({ globalRole: 'setter' }).where(eq(schema.users.username, username));
  return agent;
}

async function packageFixture(): Promise<{ hash: string; archive: Buffer }> {
  const dir = await mkdtemp(join(tmpdir(), 'clone-src-'));
  await mkdir(join(dir, 'tests'), { recursive: true });
  await writeFile(join(dir, 'tests', '01.in'), '1 2\n');
  await writeFile(join(dir, 'tests', '01.ans'), '3\n');
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'Cloneable',
      checker: { kind: 'standard' },
      limits: { timeMs: 1500, memoryKb: 65_536 },
      tests: [{ input: 'tests/01.in', answer: 'tests/01.ans', points: 100, group: 0 }],
    }),
  );
  const { archive, files } = await packDirectory(dir);
  return { archive, hash: packageHash(files) };
}

/** A published problem with a statement, an editorial, tags and a revision. */
async function seedSource(agent: ReturnType<typeof request.agent>, code: string): Promise<string> {
  const created = await agent.post('/api/v1/problems').send({ code, name: 'Bài gốc', statement: 'Đề bài gốc' });
  expect(created.status).toBe(201);
  const patched = await agent.patch(`/api/v1/problems/${code}`).send({
    visibility: 'public',
    difficulty: 7,
    tags: ['do-thi'],
    editorial: 'Lời giải',
    editorialPublished: true,
  });
  expect(patched.status).toBe(200);

  const fixture = await packageFixture();
  const uploaded = await agent
    .post('/api/v1/packages')
    .query({ hash: fixture.hash })
    .set('Content-Type', 'application/octet-stream')
    .send(fixture.archive);
  expect(uploaded.status).toBe(201);
  const attached = await agent.post(`/api/v1/problems/${code}/revisions`).send({ packageHash: fixture.hash });
  expect(attached.status).toBe(201);
  const published = await agent.post(`/api/v1/problems/${code}/revisions/1/publish`).send();
  expect(published.status).toBe(200);
  return fixture.hash;
}

async function withApp(db: Db, run: (app: INestApplication) => Promise<void>): Promise<void> {
  const app = await buildApp(db);
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

describe('cloning a problem (D88)', () => {
  it('copies the statement, the editorial unpublished, tags, difficulty and the published package', async () => {
    await withTestDb(async (db) => {
      await withApp(db, async (app) => {
        const agent = await setter(db, app, 'clone-author');
        const hash = await seedSource(agent, 'clone-src');

        const cloned = await agent.post('/api/v1/problems/clone-src/clone').send({ newCode: 'clone-dst', newName: 'Bản sao' });
        expect(cloned.status).toBe(201);
        expect(cloned.body).toMatchObject({
          code: 'clone-dst',
          name: 'Bản sao',
          statement: 'Đề bài gốc',
          // Private, whatever the source was: a clone is a draft of the next
          // problem, not a second copy published to everyone.
          visibility: 'private',
          difficulty: 7,
        });
        expect(cloned.body.tags.map((t: { slug: string }) => t.slug)).toEqual(['do-thi']);

        const [copy] = await db.select().from(problems).where(eq(problems.code, 'clone-dst'));
        expect(copy!.editorial).toBe('Lời giải');
        // Copied, NOT re-published: the source's readers were let in by its
        // author, not by whoever cloned it.
        expect(copy!.editorialPublishedAt).toBeNull();
        expect(copy!.currentRevisionId).toBeNull();

        // The cloner is its author, and the only member.
        const members = await db.select().from(problemMembers).where(eq(problemMembers.problemId, copy!.id));
        expect(members).toHaveLength(1);
        expect(members[0]!.role).toBe('author');

        // Revision 1 points at the SAME content-addressed package, and is a
        // draft: nothing is published by cloning.
        const revisions = await db.select().from(problemRevisions).where(eq(problemRevisions.problemId, copy!.id));
        expect(revisions).toHaveLength(1);
        expect(revisions[0]).toMatchObject({
          version: 1,
          packageHash: hash,
          state: 'draft',
          timeMs: 1500,
          memoryKb: 65_536,
          testCount: 1,
          totalPoints: 100,
          checkerKind: 'standard',
        });

        // The source is untouched.
        const source = await agent.get('/api/v1/problems/clone-src');
        expect(source.body).toMatchObject({ visibility: 'public', name: 'Bài gốc' });
      });
    });
  }, 180_000);

  it('keeps the source name when none is given, and clones a problem that has no revision at all', async () => {
    await withTestDb(async (db) => {
      await withApp(db, async (app) => {
        const agent = await setter(db, app, 'clone-bare');
        await agent.post('/api/v1/problems').send({ code: 'bare-src', name: 'Chưa có test', statement: 's' });

        const cloned = await agent.post('/api/v1/problems/bare-src/clone').send({ newCode: 'bare-dst' });
        expect(cloned.status).toBe(201);
        expect(cloned.body.name).toBe('Chưa có test');

        const [copy] = await db.select().from(problems).where(eq(problems.code, 'bare-dst'));
        expect(await db.select().from(problemRevisions).where(eq(problemRevisions.problemId, copy!.id))).toEqual([]);
      });
    });
  }, 180_000);

  it('refuses a code that is already taken, without touching anything', async () => {
    await withTestDb(async (db) => {
      await withApp(db, async (app) => {
        const agent = await setter(db, app, 'clone-taken');
        await agent.post('/api/v1/problems').send({ code: 'taken-src', name: 'A', statement: 's' });
        await agent.post('/api/v1/problems').send({ code: 'taken-dst', name: 'B', statement: 's' });

        const clash = await agent.post('/api/v1/problems/taken-src/clone').send({ newCode: 'taken-dst' });
        expect(clash.status).toBe(409);
        expect(clash.body.code).toBe('problem_code_taken');

        // Nothing half-written: the existing problem is as it was.
        const existing = await agent.get('/api/v1/problems/taken-dst');
        expect(existing.body.name).toBe('B');
      });
    });
  }, 180_000);

  it('is refused for a reader of the problem and for a setter who may not create problems', async () => {
    await withTestDb(async (db) => {
      await withApp(db, async (app) => {
        const owner = await setter(db, app, 'clone-owner');
        await seedSource(owner, 'authz-src');

        // A stranger who can READ the public problem still may not clone it:
        // a clone carries the unpublished editorial and the whole test set,
        // neither of which a reader may see.
        const stranger = await setter(db, app, 'clone-stranger');
        const refused = await stranger.post('/api/v1/problems/authz-src/clone').send({ newCode: 'authz-a' });
        expect(refused.status).toBe(403);
        expect(refused.body.code).toBe('problem_forbidden');

        // A private problem does not even admit to existing.
        await owner.patch('/api/v1/problems/authz-src').send({ visibility: 'private' });
        const hidden = await stranger.post('/api/v1/problems/authz-src/clone').send({ newCode: 'authz-b' });
        expect(hidden.status).toBe(404);
        expect(hidden.body.code).toBe('problem_not_found');

        // Its own author, demoted: they may still edit the problem, and may
        // no longer mint one.
        await db.update(schema.users).set({ globalRole: 'user' }).where(eq(schema.users.username, 'clone-owner'));
        const demoted = await owner.post('/api/v1/problems/authz-src/clone').send({ newCode: 'authz-c' });
        expect(demoted.status).toBe(403);
        expect(demoted.body.code).toBe('problem_forbidden');
      });
    });
  }, 180_000);
});
