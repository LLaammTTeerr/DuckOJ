import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { renderInitYml } from '../src/init-yml.js';
import type { PackageManifestDto } from '../src/manifest.js';

const manifest: PackageManifestDto = {
  schemaVersion: 1,
  name: 'A plus B',
  checker: { kind: 'standard' },
  limits: { timeMs: 1000, memoryKb: 65536 },
  tests: [
    { input: 'tests/01.in', answer: 'tests/01.out', points: 1, group: 0 },
    { input: 'tests/02.in', answer: 'tests/02.out', points: 2, group: 0 },
  ],
};

describe('renderInitYml', () => {
  it('emits test-case paths relative to the problem directory, exactly as written', () => {
    // Phase 1 shipped a fixture whose init.yml said `01.in` while the files
    // lived in `tests/`. DMOJ resolves every key as
    // os.path.join(problem_root, key), so it raised KeyError at grade time and
    // the cause was two tasks away from the symptom. Paths pass through
    // untouched, and this test is what keeps that true.
    const doc = parse(renderInitYml(manifest)) as { test_cases: Array<Record<string, unknown>> };
    expect(doc.test_cases[0]).toMatchObject({ in: 'tests/01.in', out: 'tests/01.out', points: 1 });
  });

  it('sets archive to null so DMOJ reads files from disk', () => {
    const doc = parse(renderInitYml(manifest)) as { archive: unknown };
    expect(doc.archive).toBeNull();
  });

  it('does not emit time or memory limits, which DMOJ takes from the submission packet', () => {
    const doc = parse(renderInitYml(manifest)) as Record<string, unknown>;
    expect(doc).not.toHaveProperty('time_limit');
    expect(doc).not.toHaveProperty('memory_limit');
  });

  it('renders a standard checker as DMOJ builtin name', () => {
    const doc = parse(renderInitYml(manifest)) as { checker?: unknown };
    expect(doc.checker).toBe('standard');
  });

  it('groups cases into batches when a manifest uses groups', () => {
    const grouped: PackageManifestDto = {
      ...manifest,
      tests: [
        { input: 'tests/01.in', answer: 'tests/01.out', points: 2, group: 1 },
        { input: 'tests/02.in', answer: 'tests/02.out', points: 3, group: 1 },
      ],
    };
    const doc = parse(renderInitYml(grouped)) as { test_cases: Array<Record<string, unknown>> };
    expect(doc.test_cases).toHaveLength(1);
    const batch = doc.test_cases[0] as { points: number; batched: Array<{ in: string; out: string }> };
    expect(batch.points).toBe(5); // Sum of 2 + 3, not just first case (2)
    expect(batch.batched).toHaveLength(2);
    expect(batch.batched[0]).toEqual({ in: 'tests/01.in', out: 'tests/01.out' });
    expect(batch.batched[1]).toEqual({ in: 'tests/02.in', out: 'tests/02.out' });
  });

  it('renders ungrouped and grouped cases separately in the same document', () => {
    const mixed: PackageManifestDto = {
      schemaVersion: 1,
      name: 'Mixed groups',
      checker: { kind: 'standard' },
      limits: { timeMs: 1000, memoryKb: 65536 },
      tests: [
        { input: 'tests/01.in', answer: 'tests/01.out', points: 1, group: 0 },
        { input: 'tests/02.in', answer: 'tests/02.out', points: 2, group: 1 },
        { input: 'tests/03.in', answer: 'tests/03.out', points: 3, group: 1 },
      ],
    };
    const doc = parse(renderInitYml(mixed)) as { test_cases: Array<Record<string, unknown>> };
    expect(doc.test_cases).toHaveLength(2);
    // First case is ungrouped (group 0)
    expect(doc.test_cases[0]).toEqual({ in: 'tests/01.in', out: 'tests/01.out', points: 1 });
    // Second entry is the batch (group 1)
    const batch = doc.test_cases[1] as { points: number; batched: Array<{ in: string; out: string }> };
    expect(batch.points).toBe(5); // 2 + 3
    expect(batch.batched).toHaveLength(2);
    expect(batch.batched[0]).toEqual({ in: 'tests/02.in', out: 'tests/02.out' });
    expect(batch.batched[1]).toEqual({ in: 'tests/03.in', out: 'tests/03.out' });
  });
});

describe('renderInitYml — a source (testlib) checker', () => {
  const sourceChecker: PackageManifestDto = {
    ...manifest,
    checker: { kind: 'source', path: 'checker/check.cpp', language: 'cpp17' },
  };

  /**
   * The bug this pins (B3): the renderer used to write the checker's PATH as
   * a bare string — `checker: checker/check.cpp`. dmoj/problem.py's
   * `Problem.checker()` branches on `'.' in name`, so any path with a file
   * extension is treated as a **Python module path** and handed to
   * `load_module_from_file`, which `exec(compile(...))`s the file. A C++
   * checker therefore raises `SyntaxError` — caught by neither the
   * `except IOError` nor the `except AttributeError` around it — and every
   * checker-based problem died mid-grade with an internal error. Reproduced
   * against the real judge-server source: `load_module_from_file` on a
   * `check.cpp` raises `SyntaxError: invalid syntax (check.cpp, line 2)`.
   *
   * The only shape judge-server can actually run a compiled checker in is
   * the `bridged` builtin with `args` (dmoj/checkers/bridged.py).
   */
  it('renders as the bridged builtin, never as a bare path DMOJ would exec as Python', () => {
    const doc = parse(renderInitYml(sourceChecker)) as { checker?: unknown };
    expect(doc.checker).not.toBe('checker/check.cpp');
    expect(doc.checker).toEqual({
      name: 'bridged',
      args: { files: 'checker/check.cpp', lang: 'CPP17', type: 'testlib' },
    });
  });

  it('maps the manifest language key to the judge executor key', () => {
    const doc = parse(
      renderInitYml({
        ...manifest,
        checker: { kind: 'source', path: 'checker/check.cpp', language: 'cpp20' },
      }),
    ) as { checker: { args: { lang: string } } };
    expect(doc.checker.args.lang).toBe('CPP20');
  });
});
