import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A hoisted flag `rename`'s mock reads from, so an individual test can flip
// it on to fail exactly the next `rename()` call — simulating a process
// death between `put()`'s write and its rename — without affecting any
// other test in this file, which all rely on `rename` behaving for real.
const renameFailure = vi.hoisted(() => ({ armed: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (renameFailure.armed) {
        renameFailure.armed = false;
        throw new Error('simulated crash between write and rename');
      }
      return actual.rename(...args);
    },
  };
});

const { FilesystemPackageStore } = await import('../src/packages/package.store.js');

const HASH = 'a'.repeat(64);

async function store(): Promise<InstanceType<typeof FilesystemPackageStore>> {
  return new FilesystemPackageStore(await mkdtemp(join(tmpdir(), 'store-')));
}

describe('FilesystemPackageStore', () => {
  afterEach(() => {
    // Belt-and-braces: a test that fails before consuming the armed
    // failure must not leak it into the next test in this file.
    renameFailure.armed = false;
  });

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

  /**
   * The crash-atomicity property `put()` exists to guarantee: a process
   * death between the write and the rename — OOM kill, `podman stop`, a
   * host crash, all realistic on a large upload — must never leave a
   * truncated file sitting at the real hash path. Pre-fix, `put()` wrote
   * straight to `path`, so this exact failure would have left a corrupt
   * blob `has()` reports present forever, with no self-healing path (see
   * `package.store.ts`'s doc comment on `put`).
   */
  it('leaves no file at the final path when the write crashes between the write and the rename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'store-'));
    const s = new FilesystemPackageStore(dir);

    renameFailure.armed = true;
    await expect(s.put(HASH, Buffer.from('truncated by a crash'))).rejects.toThrow(
      /simulated crash between write and rename/,
    );

    expect(await s.has(HASH)).toBe(false);

    // No stray temp file left behind either — the shard directory should
    // be empty, not just missing the final hash-named file.
    const shardDir = join(dir, HASH.slice(0, 2));
    expect(await readdir(shardDir)).toEqual([]);
  });

  it('recovers on retry after a simulated crash — a client resending the correct bytes succeeds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'store-'));
    const s = new FilesystemPackageStore(dir);

    renameFailure.armed = true;
    await expect(s.put(HASH, Buffer.from('hello'))).rejects.toThrow();
    expect(await s.has(HASH)).toBe(false);

    // The retry — same call, no special-casing needed — lands normally.
    await s.put(HASH, Buffer.from('hello'));
    expect(await s.has(HASH)).toBe(true);
    expect((await s.get(HASH)).toString()).toBe('hello');
  });
});
