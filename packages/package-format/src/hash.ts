import { createHash } from 'node:crypto';

export interface PackageFile {
  path: string;
  size: number;
  sha256: string;
}

export function hashFile(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The canonical form a package hash is taken over.
 *
 * Deliberately NOT the archive bytes. tar output varies with implementation,
 * mtimes, ordering and compression level, so hashing an archive would make
 * identical content produce different identities on different machines — and
 * package identity is what `problem_revisions` points at forever.
 *
 * One line per file, `path\0size\0sha256`, sorted by path, newline-terminated.
 * NUL separators because a path can contain anything except NUL, so no
 * separator collision can forge a different file list that hashes the same.
 */
export function canonicalForm(files: PackageFile[]): string {
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) throw new Error(`duplicate path in package: ${file.path}`);
    seen.add(file.path);
  }
  return [...files]
    .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
    .map((f) => `${f.path}\0${f.size}\0${f.sha256}\n`)
    .join('');
}

export function packageHash(files: PackageFile[]): string {
  return createHash('sha256').update(canonicalForm(files), 'utf8').digest('hex');
}
