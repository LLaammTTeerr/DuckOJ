/**
 * The gate.
 *
 * Every check answers one question about the directory and records `pass`,
 * `fail` or `skip` with the evidence that produced it. Nothing here throws for
 * a finding — a finding is a report line — and nothing here publishes: a
 * caller that wants the package built or uploaded asks for that separately,
 * after reading `ok`.
 *
 * `skip` is not a soft pass. It means the check does not apply to this
 * directory (no validator, no expected-verdict matrix, a standard checker with
 * no source to compile), and the report says which, so "the model solution was
 * never run" can never be mistaken for "the model solution agreed".
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isSampleTest, parseManifest } from '@duckoj/package-format';

import { blockingFlags } from './flags.js';
import { sourceJudge, standardJudge, type Judge } from './judge.js';
import {
  groupVerdict,
  verdictSatisfies,
  type PrepareCheck,
  type PreparedProblem,
  type PreparedSolution,
  type PrepareReport,
  type Verdict,
} from './model.js';
import { compile, findTestlib, NO_TESTLIB, run } from './toolchain.js';

/** Below this a time limit is noise, above it nothing provincial is real. */
const MIN_TIME_MS = 100;
const MAX_TIME_MS = 60_000;
/** 16 MiB is under a JVM's floor; 1 GiB is D53's unpacked ceiling. */
const MIN_MEMORY_KB = 16 * 1024;
const MAX_MEMORY_KB = 1024 * 1024;

export interface ValidateOptions {
  /**
   * Structural checks only — no compiling, no running. The gate that answers
   * "is this directory shaped like a problem" in under a second, for an editor
   * or an MCP wrapper that wants feedback while the setter is still typing.
   */
  quick?: boolean;
  /** Where binaries and outputs are written. A temp directory by default. */
  workDir?: string;
}

interface TestOutcome {
  test: string;
  verdict: Verdict;
  wallMs: number;
  detail: string;
}

function pass(id: string, detail: string, data?: unknown): PrepareCheck {
  return data === undefined ? { id, status: 'pass', detail } : { id, status: 'pass', detail, data };
}
function fail(id: string, detail: string, data?: unknown): PrepareCheck {
  return data === undefined ? { id, status: 'fail', detail } : { id, status: 'fail', detail, data };
}
function skip(id: string, detail: string): PrepareCheck {
  return { id, status: 'skip', detail };
}

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

function checkStatement(problem: PreparedProblem): PrepareCheck {
  if (problem.statement === null) return fail('statement', problem.statementDetail);
  if (!problem.statement.hasEnglish) {
    return fail(
      'statement',
      `${problem.statementDetail} — no English section (D10 expects Vietnamese and English; ` +
        'add an "## English" heading or a statement.en.md)',
    );
  }
  return pass('statement', `${problem.statementDetail}, Vietnamese + English`);
}

function checkManifest(problem: PreparedProblem): PrepareCheck {
  try {
    parseManifest(problem.manifest);
  } catch (error) {
    return fail('manifest', error instanceof Error ? error.message : String(error));
  }
  const groups = new Set(problem.tests.map((t) => t.groupName || 'ungrouped'));
  return pass(
    'manifest',
    `${String(problem.tests.length)} test(s) in ${String(groups.size)} group(s), checker ${problem.manifest.checker.kind}`,
  );
}

async function checkTests(problem: PreparedProblem): Promise<PrepareCheck> {
  const missing: string[] = [];
  const empty: string[] = [];
  let bytes = 0;
  for (const test of problem.tests) {
    const inputBytes = await fileSize(test.inputPath);
    const answerBytes = await fileSize(test.answerPath);
    if (inputBytes === null) missing.push(`${test.id}: input ${test.inputPath}`);
    if (answerBytes === null) missing.push(`${test.id}: answer ${test.answerPath}`);
    // An empty ANSWER is the failure this check exists for: `run_matrix`
    // records having written one when the model solution crashed, after which
    // every solution is judged against a blank jury answer and everything
    // passes. An empty INPUT is legitimate for some problems, so it is not
    // flagged.
    if (answerBytes === 0) empty.push(test.id);
    bytes += (inputBytes ?? 0) + (answerBytes ?? 0);
  }
  if (missing.length > 0) {
    return fail('tests', `${String(missing.length)} test file(s) missing`, missing);
  }
  if (empty.length > 0) {
    return fail('tests', `empty answer file(s): ${empty.join(', ')}`, empty);
  }
  if (bytes > MAX_MEMORY_KB * 1024) {
    return fail('tests', `${String(bytes)} bytes of test data exceeds D53's 1 GiB unpacked ceiling`);
  }
  return pass(
    'tests',
    `${String(problem.tests.length)} test(s), every answer present, ${String(bytes)} bytes total`,
  );
}

