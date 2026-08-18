import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@qhhoj/db';
import { describeError } from '@qhhoj/observability';
import { hashFile, packageHash, parseManifest, unpackArchive, type PackageFile } from '@qhhoj/package-format';
import type { PackageSummaryDto, UploadPackageResponseDto } from '@qhhoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import { PACKAGE_STORE, type PackageStore } from './package.store.js';

/**
 * Walks an unpacked package directory computing `{ path, size, sha256 }` for
 * every regular file, in the same POSIX-relative-path shape
 * `@qhhoj/package-format`'s `packDirectory` produces — deliberately
 * hand-rolled rather than calling `packDirectory` on the extracted tree,
 * because `packDirectory` silently *skips* anything that is not a plain file
 * or directory. A hostile archive can smuggle a symlink past
 * `unpackArchive`'s traversal guard (that guard only inspects the entry's own
 * destination path, not what a symlink points at); skipping it here would
 * mean it is never hashed, never rejected, and still lands on disk — the
 * exact "verify, do not trust" gap this endpoint exists to close. Anything
 * that is not a regular file or a directory is rejected outright instead.
 */
async function walkAndHash(root: string): Promise<PackageFile[]> {
  const files: PackageFile[] = [];

  async function recurse(absDir: string, relPrefix: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(absDir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      if (entry.isSymbolicLink()) {
        throw new AppError(
          422,
          'package_invalid_entry',
          `'${rel}' is a symlink, which is not a valid package entry.`,
        );
      }
      if (entry.isDirectory()) {
        await recurse(abs, rel);
      } else if (entry.isFile()) {
        const bytes = await readFile(abs);
        files.push({ path: rel, size: bytes.length, sha256: hashFile(bytes) });
      } else {
        throw new AppError(
          422,
          'package_invalid_entry',
          `'${rel}' is not a regular file or directory, which is not a valid package entry.`,
        );
      }
    }
  }

  await recurse(root, '');
  return files;
}

/**
 * Rejects two paths that are genuinely different strings but would collapse
 * to one file once materialised: a judge writes a package onto a filesystem
 * that may be case-insensitive (macOS, Windows) or Unicode-normalising
 * (APFS/HFS+), and `packageHash` deliberately does not fold either — see its
 * doc comment. Returns the first colliding pair found, or `null`.
 *
 * Three independent folds, not two: case-folding alone and NFC-normalising
 * alone each miss a pair that only collides once *both* are applied together
 * — e.g. `CAFÉ.txt` (NFC) against `café.txt` (NFD, a lowercase 'e' plus a
 * combining acute accent). `'CAFÉ.txt'.toLowerCase()` and
 * `'café.txt'.normalize('NFC')` are each distinct from the other string
 * alone, but `normalize('NFC').toLowerCase()` collapses both to the same
 * value — which is exactly what a default case-insensitive, Unicode
 * -normalising macOS APFS volume would do to them at write time. Purely
 * additive: this third fold can only reject packages the first two already
 * accepted as ambiguous under some fold, never something they'd have
 * accepted as genuinely distinct.
 */
function findPathCollision(files: PackageFile[]): [string, string] | null {
  const byLower = new Map<string, string>();
  const byNfc = new Map<string, string>();
  const byNfcLower = new Map<string, string>();

  for (const file of files) {
    const lower = file.path.toLowerCase();
    const priorLower = byLower.get(lower);
    if (priorLower !== undefined) return [priorLower, file.path];
    byLower.set(lower, file.path);

    const nfc = file.path.normalize('NFC');
    const priorNfc = byNfc.get(nfc);
    if (priorNfc !== undefined) return [priorNfc, file.path];
    byNfc.set(nfc, file.path);

    const nfcLower = nfc.toLowerCase();
    const priorNfcLower = byNfcLower.get(nfcLower);
    if (priorNfcLower !== undefined) return [priorNfcLower, file.path];
    byNfcLower.set(nfcLower, file.path);
  }
  return null;
}

