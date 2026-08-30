/**
 * No source file in this package may contain a raw control byte.
 *
 * `route-fuzz.spec.ts` fuzzes routes with NUL bytes and other control
 * characters, and wrote them into its fixtures as LITERAL bytes rather than
 * as `\u0000` escapes. TypeScript is perfectly happy with that — the tests
 * passed — but git is not: a file containing a NUL is **binary**, so
 * `git diff` prints `Binary files a/… and b/… differ` and every review of
 * that file for the rest of its life sees nothing at all. A fuzz suite is
 * exactly the file a reviewer most needs to read, because a fuzz case that
 * silently stops fuzzing still passes.
 *
 * The escape and the literal produce the identical string at runtime, so
 * this costs the fuzzing nothing. It is a property of the repository rather
 * than of any one file, which is why it is asserted over the tree instead of
 * being fixed once and forgotten.
 *
 * Tab (0x09), newline (0x0A) and carriage return (0x0D) are ordinary text and
 * are allowed. Everything else below 0x20, and 0x7F, is not.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIRS = ['src', 'test'];
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await sourceFiles(full)));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      found.push(full);
    }
  }
  return found;
}

describe('source files are text', () => {
  it('contains no raw control byte that would make git call a source file binary', async () => {
    const offenders: string[] = [];
    for (const dir of DIRS) {
      for (const file of await sourceFiles(join(ROOT, dir))) {
        const bytes = await readFile(file);
        for (const [index, byte] of bytes.entries()) {
          if ((byte < 0x20 && !ALLOWED.has(byte)) || byte === 0x7f) {
            const line = bytes.subarray(0, index).toString('utf8').split('\n').length;
            offenders.push(
              `${file.slice(ROOT.length)}:${line} holds 0x${byte.toString(16).padStart(2, '0')} — write it as an escape (\\u00${byte.toString(16).padStart(2, '0')})`,
            );
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
