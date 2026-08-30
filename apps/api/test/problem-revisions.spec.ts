import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@duckoj/db';
import type { Db } from '@duckoj/db';
import { problemMembers, problemRevisions, problems } from '@duckoj/db/guarded';
import { packDirectory, packageHash } from '@duckoj/package-format';
import type { Actor } from '../src/authz/actor.js';
import { ProblemAccessService } from '../src/authz/problem.access.js';
import { FilesystemPackageStore, type PackageStore } from '../src/packages/package.store.js';
import { withTestDb } from './db.harness.js';
import { insertUser } from './submissions.fixtures.js';

function actorFor(userId: number, globalRole: 'user' | 'setter' | 'admin' = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

const VALID_MANIFEST = {
  schemaVersion: 1,
  name: 'A plus B',
  checker: { kind: 'standard' },
  limits: { timeMs: 1000, memoryKb: 65536 },
  tests: [
    { input: 'tests/01.in', answer: 'tests/01.out', points: 40, group: 0 },
    { input: 'tests/02.in', answer: 'tests/02.out', points: 60, group: 0 },
  ],
};

const COLLISION_MANIFEST = {
  schemaVersion: 1,
  name: 'Collision Fixture',
  checker: { kind: 'standard' },
  limits: { timeMs: 1000, memoryKb: 65536 },
  tests: [{ input: 'tests/01.in', answer: 'tests/01.out', points: 1, group: 0 }],
};

async function newStore(): Promise<PackageStore> {
  const root = await mkdtemp(join(tmpdir(), 'pkgstore-'));
  return new FilesystemPackageStore(root);
}

/** A minimal, manifest-valid package directory with two graded tests. */
async function validPackageDir(seed: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pkg-src-'));
  await mkdir(join(dir, 'tests'), { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(VALID_MANIFEST));
  await writeFile(join(dir, 'tests', '01.in'), `${seed} 1 2\n`);
  await writeFile(join(dir, 'tests', '01.out'), '3\n');
  await writeFile(join(dir, 'tests', '02.in'), '4 5\n');
  await writeFile(join(dir, 'tests', '02.out'), '9\n');
  return dir;
}

/** A package directory with no `manifest.json` at all. */
async function noManifestPackageDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pkg-nomanifest-'));
  await writeFile(join(dir, 'readme.txt'), 'no manifest here');
  return dir;
}

/**
 * A package directory whose file list contains a colliding pair, plus a
 * valid manifest — the manifest matters for Step 6's mutation test: with
 * `assertNoPathCollisions` removed, `attachRevision` must actually succeed,
 * which it can only do if the rest of the package (a real manifest, a real
 * blob in the store) is otherwise valid. ext4 is case-sensitive and does not
 * Unicode-normalise, so both spellings coexist on disk here even though they
 * would collide on the macOS/Windows filesystem this check exists to guard.
 */
async function collidingPackageDir(nameA: string, nameB: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pkg-collide-'));
  await mkdir(join(dir, 'tests'), { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(COLLISION_MANIFEST));
  await writeFile(join(dir, 'tests', '01.in'), '1 2\n');
  await writeFile(join(dir, 'tests', '01.out'), '3\n');
  await writeFile(join(dir, nameA), 'a');
  await writeFile(join(dir, nameB), 'b');
  return dir;
}

/**
 * Writes a package's blob and rows directly — `store.put` plus the
 * `packages` and `package_files` rows — bypassing `PackagesService.upload`
 * entirely. Upload's own validation (`findPathCollision`, the manifest
 * check) would reject exactly the fixtures this file needs to build: a
 * package whose paths collide, and one with no `manifest.json` at all.
 * `attachRevision` trusts the database rows and the store's bytes, not the
 * upload path that produced them, so bypassing it here still exercises the
 * real consumer.
 */
async function seedPackage(db: Db, store: PackageStore, dir: string): Promise<string> {
  const { archive, files } = await packDirectory(dir);
  const hash = packageHash(files);
  await store.put(hash, archive);
  await db.insert(schema.packages).values({ hash, sizeBytes: archive.length, fileCount: files.length });
  if (files.length > 0) {
    await db
      .insert(schema.packageFiles)
      .values(files.map((f) => ({ packageHash: hash, path: f.path, sizeBytes: f.size, sha256: f.sha256 })));
  }
  return hash;
}

/**
 * A package whose manifest promises more than the archive carries: a second
 * test whose answer file was never written, and a source checker with no
 * source. Every path in it parses — `PackageManifest` validates the SHAPE of
 * a path, never its existence — so nothing before `attachRevision` has any
 * reason to refuse it.
 */
async function incompletePackageDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pkg-incomplete-'));
  await mkdir(join(dir, 'tests'), { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'Incomplete',
      checker: { kind: 'source', path: 'checker/check.cpp', language: 'cpp17' },
      limits: { timeMs: 1000, memoryKb: 65536 },
      tests: [
        { input: 'tests/01.in', answer: 'tests/01.out', points: 50, group: 0 },
        { input: 'tests/02.in', answer: 'tests/02.out', points: 50, group: 0 },
      ],
    }),
  );
  await writeFile(join(dir, 'tests', '01.in'), '1 2\n');
  await writeFile(join(dir, 'tests', '01.out'), '3\n');
  await writeFile(join(dir, 'tests', '02.in'), '4 5\n');
  // tests/02.out and checker/check.cpp deliberately absent.
  return dir;
}

