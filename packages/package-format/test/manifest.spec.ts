import { describe, expect, it } from 'vitest';
import { parseManifest } from '../src/manifest.js';

const valid = {
  schemaVersion: 1,
  name: 'A plus B',
  checker: { kind: 'standard' as const },
  limits: { timeMs: 1000, memoryKb: 65536 },
  tests: [
    { input: 'tests/01.in', answer: 'tests/01.out', points: 1, group: 0 },
    { input: 'tests/02.in', answer: 'tests/02.out', points: 1, group: 0 },
  ],
};

describe('parseManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(parseManifest(valid).tests).toHaveLength(2);
  });

  it('rejects an unsupported schema version, naming the field', () => {
    expect(() => parseManifest({ ...valid, schemaVersion: 99 })).toThrow(/schemaVersion/);
  });

  it('rejects a manifest with no tests, because a package that grades nothing is a mistake', () => {
    expect(() => parseManifest({ ...valid, tests: [] })).toThrow(/tests/);
  });

  it('rejects a test path that escapes the package root', () => {
    const escaping = { ...valid, tests: [{ ...valid.tests[0]!, input: '../../etc/passwd' }] };
    expect(() => parseManifest(escaping)).toThrow(/input/);
  });

  it('rejects an absolute test path', () => {
    const absolute = { ...valid, tests: [{ ...valid.tests[0]!, input: '/etc/passwd' }] };
    expect(() => parseManifest(absolute)).toThrow(/input/);
  });
});
