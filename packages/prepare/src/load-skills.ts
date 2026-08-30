/**
 * The `competitive-programming` skills' own output layout.
 *
 *     problem.json          the pipeline's source of truth (tools/problem_meta.py)
 *     files/validator.cpp   testlib validator
 *     files/<checker>.cpp   a custom checker, when problem.json names one
 *     solutions/*.cpp       the zoo, each with a @tag/@expect header
 *     tests/<subtask>/NN.in the test data, answers beside them as NN.a
 *     flags.json            the judgement register
 *
 * Only the slice this gate needs is read, and every way that slice can be
 * wrong is refused loudly — the same house rule `@duckoj/polygon-import`
 * states: what cannot be represented is refused, never imported best-effort.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { PackageManifestDto } from '@duckoj/package-format';

import { PrepareError } from './errors.js';
import type { PreparedProblem, PreparedSolution, PreparedTest } from './model.js';
import { parseSolutionMeta } from './solution-meta.js';
import { findTestlib, NO_TESTLIB } from './toolchain.js';

/**
 * The stock testlib checkers whose behaviour IS DMOJ's `standard` checker:
 * compare the two outputs as sequences of whitespace-separated tokens.
 * Everything else — `rcmp6`'s tolerance, `yesno`'s case-insensitivity,
 * `lcmp`'s line semantics — differs from token equality in ways a package
 * cannot express as `{"kind":"standard"}`, so it is vendored as a real
 * testlib source checker instead (D40).
 */
const TOKEN_EQUALITY_CHECKERS = new Set(['wcmp', 'ncmp']);

interface RawSubtask {
  id?: unknown;
  points?: unknown;
  depends_on?: unknown;
}
interface RawProblem {
  schema?: unknown;
  name?: unknown;
  title?: unknown;
  tags?: unknown;
  limits?: { time_ms_published?: unknown; memory_mb?: unknown };
  io?: { input?: unknown; output?: unknown };
  checker?: { kind?: unknown; name?: unknown };
  subtasks?: unknown;
}

function integer(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || typeof value === 'boolean') {
    throw new PrepareError(`problem.json: ${what} is ${JSON.stringify(value)}, expected an integer`);
  }
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new PrepareError(`problem.json: ${what} is ${JSON.stringify(value)}, expected a string`);
  }
  return value;
}

/**
 * Split a subtask's points across its tests so the batch sums to exactly what
 * `problem.json` declared.
 *
 * `renderInitYml` gives a batch `points = sum(member points)`, so the sum is
 * the number that reaches a contestant's score; rounding it away would quietly
 * change the ladder the setter designed. The remainder goes to the first few
 * tests rather than being dropped.
 */
