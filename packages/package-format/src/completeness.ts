import type { PackageFile } from './hash.js';
import type { PackageManifestDto } from './manifest.js';

/**
 * Every path a manifest promises the package contains: both files of every
 * test, plus the checker's source when it has one.
 *
 * The checker is the half that kept getting forgotten. `buildPackage` cross
 * -checked `manifest.tests` against the packed file list and stopped there,
 * so `checker: { kind: 'source', path: 'checker/check.cpp' }` with no such
 * file built, hashed and uploaded without complaint — and EVERY Polygon
 * import plans a source checker (`@duckoj/polygon-import`), so this was
 * squarely on the path the importer exists to serve.
 */
function declaredPaths(manifest: PackageManifestDto): string[] {
  const paths = manifest.tests.flatMap((test) => [test.input, test.answer]);
  if (manifest.checker.kind === 'source') paths.push(manifest.checker.path);
  return paths;
}

/**
 * The paths a manifest names that the package does not actually contain,
 * sorted and de-duplicated. Empty means the manifest describes this package.
 *
 * The canonical implementation of this rule, beside `findPathCollision` and
 * for the same reason: completeness is a property of a package's contents,
 * independent of whether it is being checked while building the archive
 * (`scripts/lib/build-package.ts`, over the walked tree) or at revision
 * -attach time (`ProblemAccessService.attachRevision`, over the
 * `package_files` rows). Two copies would be two chances to check one list
 * and not the other — which is exactly how the checker path came to be
 * checked nowhere at all.
 *
 * A manifest that names a file nobody shipped is not a package that grades
 * badly; it is a package that cannot grade. Caught here it is a message the
 * setter can act on. Not caught, it surfaces at grade time, on a judge, as
 * an internal error against a submission that did nothing wrong.
 */
export function findMissingPackageFiles(
  manifest: PackageManifestDto,
  files: Pick<PackageFile, 'path'>[],
): string[] {
  const present = new Set(files.map((f) => f.path));
  return [...new Set(declaredPaths(manifest).filter((p) => !present.has(p)))].sort();
}
