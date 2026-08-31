/**
 * D94 — the samples a problem's detail carries, read out of the published
 * revision's package rather than scraped back out of the statement's prose.
 *
 * Two layers, deliberately. `readPackageSamples` is asserted against real
 * archives built by `packDirectory`, because the whole claim is about BYTES
 * (a trailing newline, a cut that lands mid-character, a file the archive
 * does not contain) and a fixture object would assert none of it. The
 * service-level tests then run through a real `ProblemAccessService` against
 * a real database, because the claim there is that the right hash reaches the
 * reader at all — and that a package the store cannot hand back leaves the
 * problem page standing.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schema } from '@duckoj/db';
import type { Db } from '@duckoj/db';
import { problemMembers, problems } from '@duckoj/db/guarded';
import { packDirectory, packageHash } from '@duckoj/package-format';
import type { Actor } from '../src/authz/actor.js';
import { ProblemAccessService } from '../src/authz/problem.access.js';
import { ScoreboardCache, type ScoreboardCacheStore } from '../src/authz/scoreboard.cache.js';
import { FilesystemPackageStore, type PackageStore } from '../src/packages/package.store.js';
import {
  MAX_SAMPLES,
  readPackageSamples,
  SAMPLE_FILE_MAX_BYTES,
  samplesCacheKey,
} from '../src/packages/samples.js';
import { withTestDb } from './db.harness.js';
import { bypassCache } from './cache.harness.js';
import { insertUser } from './submissions.fixtures.js';

function actorFor(userId: number): Actor {
  return { userId, globalRole: 'user', via: 'session', scopes: [] };
}

interface Case {
  input: string;
  answer: string;
  points: number;
  group: number;
}

/**
 * Writes a package directory. Samples are Polygon's shape — zero points in a
 * NAMED group, which `@duckoj/polygon-import` numbers 1 — because that is
 * what every problem this repo ships actually looks like, and it is the shape
 * D87's literal "group 0" rule would find nothing in.
 */
async function packageDir(opts: {
  cases: Case[];
  files: Record<string, string | Buffer>;
  samples?: Array<{ input: string; explanation: string }>;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'samples-pkg-'));
  await mkdir(join(dir, 'tests'), { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'Tổng hai số',
      checker: { kind: 'standard' },
      limits: { timeMs: 1000, memoryKb: 65536 },
      tests: opts.cases,
      ...(opts.samples ? { samples: opts.samples } : {}),
    }),
  );
  for (const [path, body] of Object.entries(opts.files)) await writeFile(join(dir, path), body);
  return dir;
}

const TWO_SAMPLES_AND_A_SCORED_BATCH = {
  cases: [
    { input: 'tests/01.in', answer: 'tests/01.ans', points: 0, group: 1 },
    { input: 'tests/02.in', answer: 'tests/02.ans', points: 0, group: 1 },
    { input: 'tests/03.in', answer: 'tests/03.ans', points: 100, group: 2 },
    // The zero-point member `distributePoints` leaves in a scored batch.
    { input: 'tests/04.in', answer: 'tests/04.ans', points: 0, group: 2 },
  ],
  files: {
    'tests/01.in': '2 3\n',
    'tests/01.ans': '5\n',
    'tests/02.in': '10 20\n',
    'tests/02.ans': '30\n',
    'tests/03.in': 'JURY INPUT\n',
    'tests/03.ans': 'JURY ANSWER\n',
    'tests/04.in': 'JURY INPUT 4\n',
    'tests/04.ans': 'JURY ANSWER 4\n',
  },
};

async function archiveOf(dir: string): Promise<{ archive: Buffer; hash: string }> {
  const { archive, files } = await packDirectory(dir);
  return { archive, hash: packageHash(files) };
}