export function distributePoints(total: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

export async function loadSkills(dir: string, code: string): Promise<
  Pick<
    PreparedProblem,
    | 'code'
    | 'name'
    | 'limits'
    | 'checkerSourcePath'
    | 'validatorPath'
    | 'modelPath'
    | 'solutions'
    | 'tests'
    | 'manifest'
    | 'copies'
    | 'tags'
  >
> {
  const path = join(dir, 'problem.json');
  let raw: RawProblem;
  try {
    raw = JSON.parse(await readFile(path, 'utf8')) as RawProblem;
  } catch (error) {
    throw new PrepareError(
      `problem.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (raw.schema !== 1) {
    throw new PrepareError(`problem.json: unsupported schema ${JSON.stringify(raw.schema)}, expected 1`);
  }

  const timeMs = integer(raw.limits?.time_ms_published, 'limits.time_ms_published');
  const memoryMb = integer(raw.limits?.memory_mb, 'limits.memory_mb');
  if (timeMs <= 0 || memoryMb <= 0) {
    throw new PrepareError('problem.json: limits must be positive');
  }

  const input = raw.io?.input ?? 'stdin';
  const output = raw.io?.output ?? 'stdout';
  if (input !== 'stdin' || output !== 'stdout') {
    // A DuckOJ package has no file-IO field at all: every submission is run
    // on stdin/stdout. Importing a file-IO problem "approximately" would
    // grade every submission against a file no solution writes.
    throw new PrepareError(
      `problem.json declares file IO (io.input=${JSON.stringify(input)}, ` +
        `io.output=${JSON.stringify(output)}) — DuckOJ grades on stdin/stdout only`,
    );
  }

  const subtasksRaw = raw.subtasks;
  if (!Array.isArray(subtasksRaw) || subtasksRaw.length === 0) {
    throw new PrepareError('problem.json declares no subtasks');
  }
  const subtasks = subtasksRaw.map((entry, index) => {
    const s = entry as RawSubtask;
    const id = text(s.id, `subtasks[${String(index)}].id`);
    const dependsOn = s.depends_on;
    if (Array.isArray(dependsOn) && dependsOn.length > 0) {
      // The same refusal `@duckoj/polygon-import` makes for Polygon's
      // `<dependencies>`: a DuckOJ manifest has no way to say that one batch
      // only scores when another passed, so importing it would be a
      // different problem than the one that was set.
      throw new PrepareError(
        `problem.json: subtask "${id}" has depends_on — DuckOJ cannot represent subtask dependencies`,
      );
    }
    return { id, points: integer(s.points, `subtask "${id}" points`) };
  });

  const checkerKind = raw.checker?.kind;
  const checkerName = text(raw.checker?.name, 'checker.name');
  const copies: Array<{ from: string; to: string }> = [];
  let checker: PackageManifestDto['checker'] = { kind: 'standard' };
  let checkerSourcePath: string | null = null;

  if (checkerKind === 'custom') {
    const src = join(dir, 'files', checkerName);
    if (!existsSync(src)) {
      throw new PrepareError(`problem.json names a custom checker files/${checkerName}, which is not on disk`);
    }
    checkerSourcePath = src;
    checker = { kind: 'source', path: 'checker/check.cpp', language: 'cpp17' };
    copies.push({ from: src, to: 'checker/check.cpp' });
  } else if (checkerKind === 'stock') {
    if (!TOKEN_EQUALITY_CHECKERS.has(checkerName)) {
      const testlib = findTestlib(dir);
      if (testlib === null) throw new PrepareError(`${NO_TESTLIB} (needed to vendor stock checker ${checkerName})`);
      const src = join(testlib, 'checkers', `${checkerName}.cpp`);
      if (!existsSync(src)) {
        throw new PrepareError(`no stock testlib checker named ${checkerName} in ${testlib}/checkers`);
      }
      checkerSourcePath = src;
      checker = { kind: 'source', path: 'checker/check.cpp', language: 'cpp17' };
      copies.push({ from: src, to: 'checker/check.cpp' });
    }
  } else {
    throw new PrepareError(
      `problem.json: checker.kind is ${JSON.stringify(checkerKind)}, expected "stock" or "custom"`,
    );
  }

  const tests: PreparedTest[] = [];
  const manifestTests: PackageManifestDto['tests'] = [];
  for (const [index, subtask] of subtasks.entries()) {
    const groupDir = join(dir, 'tests', subtask.id);
    let entries: string[];
    try {
      entries = (await readdir(groupDir)).filter((n) => n.endsWith('.in')).sort();
    } catch {
      throw new PrepareError(`no tests/${subtask.id}/ directory for subtask "${subtask.id}"`);
    }
    if (entries.length === 0) {
      throw new PrepareError(`subtask "${subtask.id}" has no .in files in tests/${subtask.id}/`);
    }
    const points = distributePoints(subtask.points, entries.length);
    for (const [i, entry] of entries.entries()) {
      const stem = entry.slice(0, -'.in'.length);
      const packageInput = `tests/${subtask.id}/${stem}.in`;
      const packageAnswer = `tests/${subtask.id}/${stem}.ans`;
      const inputPath = join(groupDir, entry);
      const answerPath = join(groupDir, `${stem}.a`);
      tests.push({
        id: `${subtask.id}/${stem}`,
        inputPath,
        answerPath,
        points: points[i] ?? 0,
        group: index + 1,
        groupName: subtask.id,
        packageInput,
        packageAnswer,
      });
      manifestTests.push({
        input: packageInput,
        answer: packageAnswer,
        points: points[i] ?? 0,
        group: index + 1,
      });
      copies.push({ from: inputPath, to: packageInput }, { from: answerPath, to: packageAnswer });
    }
  }

  const solutions: PreparedSolution[] = [];
  const solutionsDir = join(dir, 'solutions');
  if (existsSync(solutionsDir)) {
    for (const entry of (await readdir(solutionsDir)).filter((n) => n.endsWith('.cpp')).sort()) {
      const abs = join(solutionsDir, entry);
      const meta = parseSolutionMeta(await readFile(abs, 'utf8'));
      solutions.push({
        file: basename(abs),
        path: abs,
        tag: meta.tag ?? 'accepted',
        expect: meta.expect,
      });
    }
  }

  const title = raw.title as Record<string, unknown> | undefined;
  const name =
    (typeof title?.vi === 'string' && title.vi !== '' ? title.vi : undefined) ??
    (typeof title?.en === 'string' && title.en !== '' ? title.en : undefined) ??
    text(raw.name, 'name');

  return {
    code,
    name,
    limits: { timeMs, memoryKb: memoryMb * 1024 },
    checkerSourcePath,
    validatorPath: existsSync(join(dir, 'files', 'validator.cpp')) ? join(dir, 'files', 'validator.cpp') : null,
    modelPath: solutions.find((s) => s.tag === 'main')?.path ?? null,
    solutions,
    tests,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
    manifest: {
      schemaVersion: 1,
      name,
      checker,
      limits: { timeMs, memoryKb: memoryMb * 1024 },
      tests: manifestTests,
    },
    copies,
  };
}