function checkLimits(problem: PreparedProblem): PrepareCheck {
  const { timeMs, memoryKb } = problem.limits;
  const problems: string[] = [];
  if (timeMs < MIN_TIME_MS || timeMs > MAX_TIME_MS) {
    problems.push(`time limit ${String(timeMs)} ms is outside ${String(MIN_TIME_MS)}–${String(MAX_TIME_MS)} ms`);
  }
  if (memoryKb < MIN_MEMORY_KB || memoryKb > MAX_MEMORY_KB) {
    problems.push(
      `memory limit ${String(memoryKb)} KB is outside ${String(MIN_MEMORY_KB)}–${String(MAX_MEMORY_KB)} KB`,
    );
  }
  if (problems.length > 0) return fail('limits', problems.join('; '));
  return pass('limits', `${String(timeMs)} ms / ${String(memoryKb)} KB`);
}

function checkFlags(problem: PreparedProblem): PrepareCheck {
  if (problem.flags.length === 0) return skip('flags', 'no flags.json in this directory');
  const blockers = blockingFlags(problem.flags);
  if (blockers.length > 0) {
    return fail(
      'flags',
      `${String(blockers.length)} unresolved HIGH statement-ambiguity flag(s): ` +
        blockers.map((f) => f.id).join(', '),
      blockers,
    );
  }
  return pass('flags', `${String(problem.flags.length)} flag(s), none blocking`);
}

interface Compiled {
  check: PrepareCheck;
  judge: Judge | null;
}

async function buildChecker(problem: PreparedProblem, workDir: string): Promise<Compiled> {
  if (problem.checkerSourcePath === null) {
    return { check: skip('checker', 'standard token comparison — nothing to compile'), judge: standardJudge() };
  }
  const testlib = findTestlib(problem.dir);
  const binary = join(workDir, 'checker');
  const result = await compile(problem.checkerSourcePath, binary, testlib === null ? [] : [testlib]);
  if (!result.ok) {
    const hint = testlib === null ? ` (${NO_TESTLIB})` : '';
    return {
      check: fail('checker', `${problem.checkerSourcePath} does not compile${hint}`, result.stderr.slice(0, 4000)),
      judge: null,
    };
  }
  return {
    check: pass('checker', `${problem.checkerSourcePath} compiles${testlib === null ? '' : ` (testlib ${testlib})`}`),
    judge: sourceJudge(binary),
  };
}

async function checkValidator(problem: PreparedProblem, workDir: string): Promise<PrepareCheck> {
  if (problem.validatorPath === null) return skip('validator', 'no validator in this directory');
  const testlib = findTestlib(problem.dir);
  const binary = join(workDir, 'validator');
  const built = await compile(problem.validatorPath, binary, testlib === null ? [] : [testlib]);
  if (!built.ok) {
    const hint = testlib === null ? ` (${NO_TESTLIB})` : '';
    return fail('validator', `${problem.validatorPath} does not compile${hint}`, built.stderr.slice(0, 4000));
  }
  const rejected: Array<{ test: string; detail: string }> = [];
  for (const test of problem.tests) {
    const result = await run([binary], { wallMs: 60_000, memoryKb: null }, { stdinPath: test.inputPath });
    if (result.exitCode !== 0) {
      rejected.push({ test: test.id, detail: (result.stderr || result.stdout).trim().split('\n')[0] ?? '' });
    }
  }
  if (rejected.length > 0) {
    return fail('validator', `${String(rejected.length)} test(s) rejected by the validator`, rejected);
  }
  return pass('validator', `every one of ${String(problem.tests.length)} test(s) accepted`);
}

