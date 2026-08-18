import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { hashJudgeToken, schema } from '@qhhoj/db';
import { packDirectory, packageHash, type PackageFile } from '@qhhoj/package-format';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin } from './submissions.fixtures.js';

const VALID_MANIFEST = {
  schemaVersion: 1,
  name: 'A plus B',
  checker: { kind: 'standard' },
  limits: { timeMs: 1000, memoryKb: 65536 },
  tests: [{ input: 'tests/01.in', answer: 'tests/01.out', points: 1, group: 0 }],
};

/** A minimal, manifest-valid package directory, as in `archive.spec.ts`. */
async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pkg-src-'));
  await mkdir(join(dir, 'tests'), { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(VALID_MANIFEST));
  await writeFile(join(dir, 'tests', '01.in'), '1 2\n');
  await writeFile(join(dir, 'tests', '01.out'), '3\n');
  return dir;
}

async function buildPackage(dir: string): Promise<{ archive: Buffer; files: PackageFile[]; hash: string }> {
  const { archive, files } = await packDirectory(dir);
  return { archive, files, hash: packageHash(files) };
}

function uploadTo(agent: ReturnType<typeof request.agent>, hash: string, archive: Buffer) {
  return agent.post('/packages').query({ hash }).set('Content-Type', 'application/octet-stream').send(archive);
}

