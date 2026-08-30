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
/**
 * DMOJ's `bridged` checker invocation (dmoj/checkers/bridged.py). `files` is
 * resolved against the problem root, so it is the package-relative path
 * untouched; `lang` is a judge EXECUTOR key (CPP17, …), not our language key;
 * `type` names a contrib module (dmoj/contrib/) — `testlib`, because a DuckOJ
 * source checker IS a testlib checker (D40).
 */
type BridgedChecker = {
  name: 'bridged';
  args: { files: string; lang: string; type: 'testlib' };
};

type StandardTestCase = { in: string; out: string; points: number };
type BatchedTestCase = {
  points: number;
  batched: Array<{ in: string; out: string }>;
};
type TestCase = StandardTestCase | BatchedTestCase;

type InitYmlDoc = {
  archive: null;
  checker: string | BridgedChecker;
  test_cases: TestCase[];
};

/**
 * Our language key -> judge-server's executor key (dmoj/executors/CPP17.py).
 * Upper-casing is the whole mapping today, and it is the same one
 * `apps/judged/src/main.ts` applies to a submission's language; it lives here
 * too rather than being imported because `@duckoj/package-format` must not
 * depend on the judged app.
 */
function executorKey(languageKey: string): string {
  return languageKey.toUpperCase();
}

/**
 * A source checker MUST be rendered as the `bridged` builtin with args.
 *
 * Written as a bare path (`checker: checker/check.cpp`) — which is what this
 * did until B3 — `Problem.checker()` in dmoj/problem.py sees a `.` in the
 * name, takes it for a **Python module path**, and `exec(compile(...))`s the
 * file: a C++ checker raises `SyntaxError`, which neither the `except IOError`
 * nor the `except AttributeError` around that call catches. Every
 * checker-based problem — including every Polygon import, which always plans a
 * `kind: 'source'` checker (`@duckoj/polygon-import`) — therefore failed
 * mid-grade with an internal error, and the manifest's `language` field was
 * never read by anything at all.
 */
function renderChecker(checker: PackageManifestDto['checker']): string | BridgedChecker {
  if (checker.kind === 'standard') return 'standard';
  return {
    name: 'bridged',
    args: { files: checker.path, lang: executorKey(checker.language), type: 'testlib' },
  };
}

export function renderInitYml(manifest: PackageManifestDto): string {
  const groups = new Map<number, PackageManifestDto['tests']>();
  for (const test of manifest.tests) {
    const bucket = groups.get(test.group) ?? [];
    bucket.push(test);
    groups.set(test.group, bucket);
  }

  // Build test cases by grouping and transforming
  const entries = [...groups.entries()].sort(([a], [b]) => a - b);
  const testCases: TestCase[] = [];

  for (const [group, tests] of entries) {
    if (group === 0) {
      testCases.push(...tests.map((t) => ({ in: t.input, out: t.answer, points: t.points })));
    } else {
      testCases.push({
        points: tests.reduce((sum, t) => sum + t.points, 0),
        batched: tests.map((t) => ({ in: t.input, out: t.answer })),
      });
    }
  }

  const doc: InitYmlDoc = {
    archive: null,
    checker: renderChecker(manifest.checker),
    test_cases: testCases,
  };

  return stringify(doc);
}
