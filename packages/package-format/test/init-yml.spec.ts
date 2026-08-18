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
        { input: 'tests/01.in', answer: 'tests/01.out', points: 1, group: 1 },
        { input: 'tests/02.in', answer: 'tests/02.out', points: 1, group: 1 },
      ],
    };
    const doc = parse(renderInitYml(grouped)) as { test_cases: Array<Record<string, unknown>> };
    expect(doc.test_cases).toHaveLength(1);
    expect(doc.test_cases[0]).toHaveProperty('batched');
  });
});
