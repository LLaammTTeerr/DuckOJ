/**
 * Reads a Polygon "full" package's `problem.xml` into a DuckOJ package
 * manifest plus the list of files to copy.
 *
 * Pure: no filesystem here. `importPolygon` (fs.ts) feeds this the XML text
 * and copies what it returns; tests feed it strings.
 *
 * The house rule from the freeze-window precedent governs everything below:
 * **what cannot be represented is refused loudly, never imported
 * best-effort.** An interactive problem, a missing `tests` testset, and
 * group dependencies each throw with their own message — importing any of
 * them "approximately" would silently change scoring or judging semantics.
 *
 * The fixture this is tested against is SYNTHETIC — written from a reading
 * of the Polygon package format, not exported by Polygon itself. The first
 * real package may falsify that reading; the parse errors are worded to
 * make that debuggable.
 */
import { XMLParser } from 'fast-xml-parser';
import { isSampleTest, type PackageManifestDto, type SampleAnnotationDto } from '@duckoj/package-format';

export interface PolygonImportPlan {
  manifest: PackageManifestDto;
  /** Paths relative to the polygon dir → paths inside the DuckOJ package. */
  copies: Array<{ from: string; to: string }>;
  /** What the importer saw and deliberately left behind. */
  skipped: string[];
}

export class PolygonImportError extends Error {}

function fail(message: string): never {
  throw new PolygonImportError(message);
}

/** The schema's own rule, applied before any copy is planned. */
function assertSafePath(path: string): string {
  if (path.startsWith('/')) fail(`refusing absolute path from problem.xml: ${path}`);
  if (path.split('/').includes('..')) fail(`refusing traversal in path from problem.xml: ${path}`);
  return path;
}

/** `tests/%02d` + 3 → `tests/03`. Polygon numbers tests from 1. */
function expandPattern(pattern: string, index: number): string {
  const match = /%(0?)(\d*)d/.exec(pattern);
  if (!match) fail(`path pattern has no %d placeholder: ${pattern}`);
  const width = match[2] === '' ? 1 : Number(match[2]);
  const digits = String(index).padStart(match[1] === '0' ? width : 1, '0');
  return assertSafePath(pattern.replace(match[0], digits));
}

/** fast-xml-parser yields an object for one child and an array for many. */
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

interface XmlTest {
  points?: string | number;
  group?: string;
  /**
   * Polygon's own sample marker, and the prose beside it. Read for the
   * explanation ONLY — never to decide scoring: see the `samples` block at
   * the end of `planImport`.
   */
  sample?: string | boolean;
  description?: string;
}
interface XmlGroup {
  name?: string;
  dependencies?: unknown;
}

/** The slice of Polygon's problem.xml this importer reads — nothing more. */
interface PolygonTestset {
  name?: string;
  'time-limit'?: string | number;
  'memory-limit'?: string | number;
  'test-count'?: string | number;
  'input-path-pattern'?: string;
  'answer-path-pattern'?: string;
  tests?: { test?: XmlTest | XmlTest[] };
  groups?: { group?: XmlGroup | XmlGroup[] };
}
interface PolygonProblemXml {
  'short-name'?: string;
  names?: { name?: Array<{ language?: string; value?: string }> | { language?: string; value?: string } };
  judging?: { testset?: PolygonTestset | PolygonTestset[] };
  assets?: {
    interactor?: unknown;
    solutions?: unknown;
    checker?: { source?: { path?: string } };
  };
  statements?: unknown;
}

