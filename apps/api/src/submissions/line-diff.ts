/**
 * A plain LCS line diff, server-computed so the web ships no diff library
 * (D111).
 *
 * `@duckoj/similarity` was considered and does not fit: it fingerprints
 * k-grams to answer "how alike are these two files", winnowing away exactly
 * the line-level alignment a diff needs. That package answers a different
 * question (chống gian lận, D77); a diff of a person's own two attempts wants
 * which LINES moved, so this is its own small, pure function.
 *
 * The direction is fixed and documented: `oldText` is the earlier attempt
 * (`against`), `newText` is the submission being viewed (`{id}`). A line only
 * in `newText` is `added`; a line only in `oldText` is `removed`.
 */

/** One line of a hunk. */
export type DiffOp = 'context' | 'added' | 'removed';

export interface DiffLine {
  op: DiffOp;
  text: string;
}

/**
 * A unified-diff hunk. `oldStart`/`newStart` are 1-based line numbers; a side
 * with no lines in the hunk (a pure insertion or deletion at a file edge)
 * reports `0`/`0`, matching `@@ -0,0 @@` in a textual unified diff.
 */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/** Context lines kept on each side of a change. */
const DEFAULT_CONTEXT = 3;

/**
 * The DP cap. A submission is ≤64 KiB (`CreateSubmissionRequest.source`), so
 * a file of 32 000 one-character lines is legal, and `GET /diff` is an
 * UNMETERED read — only `POST /submissions` goes through D80. Two such files
 * would be a 10⁹-cell DP per request: an authenticated CPU/memory sink. Above
 * this cap the middle is emitted as a whole-file replace instead, the same
 * shape of guard the similarity run uses (`similarity_too_large`, D77). 4M
 * cells is ~16 MiB of `Uint32Array` and completes in well under the time a
 * genuine edit ever needs.
 */
export const DIFF_MAX_DP_CELLS = 4_000_000;

interface RawOp {
  op: DiffOp;
  text: string;
}

/** LCS over two line arrays, backtracked into an op sequence. */
function lcsOps(a: readonly string[], b: readonly string[]): RawOp[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:]. Filled from the end so the
  // forward backtrack below is greedy and stable (removals before additions
  // when the two paths tie, which reads as "the old line went, a new one
  // came").
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: RawOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: 'context', text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ op: 'removed', text: a[i]! });
      i += 1;
    } else {
      ops.push({ op: 'added', text: b[j]! });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ op: 'removed', text: a[i]! });
    i += 1;
  }
  while (j < m) {
    ops.push({ op: 'added', text: b[j]! });
    j += 1;
  }
  return ops;
}

/** The full op sequence, with a common prefix/suffix trimmed off first. */
function buildOps(oldLines: readonly string[], newLines: readonly string[]): RawOp[] {
  const n = oldLines.length;
  const m = newLines.length;

  // Trim the common prefix and suffix as context: the normal case (a few
  // edited lines in an otherwise-unchanged file) collapses the DP to almost
  // nothing, and the cap below then only bites on files that really are
  // wholesale different.
  let lo = 0;
  while (lo < n && lo < m && oldLines[lo] === newLines[lo]) lo += 1;
  let hiOld = n;
  let hiNew = m;
  while (hiOld > lo && hiNew > lo && oldLines[hiOld - 1] === newLines[hiNew - 1]) {
    hiOld -= 1;
    hiNew -= 1;
  }

  const ops: RawOp[] = [];
  for (let i = 0; i < lo; i += 1) ops.push({ op: 'context', text: oldLines[i]! });

  const midOld = oldLines.slice(lo, hiOld);
  const midNew = newLines.slice(lo, hiNew);
  if (midOld.length > 0 || midNew.length > 0) {
    if (midOld.length * midNew.length > DIFF_MAX_DP_CELLS) {
      for (const text of midOld) ops.push({ op: 'removed', text });
      for (const text of midNew) ops.push({ op: 'added', text });
    } else {
      ops.push(...lcsOps(midOld, midNew));
    }
  }

  for (let i = hiOld; i < n; i += 1) ops.push({ op: 'context', text: oldLines[i]! });
  return ops;
}

interface AnnotatedOp extends RawOp {
  oldNo: number;
  newNo: number;
}

/** Groups a flat op sequence into hunks, keeping `context` lines around each change. */
function toHunks(ops: readonly RawOp[], context: number): DiffHunk[] {
  let oldNo = 0;
  let newNo = 0;
  const ann: AnnotatedOp[] = ops.map((o) => {
    if (o.op === 'context') {
      oldNo += 1;
      newNo += 1;
      return { ...o, oldNo, newNo };
    }
    if (o.op === 'removed') {
      oldNo += 1;
      return { ...o, oldNo, newNo: 0 };
    }
    newNo += 1;
    return { ...o, oldNo: 0, newNo };
  });

  const keep = new Array<boolean>(ann.length).fill(false);
  let anyChange = false;
  for (let i = 0; i < ann.length; i += 1) {
    if (ann[i]!.op === 'context') continue;
    anyChange = true;
    const from = Math.max(0, i - context);
    const to = Math.min(ann.length - 1, i + context);
    for (let k = from; k <= to; k += 1) keep[k] = true;
  }
  if (!anyChange) return [];

  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < ann.length) {
    if (!keep[i]) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < ann.length && keep[j]) j += 1;
    const slice = ann.slice(i, j);
    const oldNos = slice.filter((s) => s.op !== 'added').map((s) => s.oldNo);
    const newNos = slice.filter((s) => s.op !== 'removed').map((s) => s.newNo);
    hunks.push({
      oldStart: oldNos.length > 0 ? oldNos[0]! : 0,
      oldLines: oldNos.length,
      newStart: newNos.length > 0 ? newNos[0]! : 0,
      newLines: newNos.length,
      lines: slice.map((s) => ({ op: s.op, text: s.text })),
    });
    i = j;
  }
  return hunks;
}

/**
 * Two sources → the unified hunks between them. Identical sources produce
 * `[]` (no hunks), not one all-context hunk: "nothing changed" is a shorter
 * true thing to say than "here is the whole file, unchanged".
 *
 * Lines are split on `\n`; a trailing newline yields a trailing empty line on
 * both sides, which cancels as context and never shows up as a spurious edit.
 */
export function lineDiff(oldText: string, newText: string, context = DEFAULT_CONTEXT): DiffHunk[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  return toHunks(buildOps(oldLines, newLines), context);
}
