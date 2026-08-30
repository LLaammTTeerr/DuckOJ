/**
 * The samples extractor, against the real statement of `tong-hai-so` and the
 * shapes the other seeded problems use.
 *
 * The failure that matters here is not "found nothing" — that is the designed
 * answer for an unknown shape — it is "found something wrong", because a
 * wrong sample sends an agent hunting a bug in a correct program.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractSamples } from '../src/samples.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

describe('extractSamples', () => {
  it('reads the two samples out of the real tong-hai-so statement', async () => {
    const statement = await readFile(`${repoRoot}content/problems/tong-hai-so/statement.md`, 'utf8');
    expect(extractSamples(statement)).toEqual([
      { input: '2 3', output: '5' },
      { input: '-7 4', output: '-3' },
    ]);
  });

  it('turns <br> into the newlines of a multi-line sample, and keeps the note', async () => {
    const statement = await readFile(`${repoRoot}content/problems/day-con-tang/statement.md`, 'utf8');
    const samples = extractSamples(statement);
    expect(samples[0]!.input).toBe('6\n1 3 2 5 4 6');
    expect(samples[0]!.output).toBe('4');
    expect(samples[0]!.note).toContain('1, 3, 5, 6');
  });

  it('returns nothing rather than a guess for a statement with no sample table', () => {
    expect(extractSamples('# A problem\n\nSome prose and $a + b$.\n')).toEqual([]);
  });

  it('ignores a table that is not a sample table', () => {
    const statement = [
      '| Nhóm | Điểm |',
      '| --- | --- |',
      '| `nho` | 40 |',
      '| `lon` | 60 |',
    ].join('\n');
    expect(extractSamples(statement)).toEqual([]);
  });

  it('reads an English sample table too', () => {
    const statement = ['| Input | Output |', '| --- | --- |', '| `1 2` | `3` |'].join('\n');
    expect(extractSamples(statement)).toEqual([{ input: '1 2', output: '3' }]);
  });

  it('needs the separator row — a header alone is not a table', () => {
    expect(extractSamples('| Dữ liệu vào | Kết quả |\n| `2 3` | `5` |')).toEqual([]);
  });
});
