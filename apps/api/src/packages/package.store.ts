import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PACKAGE_STORE = Symbol('PACKAGE_STORE');

export interface PackageStore {
  has(hash: string): Promise<boolean>;
  put(hash: string, bytes: Buffer): Promise<void>;
  get(hash: string): Promise<Buffer>;
  delete(hash: string): Promise<void>;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Filesystem-backed content-addressed store.
 *
 * Sharded one level by hash prefix: a flat directory of packages degrades on
 * most filesystems well before it degrades on ours, but the fix is two lines
 * now and a migration later.
 *
 * Swapping in S3 or MinIO means implementing `PackageStore` and changing the
 * provider — no call site moves.
 */
export class FilesystemPackageStore implements PackageStore {
  constructor(private readonly root: string) {}

  /**
   * The hash becomes a path component, so an unvalidated value is an
   * arbitrary read/write primitive. Validated on every entry point rather
   * than at the caller, because the caller is the thing most likely to change.
   */
  private pathFor(hash: string): string {
    if (!HASH_PATTERN.test(hash)) throw new Error(`invalid package hash: ${hash}`);
    return join(this.root, hash.slice(0, 2), hash);
  }

  async has(hash: string): Promise<boolean> {
    const path = this.pathFor(hash);
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }

  async put(hash: string, bytes: Buffer): Promise<void> {
    const path = this.pathFor(hash);
    await mkdir(join(this.root, hash.slice(0, 2)), { recursive: true });
    await writeFile(path, bytes);
  }

  async get(hash: string): Promise<Buffer> {
    return readFile(this.pathFor(hash));
  }

  async delete(hash: string): Promise<void> {
    await rm(this.pathFor(hash), { force: true });
  }
}