/** Run one compiled solution over every test and report a verdict per test. */
async function runSolution(
  problem: PreparedProblem,
  binary: string,
  judge: Judge,
  workDir: string,
  label: string,
): Promise<TestOutcome[]> {
  const outcomes: TestOutcome[] = [];
  const killMs = problem.limits.timeMs * 2;
  for (const test of problem.tests) {
    const outputPath = join(workDir, `${label}.out`);
    const result = await run([binary], { wallMs: killMs, memoryKb: problem.limits.memoryKb }, {
      stdinPath: test.inputPath,
      stdoutPath: outputPath,
    });
    // A judge stops a run at the limit, so time is decided before
    // correctness — the checker never sees the output of a run that
    // exceeded it.
    if (result.timedOut || result.wallMs >= killMs) {
      outcomes.push({
        test: test.id,
        verdict: 'TL',
        wallMs: Math.round(result.wallMs),
        detail: `killed at ${String(killMs)} ms (2x the ${String(problem.limits.timeMs)} ms limit)`,
      });
      continue;
    }
    if (result.exitCode !== 0) {
      outcomes.push({
        test: test.id,
        verdict: 'RE',
        wallMs: Math.round(result.wallMs),
        detail:
          result.signal === null
            ? `exit ${String(result.exitCode)}`
            : `killed by ${result.signal}` +
              ' (under ulimit -v, an out-of-memory abort is indistinguishable from any other crash)',
      });
      continue;
    }
    const outcome = await judge.check(test.inputPath, outputPath, test.answerPath);
    outcomes.push({
      test: test.id,
      verdict: outcome.verdict,
      wallMs: Math.round(result.wallMs),
      detail: outcome.detail,
    });
  }
  return outcomes;
}

/**
 * The model check, and the one verdict that is not about the model.
 *
 * `FAIL` is testlib's "the checker refused to judge" — it crashed, it could
 * not open the jury answer, it hit `quitf(_fail, …)` — and `model.ts` already
 * says of it that "a package bug must never be masked by a solution's own
 * failure". Counting it among "answers the model did not reproduce" masks it
 * exactly: the report then reads `checker: compiles` and `model: does not
 * reproduce 2 of 2 answer(s)`, and a setter goes and debugs a correct
 * program. So a `FAIL` is handed BACK as a replacement for the `checker`
 * line, and the model check becomes the same `skip` it already gets when the
 * checker did not build — nothing decided its answers, so nothing claims to
 * have.
 */
async function checkModel(
  problem: PreparedProblem,
  judge: Judge | null,
  workDir: string,
): Promise<{ check: PrepareCheck; binary: string | null; checkerOverride?: PrepareCheck }> {
  if (problem.modelPath === null) {
    return { check: fail('model', 'no model solution (@tag main, or solution.cpp) in this directory'), binary: null };
  }
  const binary = join(workDir, 'model');
  const built = await compile(problem.modelPath, binary);
  if (!built.ok) {
    return {
      check: fail('model', `${problem.modelPath} does not compile`, built.stderr.slice(0, 4000)),
      binary: null,
    };
  }
  if (judge === null) {
    return { check: skip('model', 'the checker did not compile, so no answer can be checked'), binary };
  }
  const outcomes = await runSolution(problem, binary, judge, workDir, 'model');
  const refused = outcomes.filter((o) => o.verdict === 'FAIL');
  if (refused.length > 0) {
    return {
      checkerOverride: fail(
        'checker',
        `${problem.checkerSourcePath ?? 'the standard comparison'} compiles but returned FAIL on ` +
          `${String(refused.length)} of ${String(outcomes.length)} test(s) — a FAIL is the CHECKER ` +
          'refusing to judge (it crashed, or could not read its files), never the solution disagreeing',
        refused,
      ),
      check: skip('model', 'the checker returned FAIL, so no answer could be checked'),
      binary,
    };
  }
  const bad = outcomes.filter((o) => o.verdict !== 'OK');
  const slowest = outcomes.reduce((max, o) => Math.max(max, o.wallMs), 0);
  if (bad.length > 0) {
    return {
      check: fail(
        'model',
        `the model solution does not reproduce ${String(bad.length)} of ${String(outcomes.length)} answer(s)`,
        bad,
      ),
      binary,
    };
  }
  return {
    check: pass(
      'model',
      `reproduces all ${String(outcomes.length)} answer(s); slowest run ${String(slowest)} ms ` +
        `against a ${String(problem.limits.timeMs)} ms limit`,
      outcomes,
    ),
    binary,
  };
}

