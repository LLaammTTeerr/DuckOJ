import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  packDirectory,
  packageHash,
  parseManifest,
  type PackageFile,
  type PackageManifestDto,
} from '@duckoj/package-format';

export interface BuiltPackage {
  archive: Buffer;
  files: PackageFile[];
  hash: string;
  manifest: PackageManifestDto;
}

/**
 * Turn a problem directory into a content-addressed package.
 *
 * Shared by `scripts/package-build.ts` and the seed script so both compute
 * the hash the same way. Two hand-rolled copies of this logic is how a seed
 * ends up registering one hash while the CLI prints another.
 *
 * Parse before packing: a manifest that does not describe this package
 * should fail here, not at grade time on a judge.
 */
export async function buildPackage(dir: string): Promise<BuiltPackage> {
  const manifest = parseManifest(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')));

  const { archive, files } = await packDirectory(dir);

  const declared = new Set(manifest.tests.flatMap((t) => [t.input, t.answer]));
  const present = new Set(files.map((f) => f.path));
  const missing = [...declared].filter((p) => !present.has(p));
  if (missing.length > 0) {
    throw new Error(`manifest references files that are not in the package: ${missing.join(', ')}`);
  }

  return { archive, files, hash: packageHash(files), manifest };
}
