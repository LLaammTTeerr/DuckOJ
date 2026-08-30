import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_UNPACKED_BYTES,
  packDirectory,
  readArchiveEntries,
  readArchiveEntry,
  unpackArchive,
} from '../src/archive.js';

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pkg-'));
  await mkdir(join(dir, 'tests'), { recursive: true });
  await writeFile(join(dir, 'manifest.json'), '{"schemaVersion":1}');
  await writeFile(join(dir, 'tests', '01.in'), '1 2\n');
  await writeFile(join(dir, 'tests', '01.out'), '3\n');
  return dir;
}

describe('archive', () => {
  it('round-trips a directory', async () => {
    const src = await fixture();
    const { archive } = await packDirectory(src);
    const dest = await mkdtemp(join(tmpdir(), 'out-'));
    await unpackArchive(archive, dest);
    expect(await readFile(join(dest, 'tests', '01.in'), 'utf8')).toBe('1 2\n');
    expect(await readFile(join(dest, 'manifest.json'), 'utf8')).toBe('{"schemaVersion":1}');
  }, 30_000);

  it('reports every file with its digest and size, using forward-slash relative paths', async () => {
    const { files } = await packDirectory(await fixture());
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(['manifest.json', 'tests/01.in', 'tests/01.out']);
    const input = files.find((f) => f.path === 'tests/01.in')!;
    expect(input.size).toBe(4);
    expect(input.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it('produces a smaller archive than the raw bytes for compressible input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pkg-'));
    await writeFile(join(dir, 'big.txt'), 'a+b '.repeat(10_000));
    const { archive } = await packDirectory(dir);
    expect(archive.length).toBeLessThan(40_000);
  }, 30_000);

  it('refuses an archive entry that escapes the destination', async () => {
    // Hand-built rather than produced by packDirectory: packDirectory can never
    // emit such an entry, so the guard can only be exercised by a hostile
    // archive — which is exactly the input this check exists for.
    const { create } = await import('tar');
    const evil = await mkdtemp(join(tmpdir(), 'evil-'));
    await writeFile(join(evil, 'ok.txt'), 'x');
    const { zstdCompressSync } = await import('node:zlib');
    const chunks: Buffer[] = [];
    const stream = create({ cwd: evil, portable: true, prefix: '../escaped' }, ['ok.txt']);
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    const hostile = Buffer.from(zstdCompressSync(Buffer.concat(chunks)));
    const dest = await mkdtemp(join(tmpdir(), 'out-'));
    await expect(unpackArchive(hostile, dest)).rejects.toThrow(/refus|escape|traver/i);
  }, 30_000);
});

describe('readArchiveEntry', () => {
  it('returns the bytes of an entry that exists', async () => {
    const { archive } = await packDirectory(await fixture());
    const bytes = await readArchiveEntry(archive, 'manifest.json');
    expect(bytes?.toString('utf8')).toBe('{"schemaVersion":1}');
  }, 30_000);

  it('returns null for a path the archive does not contain', async () => {
    const { archive } = await packDirectory(await fixture());
    expect(await readArchiveEntry(archive, 'no-such-file.txt')).toBeNull();
  }, 30_000);

  /**
   * The Phase 2a reviewer's reproduction: a truncating implementation (one
   * that resolves as soon as it sees *an* entry, rather than draining every
   * entry and matching by path) passes on a two- or three-file fixture and
   * fails here. `manifest.json` is written last and sorts after all 500
   * numbered files (`packDirectory` walks in sorted order, and `'f' < 'm'`),
   * so it is nowhere near the first entry the parser emits.
   */
  it('finds the right entry in a 500-file archive, even when it is not the first entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pkg-many-'));
    for (let i = 0; i < 500; i++) {
      await writeFile(join(dir, `file-${String(i).padStart(4, '0')}.txt`), `contents of file ${i}`);
    }
    await writeFile(join(dir, 'manifest.json'), '{"schemaVersion":1,"target":true}');
    const { archive } = await packDirectory(dir);

    const bytes = await readArchiveEntry(archive, 'manifest.json');
    expect(bytes?.toString('utf8')).toBe('{"schemaVersion":1,"target":true}');
  }, 30_000);
});

/**
 * A zstd archive is an amplifier: 200 MB of zeroes compress to ~6 KB, so the
 * upload endpoint's byte cap (`PACKAGE_UPLOAD_MAX_BYTES`, 256 MiB) bounds
 * only what arrives on the wire, not what `zstdDecompressSync` allocates
 * from it. Both readers must refuse past `MAX_UNPACKED_BYTES` rather than
 * trying and dying — a Buffer allocation that big takes the whole API
 * process down, which no HTTP-level limit can mitigate.
 */
describe('a decompression bomb', () => {
  async function bomb(): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'bomb-'));
    await writeFile(join(dir, 'manifest.json'), Buffer.alloc(4 * 1024 * 1024, 0));
    const { archive } = await packDirectory(dir);
    return archive;
  }

  it('unpackArchive refuses to inflate past the cap instead of allocating it', async () => {
    const archive = await bomb();
    expect(archive.length).toBeLessThan(64 * 1024);
    const dest = await mkdtemp(join(tmpdir(), 'bomb-out-'));
    await expect(unpackArchive(archive, dest, 64 * 1024)).rejects.toThrow(/too large|larger than/i);
  });

  it('readArchiveEntry refuses the same archive', async () => {
    const archive = await bomb();
    await expect(readArchiveEntry(archive, 'manifest.json', 64 * 1024)).rejects.toThrow(
      /too large|larger than/i,
    );
  });

  it('carries a default cap, so a caller that passes nothing is still bounded', () => {
    expect(MAX_UNPACKED_BYTES).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_UNPACKED_BYTES)).toBe(true);
  });
});

describe('readArchiveEntries', () => {
  it('returns every requested entry from one pass, verbatim bytes included', async () => {
    const { archive } = await packDirectory(await fixture());
    const found = await readArchiveEntries(archive, ['tests/01.in', 'tests/01.out']);
    expect([...found.keys()].sort()).toEqual(['tests/01.in', 'tests/01.out']);
    // Trailing newline and all — a sample's bytes are fed to a program.
    expect(found.get('tests/01.in')!.toString('utf8')).toBe('1 2\n');
  }, 30_000);

  it('omits a path the archive does not contain rather than failing', async () => {
    const { archive } = await packDirectory(await fixture());
    const found = await readArchiveEntries(archive, ['tests/01.in', 'tests/99.in']);
    expect(found.has('tests/99.in')).toBe(false);
    expect(found.has('tests/01.in')).toBe(true);
  }, 30_000);

  it('asks for nothing and reads nothing', async () => {
    const { archive } = await packDirectory(await fixture());
    expect((await readArchiveEntries(archive, [])).size).toBe(0);
  }, 30_000);
});
