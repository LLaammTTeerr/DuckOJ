/**
 * Deciding whether one output matches the jury answer — locally, with the
 * same two checker shapes a package can carry.
 *
 * `{"kind":"standard"}` is DMOJ's token comparison, reimplemented here rather
 * than shelled out to, because the whole point of the gate is to answer the
 * question before a judge is involved. `{"kind":"source"}` is a testlib
 * checker (D40), run with testlib's own argv and exit-code convention.
 */
import { readFile } from 'node:fs/promises';

import { run } from './toolchain.js';

export type CheckVerdict = 'OK' | 'WA' | 'PE' | 'FAIL';

export interface CheckOutcome {
  verdict: CheckVerdict;
  detail: string;
}

/**
 * testlib's exit codes (`testlib.h`'s `_ok`/`_wa`/`_pe`/`_fail`/`_points`).
 * 7 is a partial score, which a package with no partial-credit checker
 * vocabulary can only read as "accepted this test".
 */
function fromExitCode(code: number | null): CheckVerdict {
  switch (code) {
    case 0:
    case 7:
      return 'OK';
    case 1:
      return 'WA';
    case 2:
      return 'PE';
    default:
      return 'FAIL';
  }
}

export function tokens(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

export interface Judge {
  readonly kind: 'standard' | 'source';
  check(inputPath: string, outputPath: string, answerPath: string): Promise<CheckOutcome>;
}

export function standardJudge(): Judge {
  return {
    kind: 'standard',
    async check(_input, outputPath, answerPath) {
      // Neither read may throw. The gate calls this on a directory it is in
      // the middle of finding fault with — a test whose answer file is simply
      // absent is the `tests` check's finding, and the model check must
      // report FAIL beside it rather than ending the run with an ENOENT that
      // names no check at all.
      const [got, want] = await Promise.all([
        readFile(outputPath, 'utf8').catch(() => ''),
        readFile(answerPath, 'utf8').catch(() => null),
      ]);
      if (want === null) {
        return { verdict: 'FAIL', detail: `no jury answer at ${answerPath}` };
      }
      const a = tokens(got);
      const b = tokens(want);
      if (a.length !== b.length) {
        return {
          verdict: 'WA',
          detail: `token count differs: got ${String(a.length)}, expected ${String(b.length)}`,
        };
      }
      for (const [i, expected] of b.entries()) {
        if (a[i] !== expected) {
          return {
            verdict: 'WA',
            detail: `token ${String(i + 1)} differs: got "${a[i] ?? ''}", expected "${expected}"`,
          };
        }
      }
      return { verdict: 'OK', detail: `${String(b.length)} token(s) match` };
    },
  };
}

/**
 * A compiled testlib checker. `wallMs` bounds the checker itself — a checker
 * that hangs must not hang the gate — and is deliberately generous: it is the
 * setter's own program reading files already on disk.
 */
export function sourceJudge(binary: string, wallMs = 60_000): Judge {
  return {
    kind: 'source',
    async check(inputPath, outputPath, answerPath) {
      const result = await run([binary, inputPath, outputPath, answerPath], {
        wallMs,
        memoryKb: null,
      });
      if (result.timedOut) return { verdict: 'FAIL', detail: 'the checker did not finish' };
      const message = (result.stderr || result.stdout).trim().split('\n')[0] ?? '';
      return { verdict: fromExitCode(result.exitCode), detail: message };
    },
  };
}
