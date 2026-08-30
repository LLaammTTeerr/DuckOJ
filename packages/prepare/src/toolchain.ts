/**
 * Compiling and running programs for the LOCAL gate.
 *
 * This is emphatically not the sandbox. Submissions are graded by
 * `apps/judged` inside isolate with the platform's real limits; everything
 * here runs as the setter, on the setter's machine, to answer one question
 * before anything is uploaded: does this package do what its author says it
 * does? `timeout(1)` and `ulimit -v` are exactly the right tools for that and
 * exactly the wrong ones for grading untrusted code — the difference is that
 * the code here is the setter's own.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { PrepareError } from './errors.js';

export interface RunLimits {
  /** Wall-clock milliseconds after which the process is killed. */
  wallMs: number;
  /** Address space (`ulimit -v`) in KB. `null` leaves it unbounded. */
  memoryKb: number | null;
}

export interface RunResult {
  /** `null` when the process was killed by a signal. */
  exitCode: number | null;
  signal: string | null;
  /** True when `timeout` reported that it killed the process. */
  timedOut: boolean;
  wallMs: number;
  stdout: string;
  stderr: string;
}

/** `timeout(1)` reports a killed child as 124 (and 137 with `-k`, via SIGKILL). */
const TIMEOUT_EXIT = 124;

export interface SpawnOptions {
  stdinPath?: string;
  stdoutPath?: string;
  cwd?: string;
  /** Extra bytes fed on stdin. Ignored when `stdinPath` is set. */
  input?: string;
}

/**
 * Run one command under a wall-clock and an address-space limit.
 *
 * The limits are applied by a shell rather than by Node because `ulimit` is a
 * shell builtin: there is no `spawn` option for RLIMIT_AS. `exec` replaces the
 * shell with `timeout`, so no extra process sits between the limit and the
 * program it bounds.
 */
export async function run(
  argv: string[],
  limits: RunLimits,
  options: SpawnOptions = {},
): Promise<RunResult> {
  const seconds = (limits.wallMs / 1000).toFixed(3);
  const quoted = argv.map(shellQuote).join(' ');
  const redirects = [
    options.stdinPath === undefined ? '' : `< ${shellQuote(options.stdinPath)}`,
    options.stdoutPath === undefined ? '' : `> ${shellQuote(options.stdoutPath)}`,
  ]
    .filter((r) => r !== '')
    .join(' ');
  const ulimit = limits.memoryKb === null ? '' : `ulimit -v ${String(limits.memoryKb)}; `;
  // `-k 1` follows the TERM with a KILL a second later, so a program that
  // traps SIGTERM still cannot outlive its limit.
  const script = `${ulimit}exec timeout -k 1 ${seconds} ${quoted} ${redirects}`;

  const started = process.hrtime.bigint();
  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn('bash', ['-c', script], {
      cwd: options.cwd ?? process.cwd(),
      stdio: [options.stdinPath === undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    if (options.stdinPath === undefined) {
      child.stdin?.end(options.input ?? '');
    }
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({
        exitCode: code,
        signal,
        timedOut: code === TIMEOUT_EXIT || code === 128 + 9,
        wallMs,
        stdout,
        stderr,
      });
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface CompileResult {
  ok: boolean;
  binary: string;
  stderr: string;
}

/**
 * Compile one C++ translation unit with `g++ -O2 -std=c++17`.
 *
 * `-std=c++17` is not a preference: it is the toolchain the packages this
 * repo builds declare (`cpp17`, `scripts/seed-problem.ts`'s language key, and
 * `content/README.md`'s generators), so a checker that only compiles under a
 * newer standard here would be a checker the judge cannot build.
 */
export async function compile(
  source: string,
  binary: string,
  includeDirs: string[] = [],
): Promise<CompileResult> {
  const argv = [
    'g++',
    '-O2',
    '-std=c++17',
    '-w',
    ...includeDirs.map((dir) => `-I${dir}`),
    '-o',
    binary,
    source,
  ];
  const result = await run(argv, { wallMs: 120_000, memoryKb: null });
  return { ok: result.exitCode === 0, binary, stderr: result.stderr || result.stdout };
}

/**
 * Where `testlib.h` lives, if anywhere.
 *
 * Order: an explicit `TESTLIB_DIR`, then a copy the problem directory ships
 * itself (`files/testlib.h`, which is what a package that vendors it looks
 * like), then the checkout `tools/bootstrap_testlib.sh` maintains. Nothing is
 * downloaded — a gate that reaches the network to decide whether a package is
 * ready is a gate that fails differently on every machine.
 */
export function findTestlib(problemDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.TESTLIB_DIR;
  if (explicit !== undefined && explicit !== '' && existsSync(join(explicit, 'testlib.h'))) {
    return explicit;
  }
  const vendored = join(problemDir, 'files');
  if (existsSync(join(vendored, 'testlib.h'))) return vendored;
  const cache = join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'testlib');
  if (existsSync(join(cache, 'testlib.h'))) return cache;
  return null;
}

/** The message a missing testlib gets, everywhere it is missing. */
export const NO_TESTLIB =
  'no testlib.h found — set TESTLIB_DIR, vendor files/testlib.h into the ' +
  'problem directory, or run the competitive-programming plugin\'s ' +
  'tools/bootstrap_testlib.sh to populate ~/.cache/testlib';

export function requireTestlib(problemDir: string): string {
  const dir = findTestlib(problemDir);
  if (dir === null) throw new PrepareError(NO_TESTLIB);
  return dir;
}