describe('readPackageSamples', () => {
  it("hands back the sample files' bytes verbatim, trailing newline included", async () => {
    const { archive } = await archiveOf(await packageDir(TWO_SAMPLES_AND_A_SCORED_BATCH));
    const samples = await readPackageSamples(archive);
    expect(samples).toEqual([
      { input: '2 3\n', output: '5\n', explanation: null, truncated: false },
      { input: '10 20\n', output: '30\n', explanation: null, truncated: false },
    ]);
  });

  it('never reads a jury file: a zero-point member of a scored batch is not a sample', async () => {
    const { archive } = await archiveOf(await packageDir(TWO_SAMPLES_AND_A_SCORED_BATCH));
    const samples = await readPackageSamples(archive);
    expect(JSON.stringify(samples)).not.toContain('JURY');
  });

  it("joins the manifest's explanation onto the sample it names", async () => {
    const { archive } = await archiveOf(
      await packageDir({
        ...TWO_SAMPLES_AND_A_SCORED_BATCH,
        samples: [{ input: 'tests/02.in', explanation: 'Cộng $10 + 20$.' }],
      }),
    );
    const samples = await readPackageSamples(archive);
    expect(samples.map((s) => s.explanation)).toEqual([null, 'Cộng $10 + 20$.']);
  });

  it('truncates a file past the cap and says so, without leaving a broken character behind', async () => {
    // A multi-byte character straddling the cut: the decoder must drop the
    // incomplete sequence, not emit U+FFFD in the middle of a sample.
    const long = 'đ'.repeat(SAMPLE_FILE_MAX_BYTES);
    const { archive } = await archiveOf(
      await packageDir({
        cases: [{ input: 'tests/01.in', answer: 'tests/01.ans', points: 0, group: 0 }],
        files: { 'tests/01.in': long, 'tests/01.ans': 'ok\n' },
      }),
    );
    const [sample] = await readPackageSamples(archive);
    expect(sample!.truncated).toBe(true);
    expect(sample!.input).not.toContain('�');
    expect(Buffer.byteLength(sample!.input, 'utf8')).toBeLessThanOrEqual(SAMPLE_FILE_MAX_BYTES);
    // The other file was under the cap and is whole.
    expect(sample!.output).toBe('ok\n');
  });

  it('carries at most MAX_SAMPLES, so a package that scores nothing anywhere cannot fill a response', async () => {
    const count = MAX_SAMPLES + 5;
    const cases: Case[] = [];
    const files: Record<string, string> = {};
    for (let i = 1; i <= count; i++) {
      const stem = `tests/${String(i).padStart(2, '0')}`;
      cases.push({ input: `${stem}.in`, answer: `${stem}.ans`, points: 0, group: 0 });
      files[`${stem}.in`] = `${String(i)}\n`;
      files[`${stem}.ans`] = `${String(i)}\n`;
    }
    const { archive } = await archiveOf(await packageDir({ cases, files }));
    expect(await readPackageSamples(archive)).toHaveLength(MAX_SAMPLES);
  });

  it('drops a sample whose answer file is not in the archive rather than showing an empty one', async () => {
    const { archive } = await archiveOf(
      await packageDir({
        cases: [
          { input: 'tests/01.in', answer: 'tests/01.ans', points: 0, group: 0 },
          { input: 'tests/02.in', answer: 'tests/02.ans', points: 0, group: 0 },
        ],
        files: { 'tests/01.in': '1\n', 'tests/01.ans': '1\n', 'tests/02.in': '2\n' },
      }),
    );
    expect(await readPackageSamples(archive)).toEqual([
      { input: '1\n', output: '1\n', explanation: null, truncated: false },
    ]);
  });

  it('answers nothing for a package with no manifest at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samples-nomanifest-'));
    await writeFile(join(dir, 'readme.txt'), 'nothing here');
    const { archive } = await archiveOf(dir);
    expect(await readPackageSamples(archive)).toEqual([]);
  });
});

async function newStore(): Promise<PackageStore> {
  return new FilesystemPackageStore(await mkdtemp(join(tmpdir(), 'samples-store-')));
}