@Injectable()
export class PackagesService {
  private readonly logger = new Logger(PackagesService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PACKAGE_STORE) private readonly store: PackageStore,
  ) {}

  /**
   * Verifies an uploaded archive against the hash the client claims for it,
   * then stores it. Every step here exists because the previous one is not
   * enough on its own to trust the input:
   *
   *  1. Unpack to a scratch directory — the only way to see individual files.
   *     A malformed or hostile archive (bad zstd, bad tar, a `../` traversal
   *     entry `unpackArchive`'s own guard rejects) throws a plain `Error`
   *     here, not an `AppError` — caught below and turned into a 422, not
   *     left to fall through to `ProblemFilter`'s 500 branch. The upload
   *     endpoint's entire job is telling a bad archive from a good one; it
   *     must not answer "the server broke" for input it exists to reject.
   *  2. Recompute every file's digest from what actually extracted, not from
   *     anything the client asserted about it.
   *  3. Recompute the package hash from those digests and compare against
   *     `claimedHash`. A mismatch means the archive does not contain what its
   *     hash claims to identify.
   *  4. Reject paths that collide once case-folded or Unicode-normalised
   *     (Task 2 review / addendum A2) — safe to do here because rejecting a
   *     package never changes an existing hash.
   *  5. Parse the manifest. A package that cannot be parsed cannot be graded,
   *     so it must not be storable as if it could be.
   *  6. Store the bytes, then record the rows — in that order. `store.put`
   *     and the database insert are not atomic with each other, and an
   *     orphaned blob (store write succeeds, insert fails) is garbage an
   *     eviction pass reclaims, whereas a row pointing at a blob that was
   *     never written is a package that fails at grade time, on a judge, far
   *     from this handler. Fail in the direction that is recoverable.
   */
  async upload(claimedHash: string, archiveBytes: Buffer): Promise<UploadPackageResponseDto> {
    const workDir = await mkdtemp(join(tmpdir(), 'pkg-upload-'));
    try {
      let files: PackageFile[];
      try {
        await unpackArchive(archiveBytes, workDir);
        files = await walkAndHash(workDir);
      } catch (error) {
        // `walkAndHash`'s own rejections (symlink, non-regular entry) are
        // already a specific, correctly-coded `AppError` — pass those
        // through untouched. Everything else (a corrupt/foreign archive, or
        // `unpackArchive`'s traversal guard) is a plain `Error` from
        // node-tar or zstd internals: translated to a generic 422 so the
        // client never sees library internals, but still logged — at `warn`,
        // not `error`, so this stays out of alerting built on ERROR-level
        // lines — so an operator can tell "a user sent a bad archive" from
        // "something in here is actually broken".
        if (error instanceof AppError) throw error;
        this.logger.warn({ ...describeError(error), claimedHash }, 'rejected an unparseable package archive');
        throw new AppError(
          422,
          'package_archive_invalid',
          'The archive could not be unpacked. It may be corrupt, not a valid tar+zstd archive, or ' +
            'contain an unsafe path.',
        );
      }

      const computed = packageHash(files);
      if (computed !== claimedHash) {
        throw new AppError(
          422,
          'package_hash_mismatch',
          `The archive's contents hash to '${computed}', not the claimed '${claimedHash}'.`,
        );
      }

      const collision = findPathCollision(files);
      if (collision) {
        const [a, b] = collision;
        throw new AppError(
          422,
          'package_path_collision',
          `Paths '${a}' and '${b}' collide once case-folded or Unicode-normalised; a judge ` +
            'materialising this package onto a case-insensitive or normalising filesystem would ' +
            'silently merge them.',
        );
      }

      const manifestFile = files.find((f) => f.path === 'manifest.json');
      if (!manifestFile) {
        throw new AppError(422, 'package_manifest_invalid', 'The package is missing manifest.json.');
      }
      try {
        const manifestText = await readFile(join(workDir, 'manifest.json'), 'utf8');
        parseManifest(JSON.parse(manifestText));
      } catch (error) {
        throw new AppError(
          422,
          'package_manifest_invalid',
          error instanceof Error ? error.message : 'The package manifest is invalid.',
        );
      }

      // First-write-wins: package identity is over file digests, not archive
      // bytes (see `packageHash`'s doc comment), so two byte-different
      // archives (e.g. different compression settings) can legitimately
      // share a hash. Overwriting the blob on a re-upload would leave the
      // stored bytes and the `packages` row (whose `sizeBytes` was computed
      // once, at first insert) describing different things.
      if (!(await this.store.has(computed))) {
        await this.store.put(computed, archiveBytes);
      }

      await this.db.transaction(async (tx) => {
        await tx
          .insert(schema.packages)
          .values({ hash: computed, sizeBytes: archiveBytes.length, fileCount: files.length })
          .onConflictDoNothing();

        if (files.length > 0) {
          await tx
            .insert(schema.packageFiles)
            .values(
              files.map((f) => ({
                packageHash: computed,
                path: f.path,
                sizeBytes: f.size,
                sha256: f.sha256,
              })),
            )
            .onConflictDoNothing();
        }
      });

      return { hash: computed };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  async getSummary(hash: string): Promise<PackageSummaryDto> {
    const rows = await this.db
      .select({
        hash: schema.packages.hash,
        sizeBytes: schema.packages.sizeBytes,
        fileCount: schema.packages.fileCount,
        createdAt: schema.packages.createdAt,
      })
      .from(schema.packages)
      .where(eq(schema.packages.hash, hash))
      .limit(1);

    const row = rows[0];
    if (!row) throw new AppError(404, 'package_not_found', 'No such package.');

    return {
      hash: row.hash,
      sizeBytes: row.sizeBytes,
      fileCount: row.fileCount,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * `hash` reaches `store.has`/`store.get` only after `ZodValidationPipe`
   * has already validated it against `PackageHash`'s 64-hex-character
   * pattern — the same pattern `FilesystemPackageStore` enforces internally.
   * That pre-check is deliberate: the store's `has()` throws on a malformed
   * hash rather than reporting it absent (a caller bug must not look like a
   * 404), and validating the path parameter here means the store never sees
   * a malformed value from this route in the first place.
   */
  async getArchiveBytes(hash: string): Promise<Buffer> {
    if (!(await this.store.has(hash))) {
      throw new AppError(404, 'package_not_found', 'No such package.');
    }
    return this.store.get(hash);
  }
}
