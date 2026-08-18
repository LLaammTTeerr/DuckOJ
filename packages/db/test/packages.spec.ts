import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { schema } from '../src/index.js';
import { withTestDb } from './harness.js';

const HASH = 'a'.repeat(64);

describe('package schema', () => {
  it('stores a package and its files, keyed by hash', async () => {
    await withTestDb(async (db) => {
      await db.insert(schema.packages).values({ hash: HASH, sizeBytes: 1234, fileCount: 2 });
      await db.insert(schema.packageFiles).values([
        { packageHash: HASH, path: 'manifest.json', sizeBytes: 2, sha256: 'b'.repeat(64) },
        { packageHash: HASH, path: 'tests/01.in', sizeBytes: 4, sha256: 'c'.repeat(64) },
      ]);

      const files = await db
        .select()
        .from(schema.packageFiles)
        .where(eq(schema.packageFiles.packageHash, HASH));
      expect(files).toHaveLength(2);
    });
  }, 120_000);

  it('rejects a second package with the same hash, because the hash is the identity', async () => {
    await withTestDb(async (db) => {
      await db.insert(schema.packages).values({ hash: HASH, sizeBytes: 1, fileCount: 1 });
      await expect(
        db.insert(schema.packages).values({ hash: HASH, sizeBytes: 2, fileCount: 2 }),
      ).rejects.toThrow();
    });
  }, 120_000);

  it('rejects two files with the same path in one package', async () => {
    await withTestDb(async (db) => {
      await db.insert(schema.packages).values({ hash: HASH, sizeBytes: 1, fileCount: 1 });
      await db.insert(schema.packageFiles).values({
        packageHash: HASH, path: 'a.txt', sizeBytes: 1, sha256: 'd'.repeat(64),
      });
      await expect(
        db.insert(schema.packageFiles).values({
          packageHash: HASH, path: 'a.txt', sizeBytes: 9, sha256: 'e'.repeat(64),
        }),
      ).rejects.toThrow();
    });
  }, 120_000);

  it('removes a package’s files when the package goes', async () => {
    await withTestDb(async (db) => {
      await db.insert(schema.packages).values({ hash: HASH, sizeBytes: 1, fileCount: 1 });
      await db.insert(schema.packageFiles).values({
        packageHash: HASH, path: 'a.txt', sizeBytes: 1, sha256: 'f'.repeat(64),
      });
      await db.delete(schema.packages).where(eq(schema.packages.hash, HASH));
      expect(await db.select().from(schema.packageFiles)).toHaveLength(0);
    });
  }, 120_000);
});