export function planImport(problemXml: string): PolygonImportPlan {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    // Keep points like "10.0" as strings; Number() is applied where meant.
    parseAttributeValue: false,
    parseTagValue: true,
  });
  const doc = parser.parse(problemXml) as { problem?: PolygonProblemXml };
  const problem = doc.problem;
  if (!problem) fail('problem.xml has no <problem> root');

  const skipped: string[] = [];

  // Interactive problems cannot run under the standard checker flow.
  if (problem.assets?.interactor !== undefined) {
    fail('this is an interactive problem (<interactor> present) — DuckOJ cannot represent it');
  }

  const testsets = asArray(problem.judging?.testset);
  const testset = testsets.find((t) => t.name === 'tests');
  if (!testset) fail('problem.xml has no testset named "tests"');
  for (const other of testsets) {
    if (other.name !== 'tests') skipped.push(`testset "${String(other.name)}"`);
  }

  const timeMs = Number(testset['time-limit']);
  if (!Number.isInteger(timeMs) || timeMs <= 0) fail(`bad time-limit: ${String(testset['time-limit'])}`);

  // Polygon writes memory in BYTES; the manifest wants KB. 256 MiB arriving
  // as 268435456 must leave as 262144, not as a 268-million-KB limit that
  // parses cleanly and means nothing.
  //
  // Validated on the BYTES, exactly as `time-limit` is, and before the
  // division. The old check was `Math.floor(Number(...) / 1024) <= 0` alone,
  // and `NaN <= 0` is FALSE — so a missing or non-numeric `<memory-limit>`
  // walked straight past the one guard that exists to catch it and left
  // `memoryKb: NaN` in the manifest, which `JSON.stringify` writes out as
  // `null`. The import reported success and the real failure surfaced two
  // steps later, at upload, as a manifest-schema rejection with nothing
  // pointing back here. A byte count that is not a whole number of KB is
  // refused too rather than silently floored: `Math.floor` on 1536 bytes
  // discards half the limit the package asked for, and this file's rule is
  // that what cannot be represented is refused loudly.
  const memoryBytes = Number(testset['memory-limit']);
  if (!Number.isInteger(memoryBytes) || memoryBytes <= 0 || memoryBytes % 1024 !== 0) {
    fail(`bad memory-limit: ${String(testset['memory-limit'])}`);
  }
  const memoryKb = memoryBytes / 1024;

  const count = Number(testset['test-count']);
  const inputPattern = String(testset['input-path-pattern']);
  const answerPattern = String(testset['answer-path-pattern']);
  const declaredTests: XmlTest[] = asArray(testset.tests?.test);
  if (declaredTests.length > 0 && declaredTests.length !== count) {
    fail(`test-count says ${String(count)} but <tests> declares ${String(declaredTests.length)}`);
  }
  if (!Number.isInteger(count) || count < 1) fail(`bad test-count: ${String(testset['test-count'])}`);

  // Group dependencies change which groups score at all — importing a
  // package while dropping them would not be the same problem.
  const groups: XmlGroup[] = asArray(testset.groups?.group);
  for (const group of groups) {
    if (group.dependencies !== undefined) {
      fail(`group "${String(group.name)}" has <dependencies> — DuckOJ cannot represent group dependencies`);
    }
  }

  // Group names → 1..n by first appearance; ungrouped stays 0.
  const groupIndex = new Map<string, number>();
  const copies: PolygonImportPlan['copies'] = [];
  const tests: PackageManifestDto['tests'] = [];
  for (let i = 1; i <= count; i++) {
    const from = { input: expandPattern(inputPattern, i), answer: expandPattern(answerPattern, i) };
    const to = {
      input: `tests/${String(i).padStart(2, '0')}.in`,
      answer: `tests/${String(i).padStart(2, '0')}.ans`,
    };
    copies.push({ from: from.input, to: to.input }, { from: from.answer, to: to.answer });

    const declared = declaredTests[i - 1];
    let group = 0;
    if (declared?.group !== undefined) {
      const name = String(declared.group);
      if (!groupIndex.has(name)) groupIndex.set(name, groupIndex.size + 1);
      group = groupIndex.get(name)!;
    }
    // Polygon omits points on ICPC-style problems; 1 apiece keeps every
    // case equally weighted, which is what all-or-nothing scoring reads as.
    const points = declared?.points === undefined ? 1 : Number(declared.points);
    if (Number.isNaN(points) || points < 0) fail(`bad points on test ${String(i)}: ${String(declared?.points)}`);
    tests.push({ input: to.input, answer: to.answer, points, group });
  }

  // Checker: a testlib source if the package names one, else standard.
  let checker: PackageManifestDto['checker'] = { kind: 'standard' };
  const checkerAsset = problem.assets?.checker;
  const checkerSource = checkerAsset?.source;
  if (checkerSource?.path !== undefined) {
    const from = assertSafePath(String(checkerSource.path));
    copies.push({ from, to: 'checker/check.cpp' });
    // `cpp17` is the languages seed's key (scripts/seed-problem.ts); polygon
    // types like "cpp.g++17" all land on the same toolchain here.
    checker = { kind: 'source', path: 'checker/check.cpp', language: 'cpp17' };
  }

  const names = asArray(problem.names?.name);
  const english = names.find((n) => n.language === 'english') ?? names[0];
  const name = english?.value !== undefined ? String(english.value) : String(problem['short-name'] ?? 'imported');

  if (problem.statements !== undefined) skipped.push('statements (import them by hand)');
  if (problem.assets?.solutions !== undefined) skipped.push('solutions');

  // Polygon marks its samples explicitly (`sample="true"`) and often writes a
  // sentence about each one in `description`. That sentence is the
  // explanation D94 renders under the sample, so it is carried across.
  //
  // What is NOT carried across is Polygon's opinion of which tests are
  // samples. Scoring is derived here and stays derived: a test is a DuckOJ
  // sample when it is worth nothing in a group worth nothing
  // (`isSampleTest`), which is exactly what `points="0" group="samples"`
  // becomes above. A test Polygon calls a sample while giving it points is
  // imported with its declared scoring untouched and its description left
  // behind — reported in `skipped`, never silently rescored, because
  // rewriting points to make a description fit would change what the problem
  // grades.
  const isSample = isSampleTest(tests);
  const samples: SampleAnnotationDto[] = [];
  for (const [i, declared] of declaredTests.entries()) {
    const description = declared.description === undefined ? '' : String(declared.description).trim();
    if (description === '') continue;
    const test = tests[i]!;
    if (isSample(test)) samples.push({ input: test.input, explanation: description.slice(0, 4096) });
    else skipped.push(`description on test ${String(i + 1)} (not a sample: ${String(test.points)} point(s), group ${String(test.group)})`);
  }

  return {
    manifest: {
      schemaVersion: 1,
      name,
      checker,
      limits: { timeMs, memoryKb },
      tests,
      ...(samples.length > 0 ? { samples } : {}),
    },
    copies,
    skipped,
  };
}
