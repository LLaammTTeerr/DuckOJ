import { stringify } from 'yaml';
import type { PackageManifestDto } from './manifest.js';

/**
 * Render our manifest into DMOJ's `init.yml`.
 *
 * The only DMOJ-specific file in this codebase. Two details are load-bearing
 * and were learned the expensive way:
 *
 * - Test paths are resolved as `os.path.join(problem_root, key)`
 *   (dmoj/problem.py), so they must be written exactly as they sit on disk.
 * - `archive: null` is correct and deliberate: `_resolve_archive_files` guards
 *   on truthiness, so null means "read files from the problem directory".
 *
 * Limits are absent on purpose — `Problem.__init__` takes `time_limit` and
 * `memory_limit` as arguments from the submission packet, so anything written
 * here would be ignored and would drift.
 */
export function renderInitYml(manifest: PackageManifestDto): string {
  const groups = new Map<number, PackageManifestDto['tests']>();
  for (const test of manifest.tests) {
    const bucket = groups.get(test.group) ?? [];
    bucket.push(test);
    groups.set(test.group, bucket);
  }

  // Build test cases with type assertion to work around strict type checking
  const entries = [...groups.entries()].sort(([a], [b]) => a - b);
  const testCasesArr: Array<Record<string, any>> = [];

  for (const [group, tests] of entries) {
    if (group === 0) {
      testCasesArr.push(...tests.map((t) => ({ in: t.input, out: t.answer, points: t.points })));
    } else {
      testCasesArr.push({
        points: tests.reduce((sum, t) => sum + t.points, 0),
        batched: tests.map((t) => ({ in: t.input, out: t.answer })),
      });
    }
  }

  const doc: any = {
    archive: null,
    checker: manifest.checker.kind === 'standard' ? 'standard' : manifest.checker.path,
    test_cases: testCasesArr,
  };

  return stringify(doc);
}
