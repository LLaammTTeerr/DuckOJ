import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packDirectory } from './archive.js';
import { findMissingPackageFiles } from './completeness.js';
import { packageHash, type PackageFile } from './hash.js';
import { parseManifest, type PackageManifestDto } from './manifest.js';

export interface BuiltPackage {
  archive: Buffer;
  files: PackageFile[];
  hash: string;
  manifest: PackageManifestDto;
}

/**
 * Turn a problem directory into a content-addressed package.
 *
 * Lives here, in the format package, rather than in `scripts/lib` where it
 * started: D87's browser authoring runs this exact function server-side over
 * a draft's uploaded files, and `apps/api` cannot import from `scripts/`.
 * Two implementations of "what does this directory hash to" is precisely how
 * a seed script registers one hash while the CLI prints another —
 * `scripts/lib/build-package.ts` is now a re-export of this, so the CLI, the
 * seed path, the e2e scripts and the API all run the same code.
 *
 * Parse before packing: a manifest that does not describe this package
 * should fail here, not at grade time on a judge.
 */
export async function buildPackage(dir: string): Promise<BuiltPackage> {
  const manifest = parseManifest(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')));

  const { archive, files } = await packDirectory(dir);

  // `findMissingPackageFiles`, not a local set of the test paths: the local
  // version never looked at `checker.path`, so a package promising a source
  // checker it did not carry built and uploaded without a word — and every
  // Polygon import plans exactly that shape of checker. One rule, checked
  // here and again server-side at attach time.
  const missing = findMissingPackageFiles(manifest, files);
  if (missing.length > 0) {
    throw new Error(`manifest references files that are not in the package: ${missing.join(', ')}`);
  }

  return { archive, files, hash: packageHash(files), manifest };
}
