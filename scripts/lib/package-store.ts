import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Writes a package's archive bytes into the same content-addressed,
 * two-level-sharded layout `apps/api/src/packages/package.store.ts`'s
 * `FilesystemPackageStore` uses (`<root>/<hash[0:2]>/<hash>`).
 *
 * Deliberately a small, standalone duplicate of `FilesystemPackageStore.put`
 * rather than an import from `apps/api`: that app is not a library other
 * workspace members depend on, and `scripts/seed-problem.ts` runs as a
 * one-off container with no live API to call — see the doc comment on
 * `seedPackageArchive`'s caller for why routing through `POST /packages`
 * instead would trade this ~15-line duplication for a much larger one (a
 * throwaway auth session, a dependency on the API being up and healthy).
 * The interface this mirrors is tiny and has been stable since Task 9.
 *
 * Unlike `FilesystemPackageStore.put`, this writes unconditionally instead
 * of first-write-wins: `buildPackage`'s archive bytes are fully
 * deterministic (`packDirectory`'s `portable: true`/`noMtime`, sorted
 * paths), so two builds of the same directory produce byte-identical
 * archives — there is nothing to protect a first write from, and
 * unconditional overwrite means a seed re-run repairs a crashed prior
 * attempt's partial write instead of leaving it in place forever.
 */
export async function putPackageArchive(root: string, hash: string, bytes: Buffer): Promise<void> {
  if (!HASH_PATTERN.test(hash)) {
    throw new Error(`refusing to store an invalid package hash: '${hash}'`);
  }
  const shardDir = join(root, hash.slice(0, 2));
  await mkdir(shardDir, { recursive: true });
  await writeFile(join(shardDir, hash), bytes);
}
