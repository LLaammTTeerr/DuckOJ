import { describe, expect, it } from 'vitest';
import { CHECKER_FILE_NAME, pairByStem, planPackage, type CaseDraft } from '../src/testdata/pairing.js';

function file(name: string, text: string) {
  return { name, text };
}

function caseDraft(over: Partial<CaseDraft> = {}): CaseDraft {
  return { id: 'x', input: 'i', answer: 'a', points: 10, group: 0, sample: false, ...over };
}

describe('pairByStem', () => {
  it('pairs .in with .out and with Polygon’s .a, in stem order', () => {
    const { paired, unpaired } = pairByStem([
      file('02.a', 'nine'),
      file('01.in', 'one two'),
      file('02.in', 'four five'),
      file('01.out', 'three'),
    ]);
    expect(paired.map((p) => p.stem)).toEqual(['01', '02']);
    expect(paired[0]).toEqual({ stem: '01', input: 'one two', answer: 'three' });
    expect(paired[1]).toEqual({ stem: '02', input: 'four five', answer: 'nine' });
    expect(unpaired).toEqual([]);
  });

  it('names the half whose partner is missing rather than dropping it', () => {
    const { paired, unpaired } = pairByStem([
      file('01.in', 'a'),
      file('01.out', 'b'),
      file('02.in', 'lonely input'),
      file('03.out', 'lonely answer'),
    ]);
    expect(paired.map((p) => p.stem)).toEqual(['01']);
    expect(unpaired).toContainEqual({ name: '02.in', reason: 'missing-answer' });
    expect(unpaired).toContainEqual({ name: '03.out', reason: 'missing-input' });
  });

  it('reports a file that is not a test file at all', () => {
    const { paired, unpaired } = pairByStem([file('solution.cpp', 'int main(){}'), file('.in', 'x')]);
    expect(paired).toEqual([]);
    expect(unpaired).toEqual([
      { name: 'solution.cpp', reason: 'unknown-suffix' },
      { name: '.in', reason: 'unknown-suffix' },
    ]);
  });

  it('prefers .out over .a for the same stem, whichever order they arrive in', () => {
    const aFirst = pairByStem([file('01.in', 'i'), file('01.a', 'polygon'), file('01.out', 'duckoj')]);
    expect(aFirst.paired).toHaveLength(1);
    expect(aFirst.paired[0]!.answer).toBe('duckoj');

    // The order the file picker hands files over is the OS's, not the
    // setter's, so the preference must not depend on it.
    const outFirst = pairByStem([file('01.in', 'i'), file('01.out', 'duckoj'), file('01.a', 'polygon')]);
    expect(outFirst.paired[0]!.answer).toBe('duckoj');
  });
});

describe('planPackage', () => {
  it('numbers files from the table order, so two identically-named selections cannot collide', () => {
    const plan = planPackage({
      name: 'abc',
      timeMs: 1000,
      memoryKb: 65536,
      checker: { kind: 'standard', source: '', language: 'cpp17' },
      cases: [caseDraft({ id: 'a' }), caseDraft({ id: 'b' })],
    });
    expect(plan.files.map((f) => f.name)).toEqual(['manifest.json', '01.in', '01.out', '02.in', '02.out']);
    expect(plan.totalPoints).toBe(20);
  });

  it('makes a sample a zero-point, ungrouped case — the package format has no sample flag', () => {
    const plan = planPackage({
      name: 'abc',
      timeMs: 1000,
      memoryKb: 65536,
      checker: { kind: 'standard', source: '', language: 'cpp17' },
      cases: [caseDraft({ id: 'a', sample: true, points: 40, group: 2 }), caseDraft({ id: 'b', points: 60, group: 1 })],
    });
    const manifest = plan.manifest as { tests: { points: number; group: number }[] };
    expect(manifest.tests[0]).toMatchObject({ points: 0, group: 0 });
    expect(manifest.tests[1]).toMatchObject({ points: 60, group: 1 });
    expect(plan.totalPoints).toBe(60);
  });

  it('packs a source checker as checker.cpp and names it in the manifest (D40)', () => {
    const plan = planPackage({
      name: 'abc',
      timeMs: 2000,
      memoryKb: 131072,
      checker: { kind: 'source', source: '#include "testlib.h"', language: 'cpp17' },
      cases: [caseDraft()],
    });
    const manifest = plan.manifest as { checker: unknown; limits: unknown };
    expect(manifest.checker).toEqual({ kind: 'source', path: CHECKER_FILE_NAME, language: 'cpp17' });
    expect(manifest.limits).toEqual({ timeMs: 2000, memoryKb: 131072 });
    expect(plan.files.find((f) => f.name === CHECKER_FILE_NAME)?.text).toBe('#include "testlib.h"');
  });

  it('pads stems wide enough that they sort as a human reads them', () => {
    const plan = planPackage({
      name: 'abc',
      timeMs: 1000,
      memoryKb: 65536,
      checker: { kind: 'standard', source: '', language: 'cpp17' },
      cases: Array.from({ length: 12 }, (_, i) => caseDraft({ id: `c${String(i)}` })),
    });
    expect(plan.files).toContainEqual(expect.objectContaining({ name: '01.in' }));
    expect(plan.files).toContainEqual(expect.objectContaining({ name: '12.in' }));
  });
});
