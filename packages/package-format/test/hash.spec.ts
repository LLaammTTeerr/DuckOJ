import { describe, expect, it } from 'vitest';
import { canonicalForm, hashFile, packageHash, type PackageFile } from '../src/hash.js';

const a: PackageFile = { path: 'tests/01.in', size: 3, sha256: hashFile(new TextEncoder().encode('1 2')) };
const b: PackageFile = { path: 'manifest.json', size: 2, sha256: hashFile(new TextEncoder().encode('{}')) };

describe('packageHash', () => {
  it('is independent of the order files are supplied in', () => {
    expect(packageHash([a, b])).toBe(packageHash([b, a]));
  });

  it('changes when a file’s contents change', () => {
    const changed: PackageFile = { ...a, sha256: hashFile(new TextEncoder().encode('9 9')) };
    expect(packageHash([a, b])).not.toBe(packageHash([changed, b]));
  });

  it('changes when a file is renamed, even with identical contents', () => {
    const renamed: PackageFile = { ...a, path: 'tests/99.in' };
    expect(packageHash([a, b])).not.toBe(packageHash([renamed, b]));
  });

  it('changes when a file is added', () => {
    expect(packageHash([a, b])).not.toBe(packageHash([a, b, { ...a, path: 'tests/03.in' }]));
  });

  it('sorts by path, so the canonical form is stable', () => {
    expect(canonicalForm([a, b]).split('\n')[0]).toContain('manifest.json');
  });

  it('rejects duplicate paths rather than silently hashing one of them', () => {
    expect(() => packageHash([a, { ...a, size: 9 }])).toThrow(/duplicate/i);
  });

  it('produces a 64-character lowercase hex digest', () => {
    expect(packageHash([a, b])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a crafted path containing NUL bytes', () => {
    const collision: PackageFile = { path: 'bar\x002\x00bbb\nfoo', size: 1, sha256: a.sha256 };
    expect(() => packageHash([collision])).toThrow(/NUL/);
  });

  it('rejects a non-hex sha256', () => {
    const badHash: PackageFile = { path: 'test.txt', size: 2, sha256: 'bbb' };
    expect(() => packageHash([badHash])).toThrow(/invalid sha256/i);
  });

  it('pins the canonical byte format so changes are deliberate', () => {
    // This golden vector must not change without deliberate breaking of every stored package.
    // If it goes red, you have changed the canonical form or how it is hashed.
    const golden: PackageFile = { path: 'file.txt', size: 4, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' };
    expect(packageHash([golden])).toBe('bc0ba24f41f19e23706d9053464171f5f4170e8f4b44393ec7cf7cc75ed89fa6');
  });
});
