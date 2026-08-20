import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packDirectory, readArchiveEntry, unpackArchive } from '../src/archive.js';

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
