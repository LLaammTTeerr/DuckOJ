import { DRAFT_CHECKER_FILE_NAME, draftCaseStem } from '@duckoj/contracts';

/**
 * The client half of D87's browser authoring: pairing a pile of selected
 * files into test cases, and turning the resulting table into the exact
 * `manifest.json` + file list the draft endpoints want.
 *
 * A pure module with no React and no network in it, for the reason every
 * rule worth testing gets one: the pairing is the part a setter will actually
 * be bitten by (twelve inputs, eleven answers, and which one is missing), and
 * a rule buried in a component can only be tested through a rendered form.
 */

/** The extensions an INPUT file may carry. Polygon writes bare stems too. */
const INPUT_SUFFIX = '.in';
/**
 * The extensions an ANSWER file may carry. `.a` is Polygon's spelling and
 * `.out` is DuckOJ's own; both appear in the wild in the same directory,
 * often for the same problem, so both are accepted rather than making a
 * setter rename half their test set before this screen will look at it.
 */
const ANSWER_SUFFIXES = ['.out', '.a'] as const;

export interface SelectedFile {
  name: string;
  text: string;
}

export interface PairedCase {
  stem: string;
  input: string;
  answer: string;
}

export interface UnpairedFile {
  name: string;
  /**
   * `missing-answer` / `missing-input` — the file is half of a pair whose
   * other half was not selected. `unknown-suffix` — it is not a test file at
   * all (a `.cpp`, a `.txt`, a stray `manifest.json`).
   */
  reason: 'missing-answer' | 'missing-input' | 'unknown-suffix';
}

export interface PairingResult {
  paired: PairedCase[];
  unpaired: UnpairedFile[];
}

function suffixOf(name: string): { stem: string; kind: 'input' | 'answer'; rank: number } | null {
  if (name.endsWith(INPUT_SUFFIX)) {
    return { stem: name.slice(0, -INPUT_SUFFIX.length), kind: 'input', rank: 0 };
  }
  // The index in `ANSWER_SUFFIXES` is a PREFERENCE, not just a match: a
  // directory holding both `01.out` and `01.a` for one stem is common after
  // a Polygon import that was later re-run through our own tooling, and
  // "whichever the file picker happened to hand over last" is not an answer
  // a setter can predict. `.out` is ours, so `.out` wins.
  for (const [rank, suffix] of ANSWER_SUFFIXES.entries()) {
    if (name.endsWith(suffix)) return { stem: name.slice(0, -suffix.length), kind: 'answer', rank };
  }
  return null;
}

/**
 * Pairs selected files by stem: `01.in` with `01.out` or `01.a`.
 *
 * **Nothing is dropped silently.** A file whose partner was not selected, and
 * a file that is not a test file at all, both come back in `unpaired` with
 * the reason — because the failure this screen exists to prevent is a setter
 * selecting twelve inputs and eleven answers and publishing a problem with a
 * test case missing, which the server can only refuse much later and much
 * more confusingly. Ordering is by stem, so `01`…`12` come out in the order
 * a setter wrote them rather than in the order the file picker handed them
 * over (which is the OS's, not theirs).
 */
