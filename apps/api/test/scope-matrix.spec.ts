import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema } from '@duckoj/db';
import { problems } from '@duckoj/db/guarded';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packDirectory, packageHash } from '@duckoj/package-format';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin, seedProblemAndLanguage } from './submissions.fixtures.js';

/**
 * Two things this file exists to close, both against real routes (not the
 * probe controller `scope-guard.spec.ts` uses to test the guard mechanism
 * in isolation):
 *
 *  1. R49, reproduced and proven closed at both layers Task 3 touches.
 *  2. The scope matrix from spec §2.3: every scope, exercised against the
 *     one real route the mapping table assigns it, across all four actor
 *     shapes deny-by-default cares about.
 */

async function mintToken(agent: ReturnType<typeof request.agent>, scopes: string[]): Promise<string> {
  const res = await agent.post('/auth/tokens').send({ name: 'probe', scopes });
  expect(res.status).toBe(201);
  return (res.body as { token: string }).token;
}

function bearer(app: INestApplication, token: string) {
  return {
    get: (path: string) => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string) => request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`),
  };
}

describe('R49 stays closed: a narrowly-scoped token cannot escalate', () => {
  it(
    'a token scoped only submissions:read cannot promote a user to admin (SessionOnlyGuard) or create a problem (ScopeGuard)',
    async () => {
      await withTestDb(async (db) => {
        const app = await buildApp(db);
        try {
          // The exact Phase 2b R49 sequence: an admin mints a token scoped
          // narrowly, then tries to use it for something well outside that
          // scope. The admin's own session could do both of these things —
          // the point is that the token, despite being minted by an admin,
          // can do neither.
          const adminAgent = request.agent(app.getHttpServer());
          await registerAndLogin(adminAgent, 'r49-admin');
          await db.update(schema.users).set({ globalRole: 'admin' }).where(eq(schema.users.username, 'r49-admin'));

          const victimAgent = request.agent(app.getHttpServer());
          await registerAndLogin(victimAgent, 'r49-victim');

          const token = await mintToken(adminAgent, ['submissions:read']);
          const asToken = bearer(app, token);

          // (a) SessionOnlyGuard: /admin/users/:username is unreachable by
          // any token regardless of scope.
          const grant = await request(app.getHttpServer())
            .patch('/admin/users/r49-victim')
            .set('Authorization', `Bearer ${token}`)
            .send({ globalRole: 'admin' });
          expect(grant.status).toBe(403);
          expect(grant.body.code).toBe('session_required');

          const [victim] = await db.select().from(schema.users).where(eq(schema.users.username, 'r49-victim'));
          expect(victim!.globalRole).toBe('user');

          // (b) ScopeGuard: a token-reachable route the admin's session
          // could use (POST /problems, once granted setter) is closed to
          // this token by scope alone — not by role, since the admin would
          // pass any role check.
          const create = await asToken.post('/problems').send({
            code: 'r49-escalation',
            name: 'R49 escalation attempt',
            statement: 'should never exist',
          });
          expect(create.status).toBe(403);
          expect(create.body.code).toBe('scope_required');

          const [problem] = await db.select().from(problems).where(eq(problems.code, 'r49-escalation'));
          expect(problem).toBeUndefined();
        } finally {
          await app.close();
        }
      });
    },
    120_000,
  );
});

describe('scope matrix: every scope × {session, token-with, token-without, token-empty}', () => {
  it(
    'problems:read — GET /problems',
    async () => {
      await withTestDb(async (db) => {
        const app = await buildApp(db);
        try {
          const agent = request.agent(app.getHttpServer());
          const cookie = await registerAndLogin(agent, 'sm-problems-read');

          const session = await request(app.getHttpServer()).get('/problems').set('Cookie', cookie);
          expect(session.status).toBe(200);

          const withScope = await bearer(app, await mintToken(agent, ['problems:read'])).get('/problems');
          expect(withScope.status).toBe(200);

          const withoutScope = await bearer(app, await mintToken(agent, ['orgs:read'])).get('/problems');
          expect(withoutScope.status).toBe(403);
          expect(withoutScope.body.code).toBe('scope_required');

          const empty = await bearer(app, await mintToken(agent, [])).get('/problems');
          expect(empty.status).toBe(403);
          expect(empty.body.code).toBe('scope_required');
        } finally {
          await app.close();
        }
      });
    },
    120_000,
  );

  it(
    'problems:write — POST /problems (setter role)',
    async () => {
      await withTestDb(async (db) => {
        const app = await buildApp(db);
        try {
          const agent = request.agent(app.getHttpServer());
          await registerAndLogin(agent, 'sm-problems-write');
          await db.update(schema.users).set({ globalRole: 'setter' }).where(eq(schema.users.username, 'sm-problems-write'));

          const create = (code: string) => ({ code, name: 'Scope matrix', statement: 'x' });

          const session = await agent.post('/problems').send(create('sm-pw-session'));
          expect(session.status).toBe(201);

          const withScope = await bearer(app, await mintToken(agent, ['problems:write'])).post('/problems').send(create('sm-pw-token'));
          expect(withScope.status).toBe(201);

          const withoutScope = await bearer(app, await mintToken(agent, ['submissions:write'])).post('/problems').send(create('sm-pw-no'));
          expect(withoutScope.status).toBe(403);
          expect(withoutScope.body.code).toBe('scope_required');

          const empty = await bearer(app, await mintToken(agent, [])).post('/problems').send(create('sm-pw-empty'));
          expect(empty.status).toBe(403);
          expect(empty.body.code).toBe('scope_required');
        } finally {
          await app.close();
        }
      });
    },
    120_000,
  );

  it(
    'problems:publish — GET /problems/:code/revisions (author membership)',
    async () => {
      await withTestDb(async (db) => {
        const app = await buildApp(db);
        try {
          const agent = request.agent(app.getHttpServer());
          await registerAndLogin(agent, 'sm-problems-publish');
          await db.update(schema.users).set({ globalRole: 'setter' }).where(eq(schema.users.username, 'sm-problems-publish'));
          const created = await agent
            .post('/problems')
            .send({ code: 'sm-publish-target', name: 'Scope matrix publish', statement: 'x' });
          expect(created.status).toBe(201);

          const session = await agent.get('/problems/sm-publish-target/revisions');
          expect(session.status).toBe(200);

          const withScope = await bearer(app, await mintToken(agent, ['problems:publish'])).get(
            '/problems/sm-publish-target/revisions',
          );
          expect(withScope.status).toBe(200);

          const withoutScope = await bearer(app, await mintToken(agent, ['problems:write'])).get(
            '/problems/sm-publish-target/revisions',
          );
          expect(withoutScope.status).toBe(403);
          expect(withoutScope.body.code).toBe('scope_required');

          const empty = await bearer(app, await mintToken(agent, [])).get('/problems/sm-publish-target/revisions');
          expect(empty.status).toBe(403);
          expect(empty.body.code).toBe('scope_required');
        } finally {
          await app.close();
        }
      });
    },
    120_000,
  );

  it(
    'submissions:write — POST /submissions',
    async () => {
      await withTestDb(async (db) => {
        await seedProblemAndLanguage(db);
        const app = await buildApp(db);
        try {
          const agent = request.agent(app.getHttpServer());
          await registerAndLogin(agent, 'sm-submissions-write');
          const body = { problemCode: 'aplusb', languageKey: 'cpp17', source: 'int main(){}' };

          const session = await agent.post('/submissions').send(body);
          expect(session.status).toBe(201);

          const withScope = await bearer(app, await mintToken(agent, ['submissions:write'])).post('/submissions').send(body);
          expect(withScope.status).toBe(201);

          const withoutScope = await bearer(app, await mintToken(agent, ['submissions:read'])).post('/submissions').send(body);
          expect(withoutScope.status).toBe(403);
          expect(withoutScope.body.code).toBe('scope_required');

          const empty = await bearer(app, await mintToken(agent, [])).post('/submissions').send(body);
          expect(empty.status).toBe(403);
          expect(empty.body.code).toBe('scope_required');
        } finally {
          await app.close();
        }
      });
    },
    120_000,
  );

  it(
    'submissions:read — GET /submissions/:id',
    async () => {
      await withTestDb(async (db) => {
        await seedProblemAndLanguage(db);
        const app = await buildApp(db);
        try {
          const agent = request.agent(app.getHttpServer());
          await registerAndLogin(agent, 'sm-submissions-read');
          const created = await agent
            .post('/submissions')
            .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'int main(){}' });
          expect(created.status).toBe(201);
          const id = (created.body as { id: number }).id;

          const session = await agent.get(`/submissions/${id}`);
          expect(session.status).toBe(200);

          const withScope = await bearer(app, await mintToken(agent, ['submissions:read'])).get(`/submissions/${id}`);
          expect(withScope.status).toBe(200);

          const withoutScope = await bearer(app, await mintToken(agent, ['submissions:write'])).get(`/submissions/${id}`);
          expect(withoutScope.status).toBe(403);
          expect(withoutScope.body.code).toBe('scope_required');

          const empty = await bearer(app, await mintToken(agent, [])).get(`/submissions/${id}`);
          expect(empty.status).toBe(403);
          expect(empty.body.code).toBe('scope_required');
        } finally {
          await app.close();
        }
      });
    },
    120_000,
  );

  it(
    "languages:read — GET /languages, and the anonymous half of its @Public()",
    async () => {
      await withTestDb(async (db) => {
        await seedProblemAndLanguage(db);
        const app = await buildApp(db);
        try {
          const agent = request.agent(app.getHttpServer());
          await registerAndLogin(agent, 'sm-languages-read');

          // The one route in this matrix that is also @Public(): an
          // anonymous caller reaches it with no actor at all, so ScopeGuard
          // never even runs its scope check (see scope.guard.ts's `if
          // (!actor) return true`).
          const anonymous = await request(app.getHttpServer()).get('/languages');
          expect(anonymous.status).toBe(200);

          const session = await agent.get('/languages');
          expect(session.status).toBe(200);

          const withScope = await bearer(app, await mintToken(agent, ['languages:read'])).get('/languages');
          expect(withScope.status).toBe(200);

          const withoutScope = await bearer(app, await mintToken(agent, ['submissions:read'])).get('/languages');
          expect(withoutScope.status).toBe(403);
          expect(withoutScope.body.code).toBe('scope_required');

          const empty = await bearer(app, await mintToken(agent, [])).get('/languages');
          expect(empty.status).toBe(403);
          expect(empty.body.code).toBe('scope_required');
        } finally {
          await app.close();
        }
      });
    },
    120_000,
  );

  it(
    'orgs:read — GET /orgs',
    async () => {
      await withTestDb(async (db) => {
        const app = await buildApp(db);
        try {
          const agent = request.agent(app.getHttpServer());
          const cookie = await registerAndLogin(agent, 'sm-orgs-read');

          const session = await request(app.getHttpServer()).get('/orgs').set('Cookie', cookie);
          expect(session.status).toBe(200);

          const withScope = await bearer(app, await mintToken(agent, ['orgs:read'])).get('/orgs');
          expect(withScope.status).toBe(200);

          const withoutScope = await bearer(app, await mintToken(agent, ['problems:read'])).get('/orgs');
          expect(withoutScope.status).toBe(403);
          expect(withoutScope.body.code).toBe('scope_required');

          const empty = await bearer(app, await mintToken(agent, [])).get('/orgs');
          expect(empty.status).toBe(403);
          expect(empty.body.code).toBe('scope_required');
        } finally {
          await app.close();
        }
      });
    },
    120_000,
  );

  /**
   * A minimal, manifest-valid package directory, packed and hashed with the
   * real `@duckoj/package-format` round trip (same as `packages.spec.ts`) —
   * `PackagesService.upload` recomputes the hash from the unpacked archive
   * and 422s on any mismatch, so a made-up hash would not do for the two
   * cases below that must actually reach 201. `seed` varies the content (and
   * therefore the hash) between calls so each upload gets a fresh, distinct
   * package rather than re-uploading the same one.
   */
  async function fixturePackage(seed: string): Promise<{ archive: Buffer; hash: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'scope-matrix-pkg-'));
    await mkdir(join(dir, 'tests'), { recursive: true });
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: seed,
        checker: { kind: 'standard' },
        limits: { timeMs: 1000, memoryKb: 65536 },
        tests: [{ input: 'tests/01.in', answer: 'tests/01.out', points: 1, group: 0 }],
      }),
    );
    await writeFile(join(dir, 'tests', '01.in'), `${seed}\n`);
    await writeFile(join(dir, 'tests', '01.out'), '3\n');
    const { archive, files } = await packDirectory(dir);
    return { archive, hash: packageHash(files) };
  }

  it(
    'packages:write — POST /packages',
    async () => {
      await withTestDb(async (db) => {
        const app = await buildApp(db);
        try {
          const agent = request.agent(app.getHttpServer());
          await registerAndLogin(agent, 'sm-packages-write');

          // The positive cases (session, token-with) upload a real,
          // correctly-hashed archive: `PackagesService.upload` recomputes the
          // hash from the unpacked contents and 422s on mismatch, so they
          // must actually match. The negative cases (token-without, empty)
          // never reach the handler at all — `ScopeGuard` refuses them first
          // — so a syntactically valid but made-up hash is enough there.
          const { archive: a1, hash: h1 } = await fixturePackage('session');
          const session = await agent
            .post('/packages')
            .query({ hash: h1 })
            .set('Content-Type', 'application/octet-stream')
            .send(a1);
          expect(session.status).toBe(201);

          const { archive: a2, hash: h2 } = await fixturePackage('token-with');
          const tokenWith = await mintToken(agent, ['packages:write']);
          const withScope = await request(app.getHttpServer())
            .post('/packages')
            .query({ hash: h2 })
            .set('Content-Type', 'application/octet-stream')
            .set('Authorization', `Bearer ${tokenWith}`)
            .send(a2);
          expect(withScope.status).toBe(201);

          const tokenWithout = await mintToken(agent, ['packages:read']);
          const withoutScope = await request(app.getHttpServer())
            .post('/packages')
            .query({ hash: 'c'.repeat(64) })
            .set('Content-Type', 'application/octet-stream')
            .set('Authorization', `Bearer ${tokenWithout}`)
            .send(Buffer.from('irrelevant'));
          expect(withoutScope.status).toBe(403);
          expect(withoutScope.body.code).toBe('scope_required');

          const tokenEmpty = await mintToken(agent, []);
          const empty = await request(app.getHttpServer())
            .post('/packages')
            .query({ hash: 'd'.repeat(64) })
            .set('Content-Type', 'application/octet-stream')
            .set('Authorization', `Bearer ${tokenEmpty}`)
            .send(Buffer.from('irrelevant'));
          expect(empty.status).toBe(403);
          expect(empty.body.code).toBe('scope_required');
        } finally {
          await app.close();
        }
      });
    },
    120_000,
  );

  it(
    'packages:read — GET /packages/:hash',
    async () => {
      await withTestDb(async (db) => {
        const app = await buildApp(db);
        try {
          const agent = request.agent(app.getHttpServer());
          await registerAndLogin(agent, 'sm-packages-read');
          const { archive, hash } = await fixturePackage('readable');
          const uploaded = await agent
            .post('/packages')
            .query({ hash })
            .set('Content-Type', 'application/octet-stream')
            .send(archive);
          expect(uploaded.status).toBe(201);

          const session = await agent.get(`/packages/${hash}`);
          expect(session.status).toBe(200);

          const withScope = await bearer(app, await mintToken(agent, ['packages:read'])).get(`/packages/${hash}`);
          expect(withScope.status).toBe(200);

          const withoutScope = await bearer(app, await mintToken(agent, ['packages:write'])).get(`/packages/${hash}`);
          expect(withoutScope.status).toBe(403);
          expect(withoutScope.body.code).toBe('scope_required');

          const empty = await bearer(app, await mintToken(agent, [])).get(`/packages/${hash}`);
          expect(empty.status).toBe(403);
          expect(empty.body.code).toBe('scope_required');
        } finally {
          await app.close();
        }
      });
    },
    120_000,
  );
});
