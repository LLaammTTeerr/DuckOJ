import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilesystemPackageStore } from '../src/packages/package.store.js';

const HASH = 'a'.repeat(64);

async function store(): Promise<FilesystemPackageStore> {
  return new FilesystemPackageStore(await mkdtemp(join(tmpdir(), 'store-')));
}

describe('FilesystemPackageStore', () => {
  it('round-trips bytes by hash', async () => {
    const s = await store();
    await s.put(HASH, Buffer.from('hello'));
    expect((await s.get(HASH)).toString()).toBe('hello');
  });

  it('reports absence without throwing', async () => {
    expect(await (await store()).has(HASH)).toBe(false);
  });

  it('throws a distinguishable error when reading something absent', async () => {
    await expect((await store()).get(HASH)).rejects.toThrow(/not found|ENOENT/i);
  });

  it('is idempotent — putting the same hash twice is not an error', async () => {
    const s = await store();
    await s.put(HASH, Buffer.from('hello'));
    await s.put(HASH, Buffer.from('hello'));
    expect((await s.get(HASH)).toString()).toBe('hello');
  });

  it('refuses a hash that is not 64 hex characters', async () => {
    const s = await store();
    // The hash reaches the filesystem as a path component. Anything else is a
    // traversal primitive: `../../etc/x` would write outside the store.
    await expect(s.put('../escape', Buffer.from('x'))).rejects.toThrow(/hash/i);
    await expect(s.get('../escape')).rejects.toThrow(/hash/i);
  });

  it('has() throws on a malformed hash rather than reporting it absent', async () => {
    // Paired with "reports absence without throwing" above: has() must
    // distinguish "this key is not a valid hash" (a caller bug) from "this
    // key is a valid hash that just isn't present" (false). Collapsing both
    // to `false` would let a malformed key sail through an upload
    // pre-check, or make an eviction pass silently skip it.
    const s = await store();
    await expect(s.has('../escape')).rejects.toThrow(/hash/i);
  });

  it('reports absence when a directory occupies the package path', async () => {
    // has() switched from readFile to stat, and stat succeeds on a
    // directory where readFile would fail. Without the isFile() check,
    // has() would say true for a path get() cannot serve, turning a 404
    // into a confusing EISDIR 500 for whoever trusted has() first.
    const dir = await mkdtemp(join(tmpdir(), 'store-'));
    await mkdir(join(dir, HASH.slice(0, 2), HASH), { recursive: true });
    expect(await new FilesystemPackageStore(dir).has(HASH)).toBe(false);
  });

  it('shards by hash prefix so one directory does not hold every package', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'store-'));
    await new FilesystemPackageStore(dir).put(HASH, Buffer.from('x'));
    expect(await readdir(dir)).toEqual([HASH.slice(0, 2)]);
  });
});
