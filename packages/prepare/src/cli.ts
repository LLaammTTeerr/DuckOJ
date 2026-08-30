#!/usr/bin/env node
/**
 * The CLI. The ONLY file in this package that prints or chooses an exit code —
 * everything it does is a call into the library, so `apps/mcp` can do the same
 * things without a subprocess.
 *
 * Exit codes: 0 ready, 1 the gate found something, 2 the directory or the
 * request was refused outright (nothing to report on).
 */
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrepareError } from './errors.js';
import { loadProblem } from './load.js';
import { packageProblem } from './package.js';
import { publishProblem } from './publish.js';
import { runStress } from './stress.js';
import { formatReport, validateProblem } from './validate.js';

const USAGE = `usage: prepare <command> <problem-dir> [options]

  check <dir>       run the gate and write prepare-report.json (the default)
    --quick           structural checks only: compile and run nothing
    --report <path>   where to write the report (default <dir>/prepare-report.json)
    --json            print the report as JSON instead of a summary
    --code <code>     the DuckOJ problem code (default: the directory's name)

  package <dir> --out <package-dir> [--archive <file.tar.zst>]
                    build the DuckOJ package and print its hash

  publish <dir>     gate, package, then create/patch/upload/attach
    --base-url <url>  API root (or DUCKOJ_API), e.g. http://localhost:8080/api/v1
    --token <token>   personal access token (or DUCKOJ_TOKEN)
    --publish         publish the revision this run attaches
    --visibility <v>  private | org | public
    --notes <text>    revision notes
    --no-gate         publish without running the gate first (not advised)
    --no-editorial    do not send editorial.md at all (it is stored, and
                      published only alongside --publish)

  stress <dir> --brute <file> --gen <file> [--rounds N] [--model <file>]
                    <gen> <seed> writes ONE case to stdout; the brute is the oracle
`;

interface Args {
  command: string;
  dir: string;
  flags: Map<string, string>;
  booleans: Set<string>;
}

const BOOLEAN_FLAGS = new Set([
  'quick',
  'json',
  'publish',
  'no-gate',
  'no-editorial',
  'help',
]);

const COMMANDS = new Set(['check', 'package', 'publish', 'stress']);

export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      booleans.add(name);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined) throw new PrepareError(`--${name} needs a value`);
    flags.set(name, next);
    i++;
  }

  // `prepare <dir>` with no verb means `check`, which is what a setter types.
  const first = positional[0];
  const command = first !== undefined && COMMANDS.has(first) ? first : 'check';
  const dir = (command === first ? positional[1] : first) ?? '';
  return { command, dir, flags, booleans };
}

function required(args: Args, name: string, env?: string): string {
  const value = args.flags.get(name) ?? (env === undefined ? undefined : process.env[env]);
  if (value === undefined || value === '') {
    throw new PrepareError(`--${name}${env === undefined ? '' : ` (or ${env})`} is required`);
  }
  return value;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.booleans.has('help') || args.dir === '') {
    process.stdout.write(USAGE);
    return args.booleans.has('help') ? 0 : 2;
  }

  const codeOption = args.flags.get('code');
  const problem = await loadProblem(args.dir, codeOption === undefined ? {} : { code: codeOption });

  if (args.command === 'stress') {
    const roundsRaw = args.flags.get('rounds');
    const rounds = roundsRaw === undefined ? undefined : Number(roundsRaw);
    if (rounds !== undefined && (!Number.isInteger(rounds) || rounds < 1)) {
      throw new PrepareError(`--rounds must be a positive integer, got "${roundsRaw ?? ''}"`);
    }
    const model = args.flags.get('model');
    const result = await runStress(problem, {
      brute: required(args, 'brute'),
      gen: required(args, 'gen'),
      ...(rounds === undefined ? {} : { rounds }),
      ...(model === undefined ? {} : { model }),
    });
    if (result.counterexample === null) {
      process.stdout.write(`no counterexample in ${String(result.rounds)} round(s)\n`);
      return 0;
    }
    const found = result.counterexample;
    process.stdout.write(
      `counterexample on seed ${String(found.seed)} (round ${String(result.ran)}): ${found.detail}\n` +
        `--- input ---\n${found.input}` +
        `--- model ---\n${found.modelOutput}` +
        `--- brute ---\n${found.bruteOutput}`,
    );
    return 1;
  }

  if (args.command === 'package') {
    const built = await packageProblem(problem, required(args, 'out'));
    const archive = args.flags.get('archive');
    if (archive !== undefined) await writeFile(archive, built.archive);
    process.stdout.write(
      JSON.stringify(
        { hash: built.hash, files: built.files.length, bytes: built.archive.length, dir: built.dir },
        null,
        2,
      ) + '\n',
    );
    return 0;
  }

  const gate = args.command === 'publish' && args.booleans.has('no-gate');
  if (!gate) {
    const report = await validateProblem(problem, { quick: args.booleans.has('quick') });
    const reportPath = args.flags.get('report') ?? join(problem.dir, 'prepare-report.json');
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    if (args.booleans.has('json')) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      process.stdout.write(`${formatReport(report)}\nreport: ${reportPath}\n`);
    }
    if (!report.ok) return 1;
  }

  if (args.command !== 'publish') return 0;

  const out = args.flags.get('out') ?? join(tmpdir(), `duckoj-pkg-${problem.code}`);
  const built = await packageProblem(problem, out);
  process.stdout.write(`package ${built.hash} (${String(built.archive.length)} bytes)\n`);

  const visibility = args.flags.get('visibility');
  if (visibility !== undefined && !['private', 'org', 'public'].includes(visibility)) {
    throw new PrepareError(`--visibility must be private, org or public, got "${visibility}"`);
  }
  const notes = args.flags.get('notes');
  const result = await publishProblem(problem, built.archive, built.hash, {
    baseUrl: required(args, 'base-url', 'DUCKOJ_API'),
    token: required(args, 'token', 'DUCKOJ_TOKEN'),
    publish: args.booleans.has('publish'),
    editorial: !args.booleans.has('no-editorial'),
    ...(visibility === undefined ? {} : { visibility: visibility as 'private' | 'org' | 'public' }),
    ...(notes === undefined ? {} : { notes }),
  });
  for (const step of result.steps) process.stdout.write(`  ${step}\n`);
  process.stdout.write(
    `${result.code}: revision ${String(result.version)}` +
      `${result.revisionCreated ? ' (new)' : ' (unchanged package, nothing attached)'}` +
      `${result.published ? ', published' : ''}\n`,
  );
  return 0;
}

export async function cli(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (error) {
    if (error instanceof PrepareError) {
      process.stderr.write(`refused: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

// `import.meta.url` against argv[1] rather than a `require.main` check: this is
// ESM, and the file is both a library entry (`bin`) and an import target.
const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === `file://${invoked}`) {
  process.exitCode = await cli(process.argv.slice(2));
}