export function pairByStem(files: SelectedFile[]): PairingResult {
  const inputs = new Map<string, SelectedFile>();
  const answers = new Map<string, { file: SelectedFile; rank: number }>();
  const unpaired: UnpairedFile[] = [];

  for (const file of files) {
    const parsed = suffixOf(file.name);
    if (parsed === null || parsed.stem === '') {
      unpaired.push({ name: file.name, reason: 'unknown-suffix' });
      continue;
    }
    if (parsed.kind === 'input') {
      inputs.set(parsed.stem, file);
      continue;
    }
    const held = answers.get(parsed.stem);
    if (held === undefined || parsed.rank < held.rank) answers.set(parsed.stem, { file, rank: parsed.rank });
  }

  const paired: PairedCase[] = [];
  for (const [stem, input] of [...inputs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const answer = answers.get(stem);
    if (answer === undefined) {
      unpaired.push({ name: input.name, reason: 'missing-answer' });
      continue;
    }
    paired.push({ stem, input: input.text, answer: answer.file.text });
  }
  for (const [stem, answer] of answers) {
    if (!inputs.has(stem)) unpaired.push({ name: answer.file.name, reason: 'missing-input' });
  }

  return { paired, unpaired };
}

export interface CaseDraft {
  /** Stable across re-renders; never sent anywhere. */
  id: string;
  input: string;
  answer: string;
  points: number;
  /** 0 means ungrouped — the case stands alone. 1..n are batches. */
  group: number;
  /**
   * A sample is a case worth nothing (D87). The package format has no
   * `sample` flag and is not gaining one: DMOJ runs a zero-point case exactly
   * as it runs any other and awards nothing for it, which IS what a sample
   * is, and Polygon's own `samples` group arrives here as 0 points too
   * (`content/README.md`). So the flag is a UI affordance over `points: 0`,
   * not a new field in the manifest.
   */
  sample: boolean;
}

export interface CheckerDraft {
  kind: 'standard' | 'source';
  /** The testlib source, when `kind` is `source` (D40 renders it `bridged`). */
  source: string;
  /** Our language key, e.g. `cpp17`. Becomes the judge executor key. */
  language: string;
}

export interface ManifestPlan {
  manifest: unknown;
  /** Every file the draft must hold, `manifest.json` included, in PUT order. */
  files: { name: string; text: string }[];
  totalPoints: number;
}

/**
 * Re-exported, not redefined (D88).
 *
 * The server names files too now — `POST /problems/{code}/drafts/from-revision
 * /{version}` flattens a stored package into a draft — and it must choose the
 * SAME name for the same case, or a round trip renames every file it touches
 * and a re-PUT lands beside the old one instead of replacing it. So the two
 * names live in `@duckoj/contracts`, which both sides already depend on, and
 * this module's own copy of them is gone.
 */
export const CHECKER_FILE_NAME = DRAFT_CHECKER_FILE_NAME;

/**
 * Turns the table into the package a build will be run over.
 *
 * Names are generated here, not taken from whatever the setter's files were
 * called: draft file names are flat and narrowly validated server-side, and
 * a test set imported from three different directories can easily contain two
 * files named `01.in`. Numbering from the table's own order removes the whole
 * question — and makes the built package's paths identical for two setters
 * who assembled the same tests in the same order, which is what a
 * content-addressed hash is worth having.
 */
export function planPackage(input: {
  name: string;
  timeMs: number;
  memoryKb: number;
  checker: CheckerDraft;
  cases: CaseDraft[];
}): ManifestPlan {
  const files: { name: string; text: string }[] = [];
  const tests = input.cases.map((c, i) => {
    const stem = draftCaseStem(i, input.cases.length);
    files.push({ name: `${stem}.in`, text: c.input });
    files.push({ name: `${stem}.out`, text: c.answer });
    return {
      input: `${stem}.in`,
      answer: `${stem}.out`,
      points: c.sample ? 0 : c.points,
      group: c.sample ? 0 : c.group,
    };
  });

  const checker =
    input.checker.kind === 'source'
      ? { kind: 'source' as const, path: CHECKER_FILE_NAME, language: input.checker.language }
      : { kind: 'standard' as const };
  if (input.checker.kind === 'source') {
    files.push({ name: CHECKER_FILE_NAME, text: input.checker.source });
  }

  const manifest = {
    schemaVersion: 1,
    name: input.name,
    checker,
    limits: { timeMs: input.timeMs, memoryKb: input.memoryKb },
    tests,
  };

  // `manifest.json` first, so a build attempted against a half-uploaded
  // draft fails on a missing TEST — which names the file — rather than on a
  // missing manifest, which names nothing.
  return {
    manifest,
    files: [{ name: 'manifest.json', text: JSON.stringify(manifest, null, 2) }, ...files],
    totalPoints: tests.reduce((sum, t) => sum + t.points, 0),
  };
}