describe('packages', () => {
  it('accepts an upload and returns the computed hash', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'uploader1');

        const { archive, files } = await buildPackage(await fixtureDir());
        const expectedHash = packageHash(files);
        expect(expectedHash).toMatch(/^[0-9a-f]{64}$/);

        const res = await uploadTo(agent, expectedHash, archive);
        expect(res.status).toBe(201);
        expect(res.body.hash).toBe(expectedHash);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('is idempotent — uploading the same package twice yields the same hash and one row', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'uploader2');

        const { archive, files, hash } = await buildPackage(await fixtureDir());

        const first = await uploadTo(agent, hash, archive);
        expect(first.status).toBe(201);
        expect(first.body.hash).toBe(hash);

        const second = await uploadTo(agent, hash, archive);
        expect(second.status).toBe(201);
        expect(second.body.hash).toBe(hash);

        const packageRows = await db.select().from(schema.packages).where(eq(schema.packages.hash, hash));
        expect(packageRows).toHaveLength(1);

        const fileRows = await db
          .select()
          .from(schema.packageFiles)
          .where(eq(schema.packageFiles.packageHash, hash));
        // Not doubled: one row per file, exactly `files.length`, not
        // `2 * files.length`.
        expect(fileRows).toHaveLength(files.length);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('rejects an archive whose contents do not match the claimed hash', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'uploader3');

        const { archive } = await buildPackage(await fixtureDir());
        const wrongHash = 'a'.repeat(64);

        const res = await uploadTo(agent, wrongHash, archive);
        expect(res.status).toBe(422);
        expect(res.headers['content-type']).toContain('application/problem+json');
        expect(res.body.code).toBe('package_hash_mismatch');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('rejects an unauthenticated upload', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const { archive, hash } = await buildPackage(await fixtureDir());

        const res = await request(app.getHttpServer())
          .post('/packages')
          .query({ hash })
          .set('Content-Type', 'application/octet-stream')
          .send(archive);
        expect(res.status).toBe(401);
        expect(res.headers['content-type']).toContain('application/problem+json');
        expect(res.body.code).toBe('authentication_required');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('serves the archive to a judge presenting a valid credential', async () => {
    await withTestDb(async (db) => {
      const token = 'a-real-judge-token';
      await db.insert(schema.judgeNodes).values({ name: 'judge-a', tokenHash: hashJudgeToken(token), driver: 'dmoj' });

      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'uploader4');

        const { archive, hash } = await buildPackage(await fixtureDir());
        const uploaded = await uploadTo(agent, hash, archive);
        expect(uploaded.status).toBe(201);

        const res = await request(app.getHttpServer())
          .get(`/internal/packages/${hash}/archive`)
          .set('Authorization', `Judge judge-a:${token}`)
          .buffer(true)
          .parse((response, callback) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => callback(null, Buffer.concat(chunks)));
          });

        expect(res.status).toBe(200);
        expect(Buffer.isBuffer(res.body)).toBe(true);
        expect(Buffer.compare(res.body as Buffer, archive)).toBe(0);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses the archive to a user session, however privileged', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'uploader5');
        await db.update(schema.users).set({ globalRole: 'admin' }).where(eq(schema.users.username, 'uploader5'));

        const { archive, hash } = await buildPackage(await fixtureDir());
        const uploaded = await uploadTo(agent, hash, archive);
        expect(uploaded.status).toBe(201);

        // A signed-in admin session, no judge header at all: this route is
        // not part of the user surface, and admin is not a judge.
        const res = await agent.get(`/internal/packages/${hash}/archive`);
        expect(res.status).toBe(401);
        expect(res.headers['content-type']).toContain('application/problem+json');
        expect(res.body.code).toBe('judge_unauthorized');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

/**
 * Addendum A2: two paths that are genuinely different strings can still
 * collapse to one file once a judge materialises the package onto a
 * case-insensitive or Unicode-normalising filesystem. `packageHash`
 * deliberately does not fold either dimension, so upload is the only place
 * left to catch it.
 */
describe('packages — path collision rejection (A2)', () => {
  it('rejects a package containing README.md and readme.md', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'collider1');

        const dir = await mkdtemp(join(tmpdir(), 'pkg-collide-'));
        await writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...VALID_MANIFEST, tests: [] }));
        await writeFile(join(dir, 'README.md'), 'upper');
        await writeFile(join(dir, 'readme.md'), 'lower');

        const { archive, hash } = await buildPackage(dir);
        const res = await uploadTo(agent, hash, archive);

        expect(res.status).toBe(422);
        expect(res.headers['content-type']).toContain('application/problem+json');
        expect(res.body.code).toBe('package_path_collision');
        expect(res.body.detail).toContain('README.md');
        expect(res.body.detail).toContain('readme.md');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('rejects a package containing the same filename in NFC and NFD form', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'collider2');

        // Built from explicit \u escapes, never a literal accented character in source: an
        // editor or formatter would silently normalise a literal character
        // and quietly merge the two fixtures into one.
        const nfc = 'caf\u00e9.txt'; // U+00E9 LATIN SMALL LETTER E WITH ACUTE, precomposed
        const nfd = 'cafe\u0301.txt'; // 'e' + U+0301 COMBINING ACUTE ACCENT, decomposed
        expect(nfc).not.toBe(nfd);
        expect(nfc.normalize('NFC')).toBe(nfd.normalize('NFC'));

        const dir = await mkdtemp(join(tmpdir(), 'pkg-collide-'));
        await writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...VALID_MANIFEST, tests: [] }));
        await writeFile(join(dir, nfc), 'nfc');
        await writeFile(join(dir, nfd), 'nfd');

        const { archive, hash } = await buildPackage(dir);
        const res = await uploadTo(agent, hash, archive);

        expect(res.status).toBe(422);
        expect(res.headers['content-type']).toContain('application/problem+json');
        expect(res.body.code).toBe('package_path_collision');
        expect(res.body.detail).toContain(nfc);
        expect(res.body.detail).toContain(nfd);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('accepts a package whose paths are genuinely distinct', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'collider3');

        // A valid, non-empty manifest (unlike the two collision fixtures
        // above, which never reach manifest parsing): this test exists to
        // prove the collision check accepts a genuinely-distinct package,
        // not merely that it stops before parsing the manifest.
        const dir = await mkdtemp(join(tmpdir(), 'pkg-distinct-'));
        await mkdir(join(dir, 'tests'), { recursive: true });
        await writeFile(join(dir, 'manifest.json'), JSON.stringify(VALID_MANIFEST));
        await writeFile(join(dir, 'tests', '01.in'), '1 2\n');
        await writeFile(join(dir, 'tests', '01.out'), '3\n');
        await writeFile(join(dir, 'a.txt'), 'a');
        await writeFile(join(dir, 'b.txt'), 'b');

        const { archive, hash } = await buildPackage(dir);
        const res = await uploadTo(agent, hash, archive);

        expect(res.status).toBe(201);
        expect(res.body.hash).toBe(hash);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