async function checkMatrix(
  problem: PreparedProblem,
  judge: Judge | null,
  workDir: string,
): Promise<PrepareCheck> {
  const declared = problem.solutions.filter(
    (s: PreparedSolution) => s.tag !== 'main' && Object.keys(s.expect).length > 0,
  );
  if (declared.length === 0) {
    return skip('matrix', 'no solution declares an expected-verdict matrix (@expect group=VERDICT)');
  }
  if (judge === null) return skip('matrix', 'the checker did not compile, so no verdict can be decided');

  const groups = new Map<string, string[]>();
  for (const test of problem.tests) {
    const name = test.groupName || 'ungrouped';
    groups.set(name, [...(groups.get(name) ?? []), test.id]);
  }

  const disagreements: Array<Record<string, string>> = [];
  const observed: Array<Record<string, unknown>> = [];
  for (const solution of declared) {
    const binary = join(workDir, `zoo-${solution.file.replace(/[^A-Za-z0-9._-]/g, '_')}`);
    const built = await compile(solution.path, binary);
    if (!built.ok) {
      disagreements.push({ solution: solution.file, group: '*', expected: '(compiles)', actual: 'compile error' });
      continue;
    }
    const outcomes = await runSolution(problem, binary, judge, workDir, 'zoo');
    const byTest = new Map(outcomes.map((o) => [o.test, o.verdict]));
    const actualByGroup: Record<string, Verdict> = {};
    for (const [name, ids] of groups) {
      actualByGroup[name] = groupVerdict(ids.map((id) => byTest.get(id) ?? 'FAIL'));
    }
    observed.push({ solution: solution.file, tag: solution.tag, actual: actualByGroup });
    for (const [group, expected] of Object.entries(solution.expect)) {
      const actual = actualByGroup[group];
      if (actual === undefined) {
        disagreements.push({
          solution: solution.file,
          group,
          expected,
          actual: `(no such group; this problem has ${[...groups.keys()].join(', ')})`,
        });
        continue;
      }
      if (!verdictSatisfies(expected, actual)) {
        disagreements.push({ solution: solution.file, group, expected, actual });
      }
    }
  }

  if (disagreements.length > 0) {
    return fail(
      'matrix',
      `${String(disagreements.length)} declared verdict(s) not reproduced`,
      { disagreements, observed },
    );
  }
  return pass('matrix', `${String(declared.length)} declared solution(s) got their expected verdicts`, observed);
}

/**
 * The samples (D94): every one has both files, and every explanation names a
 * sample.
 *
 * `checkTests` already proves each test's two files exist, so on paper this
 * is a subset of it. It is a check of its own because the FAILURE reads
 * differently and lands somewhere else: a missing jury file is a broken
 * package, while a missing SAMPLE file is a problem that publishes with one
 * fewer worked example than the setter wrote — the API drops a half-sample
 * rather than showing an empty one, silently, which is exactly what a gate is
 * for. It also reports the count, so "this problem ships no examples at all"
 * is visible in the report rather than inferred from its absence.
 */
