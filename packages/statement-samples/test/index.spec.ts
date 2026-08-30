import { describe, expect, it } from 'vitest';
import {
  extractSamples,
  findSampleTables,
  hideDuplicateSampleTables,
  sameSamples,
} from '../src/index.js';

const STATEMENT = `# Tổng hai số

Cộng hai số.

## Ví dụ

| Dữ liệu vào | Kết quả |
| --- | --- |
| \`2 3\` | \`5\` |
| \`10 20\` | \`30\` |

## Giới hạn

- Thời gian: 1 giây.

---

## English

**Sample.**

| Input | Output |
| --- | --- |
| \`2 3\` | \`5\` |
| \`10 20\` | \`30\` |
`;

/** What the API hands over: the test FILES, newline and all. */
const STRUCTURED = [
  { input: '2 3\n', output: '5\n' },
  { input: '10 20\n', output: '30\n' },
];

describe('findSampleTables', () => {
  it('finds a table under each locale’s heading — a statement has more than one (D10)', () => {
    const tables = findSampleTables(STATEMENT);
    expect(tables).toHaveLength(2);
    expect(tables.every((t) => t.samples.length === 2)).toBe(true);
  });

  it('reads a multi-line cell back into the file it stands for', () => {
    const samples = extractSamples('| Input | Output |\n| --- | --- |\n| `3`<br>`1 2 3` | `6` |\n');
    expect(samples).toEqual([{ input: '3\n1 2 3', output: '6' }]);
  });

  it('keeps the explanation column when the table has one', () => {
    const samples = extractSamples('| Input | Output | Giải thích |\n| --- | --- | --- |\n| `1` | `2` | vì thế |\n');
    expect(samples).toEqual([{ input: '1', output: '2', note: 'vì thế' }]);
  });

  it('reads no samples out of a two-column table that is not a sample table', () => {
    expect(extractSamples('| Nhóm | Điểm |\n| --- | --- |\n| nho | 40 |\n')).toEqual([]);
  });
});

describe('sameSamples', () => {
  it('matches a trimmed table cell against the file it came from — the newline is not a difference', () => {
    expect(sameSamples(extractSamples(STATEMENT).slice(0, 2), STRUCTURED)).toBe(true);
  });

  it('refuses a table with an extra example the rendered samples do not carry', () => {
    expect(sameSamples([...STRUCTURED, { input: '1 1\n', output: '2\n' }], STRUCTURED)).toBe(false);
  });

  it('refuses a table whose explanation column would be lost by hiding it', () => {
    expect(sameSamples([{ input: '2 3', output: '5', note: 'cộng lại' }], [{ input: '2 3\n', output: '5\n' }])).toBe(
      false,
    );
  });

  it('refuses samples in a different order', () => {
    expect(sameSamples([STRUCTURED[1]!, STRUCTURED[0]!], STRUCTURED)).toBe(false);
  });
});

describe('hideDuplicateSampleTables', () => {
  it('drops every duplicate table AND the heading it was the whole body of', () => {
    const hidden = hideDuplicateSampleTables(STATEMENT, STRUCTURED);
    expect(hidden).not.toContain('| `2 3` | `5` |');
    expect(hidden).not.toContain('## Ví dụ');
    // The English table's heading was a bold line, not a heading — it stays,
    // and so does everything the statement actually says.
    expect(hidden).toContain('**Sample.**');
    expect(hidden).toContain('## Giới hạn');
    expect(hidden).toContain('Thời gian: 1 giây.');
    expect(hidden).toContain('## English');
  });

  it('keeps a heading that still has prose under it', () => {
    const statement = '## Ví dụ\n\nHai ví dụ:\n\n| Input | Output |\n| --- | --- |\n| `1` | `2` |\n';
    const hidden = hideDuplicateSampleTables(statement, [{ input: '1\n', output: '2\n' }]);
    expect(hidden).toContain('## Ví dụ');
    expect(hidden).toContain('Hai ví dụ:');
    expect(hidden).not.toContain('| `1` | `2` |');
  });

  it('leaves a table that says something the rendered samples do not', () => {
    const hidden = hideDuplicateSampleTables(STATEMENT, [{ input: '2 3\n', output: '5\n' }]);
    expect(hidden).toBe(STATEMENT);
  });

  it('changes nothing when there are no structured samples to duplicate', () => {
    expect(hideDuplicateSampleTables(STATEMENT, [])).toBe(STATEMENT);
  });
});
