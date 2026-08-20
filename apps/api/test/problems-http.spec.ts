import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { problemRevisions, problems } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { API_PREFIX } from '@duckoj/api-prefix';
import { openApiDocument, ProblemDetail, ProblemPage } from '@duckoj/contracts';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { insertUser, registerAndLogin } from './submissions.fixtures.js';

type Visibility = 'private' | 'org' | 'public';

/** Mirrors `problem-reads.spec.ts`'s local `seedProblem`, minimal for HTTP-layer tests. */
async function seedProblem(
  db: Db,
  opts: { code: string; name: string; visibility?: Visibility; createdBy: number },
): Promise<{ id: number }> {
  const [problem] = await db
    .insert(problems)
    .values({
      code: opts.code,
      name: opts.name,
      statement: 'statement',
      visibility: opts.visibility ?? 'public',
      createdBy: opts.createdBy,
    })
    .returning();
  const hash = `hash-${opts.code}`;
  await db.insert(schema.packages).values({ hash, sizeBytes: 1, fileCount: 1 });
  const [revision] = await db
    .insert(problemRevisions)
    .values({
      problemId: problem!.id,
      version: 1,
      packageHash: hash,
      state: 'published',
      createdBy: opts.createdBy,
      timeMs: 1000,
      memoryKb: 256_000,
      testCount: 5,
      totalPoints: 100,
      checkerKind: 'wcmp',
    })
    .returning();
  await db.update(problems).set({ currentRevisionId: revision!.id }).where(eq(problems.id, problem!.id));
  return { id: problem!.id };
}

describe('GET /problems, GET /problems/:code over HTTP', () => {
  it('lists only public problems to an anonymous caller, and 404s a private one by code', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await insertUser(db, 'problems-http-owner');
        await seedProblem(db, { code: 'pub-http', name: 'Public HTTP', visibility: 'public', createdBy: owner.id });
        await seedProblem(db, { code: 'priv-http', name: 'Private HTTP', visibility: 'private', createdBy: owner.id });

        const list = await request(app.getHttpServer()).get('/problems');
        expect(list.status).toBe(200);
        const page = ProblemPage.parse(list.body);
        expect(page.items.map((p) => p.code)).toContain('pub-http');
        expect(page.items.map((p) => p.code)).not.toContain('priv-http');

        // Same 404 for "absent" and "invisible" — organizations §3 item 2:
        // a problem the actor may not see returns `problem_not_found`, never
        // a distinct signal that would let existence be probed for.
        const hidden = await request(app.getHttpServer()).get('/problems/priv-http');
        expect(hidden.status).toBe(404);
        expect(hidden.headers['content-type']).toContain('application/problem+json');
        expect(hidden.body.code).toBe('problem_not_found');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('POST /problems over HTTP', () => {
  it('is 401 without credentials', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const res = await request(app.getHttpServer())
          .post('/problems')
          .send({ code: 'anon-create', name: 'Anon Create', statement: 'x' });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('authentication_required');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('is 403 for a signed-in plain user', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'plain-http-creator');

        const res = await agent.post('/problems').send({ code: 'plain-create', name: 'Plain Create', statement: 'x' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('problem_forbidden');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('is 201 for a setter, and the created problem satisfies the published contract', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'setter-http-creator');
        await db.update(schema.users).set({ globalRole: 'setter' }).where(eq(schema.users.username, 'setter-http-creator'));

        const res = await agent.post('/problems').send({ code: 'setter-create', name: 'Setter Create', statement: 'A statement.' });
        expect(res.status).toBe(201);
        const detail = ProblemDetail.parse(res.body);
        expect(detail.code).toBe('setter-create');
        expect(detail.name).toBe('Setter Create');
        // Never sent in the request: the contract's own default.
        expect(detail.visibility).toBe('private');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('PATCH /problems/:code over HTTP', () => {
  it('with an unknown field (code) is 400 problem_code_immutable, not the pipe\'s generic 422', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'patch-http-author');
        await db.update(schema.users).set({ globalRole: 'setter' }).where(eq(schema.users.username, 'patch-http-author'));

        const created = await agent
          .post('/problems')
          .send({ code: 'patch-immutable', name: 'Before', statement: 'x' });
        expect(created.status).toBe(201);

        // `UpdateProblemRequest.strict()` rejects any key it does not declare
        // — `code` is not declared at all, deliberately, so this is
        // indistinguishable from any other typo at the schema layer.
        // `UpdateProblemBodyPipe` is what turns it specifically into 400
        // `problem_code_immutable` rather than the pipe's ordinary 422
        // `validation_failed`.
        const patched = await agent.patch('/problems/patch-immutable').send({ code: 'stolen-code' });
        expect(patched.status).toBe(400);
        expect(patched.body.code).toBe('problem_code_immutable');

        // The problem's actual code is untouched.
        const [row] = await db.select().from(problems).where(eq(problems.code, 'patch-immutable'));
        expect(row).toBeDefined();
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('the OpenAPI document', () => {
  it('lists every problem route under API_PREFIX', () => {
    const doc = openApiDocument();
    expect(doc.servers?.[0]?.url).toBe(API_PREFIX);

    const paths = Object.keys(doc.paths ?? {});
    expect(paths).toEqual(
      expect.arrayContaining([
        '/problems',
        '/problems/{code}',
        '/problems/{code}/revisions',
        '/problems/{code}/revisions/{version}/publish',
      ]),
    );

    // GET and PATCH /problems/{code} share one path entry with two methods
    // — verified separately from the path list above, which only proves the
    // key exists.
    const problemByCode = (doc.paths ?? {})['/problems/{code}'] as Record<string, unknown> | undefined;
    expect(Object.keys(problemByCode ?? {})).toEqual(expect.arrayContaining(['get', 'patch']));

    const problemsRoot = (doc.paths ?? {})['/problems'] as Record<string, unknown> | undefined;
    expect(Object.keys(problemsRoot ?? {})).toEqual(expect.arrayContaining(['get', 'post']));

    const revisions = (doc.paths ?? {})['/problems/{code}/revisions'] as Record<string, unknown> | undefined;
    expect(Object.keys(revisions ?? {})).toEqual(expect.arrayContaining(['get', 'post']));
  });
});