async function checkSamples(problem: PreparedProblem): Promise<PrepareCheck> {
  const isSample = isSampleTest(problem.manifest.tests);
  const samples = problem.tests.filter((test) =>
    isSample({ input: test.packageInput, answer: test.packageAnswer, points: test.points, group: test.group }),
  );
  if (samples.length === 0) {
    // `skip`, not `fail`. This gate answers "does the package deliver the
    // samples it declares", and a directory that declares none is a directory
    // the check does not apply to — the same reading `skip` has for a problem
    // with no validator. Turning "publishes no worked example" into a
    // blocking failure is a judgement about the PROBLEM, not about the
    // package, and it would fail every problem prepared before D94. The
    // message says what would have been read, so nobody mistakes this for a
    // pass.
    return skip(
      'samples',
      'no sample tests to check — a sample is a case worth 0 points in a group worth 0 ' +
        '(D87/D94), and GET /problems/{code} will publish none',
    );
  }

  const missing: string[] = [];
  for (const sample of samples) {
    if ((await fileSize(sample.inputPath)) === null) missing.push(`${sample.id}: input ${sample.inputPath}`);
    if ((await fileSize(sample.answerPath)) === null) missing.push(`${sample.id}: answer ${sample.answerPath}`);
  }
  if (missing.length > 0) {
    return fail('samples', `${String(missing.length)} sample file(s) missing`, missing);
  }

  // `parseManifest` refuses an explanation on a non-sample outright, so the
  // only way to reach this is a hand-edited manifest — which is exactly who
  // this line is for, since the refusal it would otherwise meet happens at
  // upload, one step away from the file being wrong.
  const samplePaths = new Set(samples.map((s) => s.packageInput));
  const orphaned = (problem.manifest.samples ?? [])
    .filter((annotation) => !samplePaths.has(annotation.input))
    .map((annotation) => annotation.input);
  if (orphaned.length > 0) {
    return fail('samples', `${String(orphaned.length)} explanation(s) name a test that is not a sample`, orphaned);
  }

  const explained = (problem.manifest.samples ?? []).length;
  return pass(
    'samples',
    `${String(samples.length)} sample(s), ${String(explained)} with an explanation`,
    samples.map((s) => s.id),
  );
}

export async function validateProblem(
  problem: PreparedProblem,
  options: ValidateOptions = {},
): Promise<PrepareReport> {
  const checks: PrepareCheck[] = [
    pass('layout', `${problem.layout} layout at ${problem.dir}`),
    checkStatement(problem),
    checkManifest(problem),
    await checkTests(problem),
    await checkSamples(problem),
    checkLimits(problem),
    checkFlags(problem),
  ];

  if (options.quick === true) {
    checks.push(
      skip('checker', '--quick: nothing compiled'),
      skip('validator', '--quick: nothing compiled'),
      skip('model', '--quick: nothing compiled'),
      skip('matrix', '--quick: nothing compiled'),
    );
  } else {
    const workDir = options.workDir ?? (await mkdtemp(join(tmpdir(), 'duckoj-prepare-')));
    const owned = options.workDir === undefined;
    try {
      const checker = await buildChecker(problem, workDir);
      // The slot is remembered rather than the line appended twice: a checker
      // that compiles and then refuses to judge is one finding about one
      // thing, and a report carrying both `checker: compiles` and
      // `checker: returned FAIL` would be a report that contradicts itself.
      const checkerSlot = checks.length;
      checks.push(checker.check);
      checks.push(await checkValidator(problem, workDir));
      const model = await checkModel(problem, checker.judge, workDir);
      checks.push(model.check);
      if (model.checkerOverride !== undefined) {
        checks[checkerSlot] = model.checkerOverride;
      }
      // A checker that refuses to judge decides nothing about the wrong
      // solutions either, so the matrix is skipped exactly as it is when the
      // checker did not build — the same `judge === null` path, for the same
      // reason.
      checks.push(
        await checkMatrix(problem, model.checkerOverride === undefined ? checker.judge : null, workDir),
      );
    } finally {
      if (owned) await rm(workDir, { recursive: true, force: true });
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    dir: problem.dir,
    layout: problem.layout,
    code: problem.code,
    name: problem.name,
    ok: !checks.some((c) => c.status === 'fail'),
    checks,
  };
}

/** The report as a human reads it: one line per check, failures last-word. */
export function formatReport(report: PrepareReport): string {
  const mark = { pass: '[x]', fail: '[!]', skip: '[ ]' } as const;
  const lines = [
    `${report.code} — ${report.name}`,
    `${report.layout} layout at ${report.dir}`,
    '',
    ...report.checks.map((c) => `${mark[c.status]} ${c.id.padEnd(10)} ${c.detail}`),
    '',
  ];
  for (const check of report.checks) {
    if (check.status === 'fail' && check.data !== undefined) {
      lines.push(`--- ${check.id} ---`, JSON.stringify(check.data, null, 2), '');
    }
  }
  lines.push(report.ok ? 'READY' : 'NOT READY');
  return lines.join('\n');
}