async function seedPublished(
  db: Db,
  store: PackageStore,
  opts: { code: string; owner: number; dir: string },
): Promise<string> {
  const { archive, hash } = await archiveOf(opts.dir);
  await store.put(hash, archive);
  const { files } = await packDirectory(opts.dir);
  await db.insert(schema.packages).values({ hash, sizeBytes: archive.length, fileCount: files.length });
  await db
    .insert(schema.packageFiles)
    .values(files.map((f) => ({ packageHash: hash, path: f.path, sizeBytes: f.size, sha256: f.sha256 })));
  const [problem] = await db
    .insert(problems)
    .values({ code: opts.code, name: opts.code, statement: 'statement', createdBy: opts.owner })
    .returning();
  await db.insert(problemMembers).values({ problemId: problem!.id, userId: opts.owner, role: 'author' });
  const service = new ProblemAccessService(db, store, bypassCache());
  await service.attachRevision(actorFor(opts.owner), opts.code, { packageHash: hash });
  await service.publishRevision(actorFor(opts.owner), opts.code, 1);
  return hash;
}

describe('ProblemAccessService.getVisible samples', () => {
  it('carries the published revision’s samples', async () => {
    await withTestDb(async (db) => {
      const store = await newStore();
      const owner = await insertUser(db, 'samples-owner');
      await seedPublished(db, store, {
        code: 'samples-ok',
        owner: owner.id,
        dir: await packageDir(TWO_SAMPLES_AND_A_SCORED_BATCH),
      });
      const detail = await new ProblemAccessService(db, store, bypassCache()).getVisible(
        actorFor(owner.id),
        'samples-ok',
      );
      expect(detail.samples).toEqual([
        { input: '2 3\n', output: '5\n', explanation: null, truncated: false },
        { input: '10 20\n', output: '30\n', explanation: null, truncated: false },
      ]);
    });
  }, 120_000);

  it('answers an empty list — not a failure — for a problem with no published revision', async () => {
    await withTestDb(async (db) => {
      const store = await newStore();
      const owner = await insertUser(db, 'samples-draft');
      await db
        .insert(problems)
        .values({ code: 'samples-none', name: 'none', statement: 's', createdBy: owner.id });
      const detail = await new ProblemAccessService(db, store, bypassCache()).getVisible(
        actorFor(owner.id),
        'samples-none',
      );
      expect(detail.samples).toEqual([]);
    });
  }, 120_000);

  it('leaves the problem page standing when the package blob cannot be read', async () => {
    await withTestDb(async (db) => {
      const store = await newStore();
      const owner = await insertUser(db, 'samples-gone');
      const hash = await seedPublished(db, store, {
        code: 'samples-gone',
        owner: owner.id,
        dir: await packageDir(TWO_SAMPLES_AND_A_SCORED_BATCH),
      });
      // The rows survive, the bytes do not — a volume that lost a blob, or a
      // store that is briefly unreachable.
      await store.delete(hash);
      const detail = await new ProblemAccessService(db, store, bypassCache()).getVisible(
        actorFor(owner.id),
        'samples-gone',
      );
      expect(detail.samples).toEqual([]);
      expect(detail.statement).toBe('statement');
    });
  }, 120_000);

  it('folds the archive once per PACKAGE, so a second read is served from the cache key the hash addresses', async () => {
    await withTestDb(async (db) => {
      const store = await newStore();
      const owner = await insertUser(db, 'samples-cache');
      // A cache that really remembers, and a store that counts reads.
      const entries = new Map<string, string>();
      const recording: ScoreboardCacheStore = {
        get: (key) => Promise.resolve(entries.get(key) ?? null),
        set: (key, value) => {
          entries.set(key, value);
          return Promise.resolve();
        },
        del: () => Promise.resolve(),
      };
      let reads = 0;
      const counting: PackageStore = {
        has: (h) => store.has(h),
        put: (h, b) => store.put(h, b),
        delete: (h) => store.delete(h),
        get: (h) => {
          reads++;
          return store.get(h);
        },
      };
      const hash = await seedPublished(db, store, {
        code: 'samples-cache',
        owner: owner.id,
        dir: await packageDir(TWO_SAMPLES_AND_A_SCORED_BATCH),
      });
      const service = new ProblemAccessService(db, counting, new ScoreboardCache(recording));
      await service.getVisible(actorFor(owner.id), 'samples-cache');
      await service.getVisible(actorFor(owner.id), 'samples-cache');
      expect(reads).toBe(1);
      expect([...entries.keys()]).toContain(samplesCacheKey(hash));
    });
  }, 120_000);
});
