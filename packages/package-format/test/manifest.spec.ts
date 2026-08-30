import { describe, expect, it } from 'vitest';
import { manifestSamples, parseManifest } from '../src/manifest.js';

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

/**
 * D94's samples. The rule under test is "worth nothing, in a group worth
 * nothing" — the one rule that covers BOTH authoring paths (the browser's
 * `points: 0, group: 0` and Polygon's zero-point named `samples` group) and
 * that still refuses the zero-point member of a scored batch
 * `distributePoints` produces.
 */
const graded = {
  schemaVersion: 1,
  name: 'Tổng hai số',
  checker: { kind: 'standard' as const },
  limits: { timeMs: 1000, memoryKb: 262144 },
  tests: [
    // Polygon's shape: samples in their own named group, worth nothing.
    { input: 'tests/01.in', answer: 'tests/01.ans', points: 0, group: 1 },
    { input: 'tests/02.in', answer: 'tests/02.ans', points: 0, group: 1 },
    // A scored batch that `distributePoints` gave a 0 to — NOT a sample.
    { input: 'tests/03.in', answer: 'tests/03.ans', points: 8, group: 2 },
    { input: 'tests/04.in', answer: 'tests/04.ans', points: 0, group: 2 },
  ],
};

describe('samples', () => {
  it('reads a zero-point named group as the samples, and never a zero-point member of a scored batch', () => {
    expect(manifestSamples(parseManifest(graded)).map((s) => s.input)).toEqual([
      'tests/01.in',
      'tests/02.in',
    ]);
  });

  it("reads the browser authoring tab's shape — points 0 in group 0, beside scored ungrouped cases", () => {
    const authored = {
      ...valid,
      tests: [
        { input: 'tests/01.in', answer: 'tests/01.out', points: 0, group: 0 },
        { input: 'tests/02.in', answer: 'tests/02.out', points: 10, group: 0 },
      ],
    };
    expect(manifestSamples(parseManifest(authored)).map((s) => s.input)).toEqual(['tests/01.in']);
  });

  it('finds no samples in a package where every case scores', () => {
    expect(manifestSamples(parseManifest(valid))).toEqual([]);
  });

  it('joins an explanation onto the sample it names, and leaves the others null', () => {
    const annotated = { ...graded, samples: [{ input: 'tests/02.in', explanation: 'Trạm $3$ bị cô lập.' }] };
    expect(manifestSamples(parseManifest(annotated))).toEqual([
      { input: 'tests/01.in', answer: 'tests/01.ans', explanation: null },
      { input: 'tests/02.in', answer: 'tests/02.ans', explanation: 'Trạm $3$ bị cô lập.' },
    ]);
  });

  it('parses a manifest that has no samples key at all — every package built before D94', () => {
    expect(parseManifest(valid).samples).toBeUndefined();
  });

  it('refuses an explanation attached to a test that is not a sample, naming the path', () => {
    const wrong = { ...graded, samples: [{ input: 'tests/03.in', explanation: 'nope' }] };
    expect(() => parseManifest(wrong)).toThrow(/tests\/03\.in.*not a sample/);
  });

  it('refuses two explanations for one sample', () => {
    const twice = {
      ...graded,
      samples: [
        { input: 'tests/01.in', explanation: 'a' },
        { input: 'tests/01.in', explanation: 'b' },
      ],
    };
    expect(() => parseManifest(twice)).toThrow(/explained twice/);
  });

  it('refuses an explanation path that escapes the package root', () => {
    const escaping = { ...graded, samples: [{ input: '../../etc/passwd', explanation: 'x' }] };
    expect(() => parseManifest(escaping)).toThrow(/samples\.0\.input/);
  });
});