async function seedProblem(db: Db, opts: { code: string; createdBy: number }): Promise<{ id: number }> {
  const [problem] = await db
    .insert(problems)
    .values({ code: opts.code, name: opts.code, statement: 'statement', createdBy: opts.createdBy })
    .returning();
  return { id: problem!.id };
}

describe('ProblemAccessService.attachRevision', () => {
  it('attaching a valid package creates a draft revision at version 1', async () => {
    await withTestDb(async (db) => {
      const store = await newStore();
      const owner = await insertUser(db, 'attach-owner1');
      const { id } = await seedProblem(db, { code: 'attach1', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const hash = await seedPackage(db, store, await validPackageDir('v1'));
      const service = new ProblemAccessService(db, store);

      const result = await service.attachRevision(actorFor(owner.id), 'attach1', { packageHash: hash });
      expect(result.version).toBe(1);

      const rows = await db.select().from(problemRevisions).where(eq(problemRevisions.problemId, id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ version: 1, state: 'draft', packageHash: hash, createdBy: owner.id });
    });
  }, 120_000);

  it('a second attach creates version 2', async () => {
    await withTestDb(async (db) => {
      const store = await newStore();
      const owner = await insertUser(db, 'attach-owner2');
      const { id } = await seedProblem(db, { code: 'attach2', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const hashA = await seedPackage(db, store, await validPackageDir('a'));
      const hashB = await seedPackage(db, store, await validPackageDir('b'));
      const service = new ProblemAccessService(db, store);

      const first = await service.attachRevision(actorFor(owner.id), 'attach2', { packageHash: hashA });
      expect(first.version).toBe(1);
      const second = await service.attachRevision(actorFor(owner.id), 'attach2', { packageHash: hashB });
      expect(second.version).toBe(2);

      const rows = await db.select().from(problemRevisions).where(eq(problemRevisions.problemId, id));
      expect(rows.map((r) => r.version).sort()).toEqual([1, 2]);
    });
  }, 120_000);

  it('the revision records timeMs, memoryKb, testCount, totalPoints and checkerKind from the manifest', async () => {
    await withTestDb(async (db) => {
      const store = await newStore();
      const owner = await insertUser(db, 'attach-fields');
      const { id } = await seedProblem(db, { code: 'attachfields', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const hash = await seedPackage(db, store, await validPackageDir('fields'));
      const service = new ProblemAccessService(db, store);

      await service.attachRevision(actorFor(owner.id), 'attachfields', { packageHash: hash, notes: 'first cut' });

      const [row] = await db.select().from(problemRevisions).where(eq(problemRevisions.problemId, id));
      expect(row).toMatchObject({
        timeMs: 1000,
        memoryKb: 65536,
        testCount: 2,
        totalPoints: 100,
        checkerKind: 'standard',
        notes: 'first cut',
      });
    });
  }, 120_000);

  it('an unknown hash gets 404 package_not_found', async () => {
    await withTestDb(async (db) => {
      const store = await newStore();
      const owner = await insertUser(db, 'attach-unknown');
      const { id } = await seedProblem(db, { code: 'attachunknown', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const service = new ProblemAccessService(db, store);

      await expect(
        service.attachRevision(actorFor(owner.id), 'attachunknown', { packageHash: '0'.repeat(64) }),
      ).rejects.toMatchObject({ status: 404, code: 'package_not_found' });
    });
  }, 120_000);

  it('an archive with no manifest.json gets 400 package_invalid', async () => {
    await withTestDb(async (db) => {
      const store = await newStore();
      const owner = await insertUser(db, 'attach-nomanifest');
      const { id } = await seedProblem(db, { code: 'attachnomanifest', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const hash = await seedPackage(db, store, await noManifestPackageDir());
      const service = new ProblemAccessService(db, store);

      await expect(
        service.attachRevision(actorFor(owner.id), 'attachnomanifest', { packageHash: hash }),
      ).rejects.toMatchObject({ status: 400, code: 'package_invalid' });
    });
  }, 120_000);

  it('an archive whose paths collide case-insensitively gets 422 package_path_collision', async () => {
    await withTestDb(async (db) => {
      const store = await newStore();
      const owner = await insertUser(db, 'attach-collide-case');
      const { id } = await seedProblem(db, { code: 'attachcollidecase', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const hash = await seedPackage(db, store, await collidingPackageDir('README.md', 'readme.md'));
      const service = new ProblemAccessService(db, store);

      await expect(
        service.attachRevision(actorFor(owner.id), 'attachcollidecase', { packageHash: hash }),
      ).rejects.toMatchObject({ status: 422, code: 'package_path_collision' });
    });
  }, 120_000);

  it('an archive whose paths collide under NFC gets 422 package_path_collision', async () => {
    await withTestDb(async (db) => {
      const store = await newStore();
      const owner = await insertUser(db, 'attach-collide-nfc');
      const { id } = await seedProblem(db, { code: 'attachcollidenfc', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });

      // Built from explicit \u escapes, never a literal accented character in
      // source: an editor or formatter would silently normalise a literal
      // character and quietly merge the two fixtures into one.
      const nfc = 'caf\u00e9.txt'; // U+00E9 LATIN SMALL LETTER E WITH ACUTE, precomposed
      const nfd = 'cafe\u0301.txt'; // 'e' + U+0301 COMBINING ACUTE ACCENT, decomposed
      expect(nfc).not.toBe(nfd);
      expect(nfc.normalize('NFC')).toBe(nfd.normalize('NFC'));

      const hash = await seedPackage(db, store, await collidingPackageDir(nfc, nfd));
      const service = new ProblemAccessService(db, store);

      await expect(
        service.attachRevision(actorFor(owner.id), 'attachcollidenfc', { packageHash: hash }),
      ).rejects.toMatchObject({ status: 422, code: 'package_path_collision' });
    });
  }, 120_000);

  it('a tester attaching gets 403 problem_forbidden', async () => {
    await withTestDb(async (db) => {
      const store = await newStore();
      const owner = await insertUser(db, 'attach-tester-owner');
      const tester = await insertUser(db, 'attach-tester');
      const { id } = await seedProblem(db, { code: 'attachtester', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      await db.insert(problemMembers).values({ problemId: id, userId: tester.id, role: 'tester' });
      const service = new ProblemAccessService(db, store);

      await expect(
        service.attachRevision(actorFor(tester.id), 'attachtester', { packageHash: '0'.repeat(64) }),
      ).rejects.toMatchObject({ status: 403, code: 'problem_forbidden' });
    });
  }, 120_000);

  it('a concurrent double attach yields versions 1 and 2, never two 1s', async () => {
    await withTestDb(async (db) => {
      const store = await newStore();
      const owner = await insertUser(db, 'attach-concurrent');
      const { id } = await seedProblem(db, { code: 'attachconcurrent', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const hash = await seedPackage(db, store, await validPackageDir('concurrent'));
      const service = new ProblemAccessService(db, store);

      const [a, b] = await Promise.all([
        service.attachRevision(actorFor(owner.id), 'attachconcurrent', { packageHash: hash }),
        service.attachRevision(actorFor(owner.id), 'attachconcurrent', { packageHash: hash }),
      ]);

      expect(new Set([a.version, b.version])).toEqual(new Set([1, 2]));

      const rows = await db.select().from(problemRevisions).where(eq(problemRevisions.problemId, id));
      expect(rows.map((r) => r.version).sort()).toEqual([1, 2]);
    });
  }, 120_000);
});

/**
 * A revision is the object the judge grades against, and its manifest is the
 * instruction sheet. `attachRevision` already had both the manifest and the
 * package's real file list in hand — it uses them together for the collision
 * check — and never asked whether one described the other. A manifest naming
 * a test answer or a checker source the package does not carry attached,
 * published and served like any other; the first thing that noticed was a
 * judge, mid-grade, reporting an internal error against a submission that was
 * perfectly fine. `buildPackage` half-caught this for tests and not at all
 * for the checker, and nothing on the server caught it at any point.
 */
describe('a manifest that names files the package does not contain', () => {
  it('is refused at attach time, naming every missing path', async () => {
    await withTestDb(async (db) => {
      const store = await newStore();
      const owner = await insertUser(db, 'attach-incomplete');
      const { id } = await seedProblem(db, { code: 'incomplete1', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const hash = await seedPackage(db, store, await incompletePackageDir());
      const service = new ProblemAccessService(db, store);

      await expect(
        service.attachRevision(actorFor(owner.id), 'incomplete1', { packageHash: hash }),
      ).rejects.toMatchObject({ status: 400, code: 'package_invalid' });

      await expect(
        service.attachRevision(actorFor(owner.id), 'incomplete1', { packageHash: hash }),
      ).rejects.toThrow(/checker\/check\.cpp.*tests\/02\.out|tests\/02\.out.*checker\/check\.cpp/s);

      // Nothing half-applied: no revision row for a package that cannot grade.
      const rows = await db.select().from(problemRevisions).where(eq(problemRevisions.problemId, id));
      expect(rows).toHaveLength(0);
    });
  });
});
