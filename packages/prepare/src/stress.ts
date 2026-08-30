/**
 * The stress hook: generate small random cases until the model solution and a
 * brute-force oracle disagree.
 *
 * The convention (`validating-solutions`, and D90's ruling on the generator's
 * shape): **the generator is called with one argument, a seed, and writes ONE
 * complete test case to stdout.** That is not the shape the `gen.py` files
 * under `content/problems/` have — those regenerate a whole `tests/`
 * directory deterministically, which
 * is a different job — so a stress generator is written for this loop, and the
 * contract is stated rather than assumed.
 *
 * A disagreement is reported through the problem's own checker, not by string
 * comparison: a problem with several correct answers would otherwise report a
 * counterexample on every round.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

import { PrepareError } from './errors.js';
import { sourceJudge, standardJudge, type Judge } from './judge.js';
import type { PreparedProblem } from './model.js';
import { compile, findTestlib, run } from './toolchain.js';

export interface StressOptions {
  /** The brute-force oracle: a `.cpp` to compile, or a `.py` to run. */
  brute: string;
  /** The generator: `<gen> <seed>` writes one case to stdout. */
  gen: string;
  rounds?: number;
  /** Defaults to the problem's own model solution. */
  model?: string;
  /** Wall-clock ceiling for one run, in ms. Defaults to 2x the time limit. */
  wallMs?: number;
}

export interface StressCounterexample {
  seed: number;
  input: string;
  modelOutput: string;
  bruteOutput: string;
  detail: string;
}

export interface StressResult {
  rounds: number;
  /** How many rounds actually ran before a counterexample was found. */
  ran: number;
  counterexample: StressCounterexample | null;
}

/** `argv` that runs one program — compiled if it is C++, interpreted if Python. */
async function runner(
  source: string,
  workDir: string,
  name: string,
  problemDir: string,
): Promise<string[]> {
  const extension = extname(source);
  if (extension === '.py') return ['python3', source];
  if (extension === '.cpp' || extension === '.cc' || extension === '.cxx') {
    const binary = join(workDir, name);
    const testlib = findTestlib(problemDir);
    const built = await compile(source, binary, testlib === null ? [] : [testlib]);
    if (!built.ok) throw new PrepareError(`${source} does not compile:\n${built.stderr.slice(0, 4000)}`);
    return [binary];
  }
  throw new PrepareError(`cannot run "${source}" — expected a .cpp or a .py`);
}

async function judgeFor(problem: PreparedProblem, workDir: string): Promise<Judge> {
  if (problem.checkerSourcePath === null) return standardJudge();
  const testlib = findTestlib(problem.dir);
  const binary = join(workDir, 'stress-checker');
  const built = await compile(problem.checkerSourcePath, binary, testlib === null ? [] : [testlib]);
  if (!built.ok) {
    throw new PrepareError(`the checker does not compile:\n${built.stderr.slice(0, 4000)}`);
  }
  return sourceJudge(binary);
}

export async function runStress(
  problem: PreparedProblem,
  options: StressOptions,
): Promise<StressResult> {
  const modelSource = options.model ?? problem.modelPath;
  if (modelSource === null) {
    throw new PrepareError('no model solution to stress — pass --model, or give the directory a @tag main');
  }
  const rounds = options.rounds ?? 100;
  const wallMs = options.wallMs ?? problem.limits.timeMs * 2;
  const workDir = await mkdtemp(join(tmpdir(), 'duckoj-stress-'));

  try {
    const judge = await judgeFor(problem, workDir);
    const gen = await runner(options.gen, workDir, 'gen', problem.dir);
    const model = await runner(modelSource, workDir, 'model', problem.dir);
    const brute = await runner(options.brute, workDir, 'brute', problem.dir);

    const inputPath = join(workDir, 'case.in');
    const modelPath = join(workDir, 'model.out');
    const brutePath = join(workDir, 'brute.out');

    for (let seed = 1; seed <= rounds; seed++) {
      const generated = await run([...gen, String(seed)], { wallMs, memoryKb: null }, { stdoutPath: inputPath });
      if (generated.exitCode !== 0) {
        throw new PrepareError(
          `the generator failed on seed ${String(seed)}: ${(generated.stderr || generated.stdout).slice(0, 800)}`,
        );
      }

      const modelRun = await run([...model], { wallMs, memoryKb: null }, { stdinPath: inputPath, stdoutPath: modelPath });
      const bruteRun = await run([...brute], { wallMs, memoryKb: null }, { stdinPath: inputPath, stdoutPath: brutePath });
      const input = await readFile(inputPath, 'utf8');

      if (bruteRun.exitCode !== 0) {
        throw new PrepareError(
          `the brute force failed on seed ${String(seed)} — the oracle must be correct on every ` +
            `case the generator produces:\n${(bruteRun.stderr || bruteRun.stdout).slice(0, 800)}`,
        );
      }
      if (modelRun.exitCode !== 0) {
        return {
          rounds,
          ran: seed,
          counterexample: {
            seed,
            input,
            modelOutput: '',
            bruteOutput: await readFile(brutePath, 'utf8'),
            detail: modelRun.timedOut
              ? `the model solution did not finish within ${String(wallMs)} ms`
              : `the model solution exited ${String(modelRun.exitCode)}`,
          },
        };
      }

      // The brute's output is the answer key, exactly as a jury `.a` is.
      const outcome = await judge.check(inputPath, modelPath, brutePath);
      if (outcome.verdict !== 'OK') {
        return {
          rounds,
          ran: seed,
          counterexample: {
            seed,
            input,
            modelOutput: await readFile(modelPath, 'utf8'),
            bruteOutput: await readFile(brutePath, 'utf8'),
            detail: `${outcome.verdict}: ${outcome.detail}`,
          },
        };
      }
    }
    return { rounds, ran: rounds, counterexample: null };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
