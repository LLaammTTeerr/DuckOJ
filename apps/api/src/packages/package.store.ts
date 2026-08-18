import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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

  /**
   * Writes atomically: a process death mid-write (OOM kill, `podman stop`,
   * a host crash — all realistic on a large upload) must never leave a
   * truncated file sitting at `path`. `has()` only checks `stat().isFile()`,
   * so a partial write at the real hash path would report the blob present
   * forever, and `upload()`'s first-write-wins check (`packages.service.ts`)
   * would then skip every future retry — even one carrying the correct
   * bytes — leaving a permanently unfetchable package with no self-healing
   * path.
   *
   * Same pattern as `apps/judge-agent/src/materializer.ts`'s directory
   * rename and `scripts/lib/package-store.ts`'s doc comment: write to a
   * hidden temp file inside the *same* shard directory — so the rename
   * cannot cross a filesystem boundary and stays atomic — then `rename()`
   * onto the final path. A random suffix (not a fixed `.tmp-<hash>` name)
   * means two concurrent `put()` calls for the same hash never share one
   * temp file; each writes and renames independently, and whichever
   * `rename()` lands last wins with byte-identical or equally-valid
   * content (package identity is over file digests, not archive bytes —
   * see `packageHash`'s doc comment). The temp file is removed on any
   * failure, so a crash between the write and the rename leaves nothing at
   * either path.
   */
  async put(hash: string, bytes: Buffer): Promise<void> {
    const path = this.pathFor(hash);
    const shardDir = join(this.root, hash.slice(0, 2));
    await mkdir(shardDir, { recursive: true });
    const tempPath = join(shardDir, `.tmp-${hash}-${randomUUID()}`);
    try {
      await writeFile(tempPath, bytes);
      await rename(tempPath, path);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  async get(hash: string): Promise<Buffer> {
    return readFile(this.pathFor(hash));
  }

  async delete(hash: string): Promise<void> {
    await rm(this.pathFor(hash), { force: true });
  }
}
