/**
 * The pure line-diff behind `GET /submissions/{id}/diff` (D111). No database,
 * no clock — two strings in, unified hunks out. Kept here as a unit test
 * because the diff is server-computed so the web ships no diff library, and a
 * diff that groups its hunks wrong is a screenful of wrong for a person
 * comparing their own two attempts.
 *
 * `lineDiff(old, new)`: the FIRST argument is the earlier attempt (`against`),
 * the second is the submission being viewed (`{id}`), so a line only in the
 * new one is `added` and a line only in the old one is `removed` — the
 * direction the contract documents.
 */
import { describe, expect, it } from 'vitest';
import { lineDiff, DIFF_MAX_DP_CELLS } from '../src/submissions/line-diff.js';

describe('lineDiff', () => {
  it('reports no hunks for identical sources', () => {
    const src = 'int main() {\n  return 0;\n}\n';
    expect(lineDiff(src, src)).toEqual([]);
  });

  it('marks an added line and a removed line', () => {
    const oldSrc = 'a\nb\nc\n';
    const newSrc = 'a\nB\nc\n';
    const hunks = lineDiff(oldSrc, newSrc);
    expect(hunks).toHaveLength(1);
    const ops = hunks[0]!.lines.map((l) => `${l.op}:${l.text}`);
    // The 'b' -> 'B' change surfaces as one removed and one added, with the
    // surrounding identical lines kept as context.
    expect(ops).toContain('removed:b');
    expect(ops).toContain('added:B');
    expect(ops).toContain('context:a');
    expect(ops).toContain('context:c');
  });

  it('gives each hunk correct old/new line spans', () => {
    const oldSrc = 'a\nb\nc\n';
    const newSrc = 'a\nB\nc\n';
    const [hunk] = lineDiff(oldSrc, newSrc);
    // A trailing '\n' splits into a trailing empty line, so both sides are
    // a(1) b(2) c(3) ''(4): the hunk starts at 1 and spans all 4 lines.
    expect(hunk!.oldStart).toBe(1);
    expect(hunk!.oldLines).toBe(4);
    expect(hunk!.newStart).toBe(1);
    expect(hunk!.newLines).toBe(4);
  });

  it('splits distant changes into separate hunks', () => {
    // Two edits far apart (default context is 3): a single run of context
    // between them long enough to break the window yields two hunks.
    const lines = Array.from({ length: 30 }, (_, i) => `line${String(i)}`);
    const oldSrc = lines.join('\n');
    const changed = [...lines];
    changed[0] = 'CHANGED0';
    changed[29] = 'CHANGED29';
    const hunks = lineDiff(oldSrc, changed.join('\n'));
    expect(hunks.length).toBe(2);
  });

  it('falls back to a whole-file replace when the DP would be too large', () => {
    // Every line distinct on both sides, product over the cap: the DP is
    // skipped and the middle is emitted as all-removed then all-added — still
    // a valid unified diff, and the guard that keeps an unmetered read from
    // being an O(n*m) CPU/memory sink.
    const rows = Math.floor(Math.sqrt(DIFF_MAX_DP_CELLS)) + 50;
    const oldSrc = Array.from({ length: rows }, (_, i) => `old${String(i)}`).join('\n');
    const newSrc = Array.from({ length: rows }, (_, i) => `new${String(i)}`).join('\n');
    const hunks = lineDiff(oldSrc, newSrc);
    const ops = hunks.flatMap((h) => h.lines.map((l) => l.op));
    // No context lines survive a total replacement, and every old line is
    // removed before any new line is added.
    expect(ops).toContain('removed');
    expect(ops).toContain('added');
    expect(ops).not.toContain('context');
    const firstAdded = ops.indexOf('added');
    const lastRemoved = ops.lastIndexOf('removed');
    expect(lastRemoved).toBeLessThan(firstAdded);
  });

  it('handles a pure insertion at the end', () => {
    const oldSrc = 'a\nb\n';
    const newSrc = 'a\nb\nc\n';
    const hunks = lineDiff(oldSrc, newSrc);
    const ops = hunks.flatMap((h) => h.lines.map((l) => `${l.op}:${l.text}`));
    expect(ops).toContain('added:c');
  });
});
