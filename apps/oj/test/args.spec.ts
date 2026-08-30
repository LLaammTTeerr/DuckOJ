import { describe, expect, it } from 'vitest';
import { CliError } from '../src/commands.js';
import { parseArgs } from '../src/args.js';

/**
 * `submit`'s arguments used to be split with
 * `rest.filter((a) => !a.startsWith('--'))`, which drops the flag NAMES and
 * keeps their VALUES — so `oj submit --language py3 abc sol.py` submitted
 * problem `py3` from a file called `abc`, and the real arguments were
 * silently discarded. The shape of a command must not depend on where its
 * flags are typed.
 */
describe('parseArgs', () => {
  it('does not mistake a flag value for a positional, whatever the order', () => {
    const before = parseArgs(['--language', 'py3', 'abc', 'sol.py']);
    expect(before.positionals).toEqual(['abc', 'sol.py']);
    expect(before.flags['language']).toBe('py3');

    const after = parseArgs(['abc', 'sol.py', '--language', 'py3']);
    expect(after.positionals).toEqual(['abc', 'sol.py']);
    expect(after.flags['language']).toBe('py3');

    const between = parseArgs(['abc', '--contest', 'tinh-2026', 'sol.py']);
    expect(between.positionals).toEqual(['abc', 'sol.py']);
    expect(between.flags['contest']).toBe('tinh-2026');
  });

  it('reads --watch as a switch rather than eating the next word', () => {
    const parsed = parseArgs(['abc', 'sol.py', '--watch']);
    expect(parsed.positionals).toEqual(['abc', 'sol.py']);
    expect(parsed.switches.has('watch')).toBe(true);

    const leading = parseArgs(['--watch', 'abc', 'sol.py']);
    expect(leading.positionals).toEqual(['abc', 'sol.py']);
    expect(leading.switches.has('watch')).toBe(true);
  });

  it('supports --flag=value as well as --flag value', () => {
    const parsed = parseArgs(['--language=py3', 'abc', 'sol.py']);
    expect(parsed.positionals).toEqual(['abc', 'sol.py']);
    expect(parsed.flags['language']).toBe('py3');
  });

  it('refuses a value flag with nothing after it rather than swallowing the next flag', () => {
    expect(() => parseArgs(['abc', 'sol.py', '--language'])).toThrow(CliError);
    expect(() => parseArgs(['abc', '--language', '--watch', 'sol.py'])).toThrow(CliError);
  });

  it('refuses an option it does not know, instead of treating it as a positional', () => {
    expect(() => parseArgs(['abc', '--langauge', 'py3'])).toThrow(/--langauge/);
  });
});
