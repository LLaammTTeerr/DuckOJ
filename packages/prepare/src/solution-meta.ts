/**
 * The `/** @tag … @expect … *\/` header the `validating-solutions` skill puts
 * at the top of every solution in the zoo.
 *
 * A port of `tools/scan_solutions.py`'s `parse_block`, with one deliberate
 * difference: absence is not an error here. The skills' pipeline requires the
 * block on every file it scans; this gate also reads Polygon directories,
 * where a `<solution tag="main">` carries no header at all, so a file without
 * one loads with an empty `expect` and the matrix check simply skips it.
 */
import type { Verdict } from './model.js';

/** Every `/** … *\/` block, non-greedy so an unterminated one matches nothing. */
const BLOCK = /\/\*\*([\s\S]*?)\*\//g;
const FIELD = /^\s*\*?\s*@([a-z-]+)\s+(.+?)\s*$/;

const DECLARABLE: Record<string, Verdict> = {
  OK: 'OK',
  WA: 'WA',
  TL: 'TL',
  ML: 'ML',
  PE: 'PE',
  RE: 'RE',
};

export interface SolutionMeta {
  tag: string | null;
  expect: Record<string, Verdict>;
  /** Anything malformed, so the gate can report it instead of ignoring it. */
  problems: string[];
}

function fieldsIn(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of body.split('\n')) {
    const match = FIELD.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) fields.set(match[1], match[2]);
  }
  return fields;
}

export function parseSolutionMeta(source: string): SolutionMeta {
  const blocks: Array<Map<string, string>> = [];
  for (const match of source.matchAll(BLOCK)) {
    if (match[1] !== undefined) blocks.push(fieldsIn(match[1]));
  }
  // The block carrying the metadata is the first with `@tag`; a licence
  // header above it must not abort the scan (the same bug `scan_solutions.py`
  // records having fixed).
  const fields = blocks.find((f) => f.has('tag')) ?? blocks.find((f) => f.size > 0);
  if (fields === undefined) return { tag: null, expect: {}, problems: [] };

  const problems: string[] = [];
  const expect: Record<string, Verdict> = {};
  const raw = fields.get('expect');
  if (raw !== undefined) {
    for (const token of raw.split(/\s+/).filter((t) => t.length > 0)) {
      const at = token.indexOf('=');
      if (at < 0) {
        problems.push(`malformed @expect entry "${token}", want group=VERDICT`);
        continue;
      }
      const group = token.slice(0, at);
      const verdict = DECLARABLE[token.slice(at + 1)];
      if (verdict === undefined) {
        problems.push(`unknown verdict in @expect entry "${token}"`);
        continue;
      }
      expect[group] = verdict;
    }
  }

  return { tag: fields.get('tag') ?? null, expect, problems };
}
