import { readdir, readFile, mkdir } from 'node:fs/promises';
import { join, relative, sep, posix } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { create, extract, Parser } from 'tar';
import { hashFile, type PackageFile } from './hash.js';

/**
 * The largest tree a package is allowed to inflate to, in bytes.
 *
 * zstd is an amplifier, and every reader below decompresses a caller-supplied
 * archive into a single `Buffer` before it can see one byte of tar. 200 MB of
 * zeroes compress to about 6 KB, so `PACKAGE_UPLOAD_MAX_BYTES` (256 MiB on the
 * wire) bounds only what arrives, not what gets allocated from it: without a
 * cap here, an archive small enough to be waved through by every HTTP-level
 * limit takes the API process down with an allocation no filter can catch.
 * `maxOutputLength` makes zlib refuse *before* allocating, which is the only
 * point at which refusing is still possible.
 *
 * 1 GiB — four times the compressed cap, far above any real test set, and
 * small enough that a rejection is a rejection rather than an OOM. See D53.
 */
export const MAX_UNPACKED_BYTES = 1_073_741_824;

/**
 * `zstdDecompressSync` with the cap applied. Every reader in this file goes
 * through it so the bound cannot be forgotten at one call site — the same
 * reason `assertSafePath` is shared in the Polygon importer.
 */
function inflate(archive: Buffer, maxUnpackedBytes: number): Buffer {
  return Buffer.from(zstdDecompressSync(archive, { maxOutputLength: maxUnpackedBytes }));
}

async function walk(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(root, full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Package paths are always POSIX, so a package built on Windows resolves the same. */
function toPackagePath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join(posix.sep);
}

export async function packDirectory(dir: string): Promise<{ archive: Buffer; files: PackageFile[] }> {
  const absolutes = (await walk(dir)).sort();
  const paths = absolutes.map((a) => toPackagePath(dir, a));

  const files: PackageFile[] = [];
  for (const absolute of absolutes) {
    const bytes = await readFile(absolute);
    files.push({ path: toPackagePath(dir, absolute), size: bytes.length, sha256: hashFile(bytes) });
  }

  // `portable: true` strips uid/gid/mtime, so the same tree tars identically on
  // any machine. The hash does not depend on this (§5 of the spec hashes file
  // digests, not archive bytes) but a reproducible archive makes byte-for-byte
  // comparison a usable debugging tool.
  const chunks: Buffer[] = [];
  const stream = create({ cwd: dir, portable: true, noMtime: true }, paths);
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));

  return { archive: Buffer.from(zstdCompressSync(Buffer.concat(chunks))), files };
}

export async function unpackArchive(
  archive: Buffer,
  destDir: string,
  maxUnpackedBytes: number = MAX_UNPACKED_BYTES,
): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const tarBytes = inflate(archive, maxUnpackedBytes);

  const stream = extract({
    cwd: destDir,
    // A package is uploaded by a user. Without this the archive decides where
    // its own bytes land, which is an arbitrary-write primitive: `..` entries
    // escape the destination and absolute paths ignore it entirely.
    filter: (path) => {
      if (path.startsWith('/') || path.split('/').includes('..')) {
        throw new Error(`refusing archive entry that escapes the destination: ${path}`);
      }
      return true;
    },
    strict: true,
  });

  // `extract(opts)` without a `file:` path returns the Unpack stream itself,
  // not a Promise (only the file-writing overload returns one). Its fs writes
  // are asynchronous, so awaiting `.end()` directly resolves before the last
  // entry lands on disk. `end` (emitted once every pending write settles, not
  // Writable's own `finish`) is the real completion signal; a filter that
  // throws does so synchronously inside `.end()`, which this Promise executor
  // catches and turns into a rejection the same as an `error` event would.
  await new Promise<void>((resolve, reject) => {
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.end(tarBytes);
  });
}

/**
 * Returns the bytes of one entry, or `null` if the archive has no such path.
 *
 * Unlike `unpackArchive`, this never touches disk — the caller needs one
 * file's *contents* (the manifest), not a materialised tree, and reading
 * `manifest.json` out of a package that may otherwise be huge should not
 * require unpacking the whole thing into a scratch directory first.
 *
 * Every entry the parser emits must be drained (`entry.resume()` for the
 * ones that don't match, a `'data'`/`'end'` collector for the one that does)
 * or the parser stalls forever waiting for the current entry to finish
 * before it will emit the next one — see the `ignored entries get .resume()`
 * comment in tar's own `parse.js`. The whole scan runs to completion
 * (rather than aborting as soon as the target is found) so a truncating
 * shortcut can never quietly return the wrong bytes for an archive where the
 * sought entry isn't first.
 */
export async function readArchiveEntry(
  archive: Buffer,
  path: string,
  maxUnpackedBytes: number = MAX_UNPACKED_BYTES,
): Promise<Buffer | null> {
  const tarBytes = inflate(archive, maxUnpackedBytes);
  let found: Buffer | null = null;

  const parser = new Parser({
    onReadEntry: (entry) => {
      if (found === null && entry.path === path) {
        const chunks: Buffer[] = [];
        entry.on('data', (chunk: Buffer) => chunks.push(chunk));
        entry.on('end', () => {
          found = Buffer.concat(chunks);
        });
      } else {
        entry.resume();
      }
    },
  });

  // Same trap as `unpackArchive`: `Parser#end()` returns `this`, not a
  // Promise, so awaiting it directly awaits nothing and resolves before the
  // tar stream has actually finished parsing. Wrap it in a Promise that
  // resolves on the parser's own `'end'` event instead.
  await new Promise<void>((resolve, reject) => {
    parser.on('error', reject);
    parser.on('end', resolve);
    parser.end(tarBytes);
  });

  return found;
}

/**
 * The bytes of several entries in ONE pass, keyed by path; a path the archive
 * does not contain is simply absent from the map.
 *
 * `readArchiveEntry` in a loop would inflate — and re-parse — the whole
 * archive once per file, and the caller that needs this (the API reading a
 * problem's samples: a manifest plus two files per sample) asks for five or
 * six paths at a time out of a package that may be hundreds of megabytes.
 * One inflate, one parse, every requested entry collected as it goes by.
 *
 * The drain rule from `readArchiveEntry` applies unchanged and for the same
 * reason: an entry that is neither collected nor `resume()`d stalls the
 * parser forever. `wanted` is a Set, so asking for the same path twice costs
 * nothing and yields one entry.
 */
export async function readArchiveEntries(
  archive: Buffer,
  paths: readonly string[],
  maxUnpackedBytes: number = MAX_UNPACKED_BYTES,
): Promise<Map<string, Buffer>> {
  const found = new Map<string, Buffer>();
  if (paths.length === 0) return found;
  const wanted = new Set(paths);
  const tarBytes = inflate(archive, maxUnpackedBytes);

  const parser = new Parser({
    onReadEntry: (entry) => {
      if (wanted.has(entry.path) && !found.has(entry.path)) {
        const path = entry.path;
        const chunks: Buffer[] = [];
        entry.on('data', (chunk: Buffer) => chunks.push(chunk));
        entry.on('end', () => {
          found.set(path, Buffer.concat(chunks));
        });
      } else {
        entry.resume();
      }
    },
  });

  await new Promise<void>((resolve, reject) => {
    parser.on('error', reject);
    parser.on('end', resolve);
    parser.end(tarBytes);
  });

  return found;
}
