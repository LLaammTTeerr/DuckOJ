/**
 * One argv splitter for every `oj` subcommand.
 *
 * `submit` used to split its arguments with
 * `rest.filter((a) => !a.startsWith('--'))`, which removes the flag NAMES and
 * leaves their VALUES sitting in the positional list: `oj submit --language
 * py3 abc sol.py` submitted problem `py3` from a file named `abc`, and the
 * two arguments the user actually typed were dropped on the floor. A parser
 * that knows which flags take a value is the only way the meaning of a
 * command can stop depending on where its flags were typed.
 *
 * Deliberately its own module rather than a helper inside `main.ts`: that
 * file reads `process.argv` at import, so nothing in it is reachable from a
 * test, which is exactly why the bug survived there.
 */
import { CliError } from './commands.js';

/** Options that consume the next word (or take it after `=`). */
export const VALUE_FLAGS = ['url', 'token', 'language', 'contest'] as const;

/** Options that are their own value. */
export const SWITCHES = ['watch'] as const;

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string>;
  switches: Set<string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  const switches = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);

    if ((SWITCHES as readonly string[]).includes(name)) {
      if (eq !== -1) throw new CliError(`--${name} takes no value`);
      switches.add(name);
      continue;
    }
    if (!(VALUE_FLAGS as readonly string[]).includes(name)) {
      throw new CliError(`unknown option: --${name}`);
    }

    if (eq !== -1) {
      flags[name] = arg.slice(eq + 1);
      continue;
    }
    const value = argv[i + 1];
    // A flag whose "value" is the next flag is a typo, not an empty value —
    // the same call `scripts/bootstrap-admin.ts`'s `parseArgs` makes, for the
    // same reason: silently accepting it produces a request nobody meant.
    if (value === undefined || value.startsWith('--')) {
      throw new CliError(`--${name} needs a value`);
    }
    flags[name] = value;
    i++;
  }

  return { positionals, flags, switches };
}
