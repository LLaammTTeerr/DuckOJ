/**
 * The one shape both input layouts are normalised into.
 *
 * `packages/prepare` accepts two directory layouts — a Polygon "full" package
 * (`problem.xml`, what `content/problems/*` and `@duckoj/polygon-import`
 * already speak) and the competitive-programming skills' own output
 * (`problem.json`, `files/`, `solutions/`, `tests/<subtask>/`, `flags.json`).
 * Every check below `load.ts` is written against `PreparedProblem` alone, so
 * adding a third layout is a loader, not a second gate.
 */
import type { PackageManifestDto } from '@duckoj/package-format';

export type Layout = 'polygon' | 'skills';

/** The verdicts this gate can produce locally. */
export const VERDICTS = ['OK', 'WA', 'TL', 'ML', 'PE', 'RE', 'FAIL'] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * Worst-first, the same order `tools/matrix_core.py` collapses a group with.
 * `FAIL` is a package bug and must never be masked by a solution's own
 * failure; `TL` outranks `WA` because a judge stops the run before the
 * checker ever sees the output.
 */
export const VERDICT_SEVERITY: Verdict[] = ['FAIL', 'TL', 'ML', 'RE', 'PE', 'WA', 'OK'];

export interface PreparedTest {
  /** Stable, human-readable id: `03` for Polygon, `g1/01` for the skills. */
  id: string;
  /** Absolute path to the input on disk. */
  inputPath: string;
  /** Absolute path to the jury answer on disk. */
  answerPath: string;
  points: number;
  /** 0 means ungrouped — every case stands alone (see `renderInitYml`). */
  group: number;
  /** The setter's own name for the group; `''` when ungrouped. */
  groupName: string;
  /** Where this test lands inside the built package. */
  packageInput: string;
  packageAnswer: string;
}

export interface PreparedSolution {
  /** Basename, which is what an expected-verdict matrix keys on. */
  file: string;
  path: string;
  /** `main`, `wrong-answer`, `time-limit-exceeded`, … (the skills' vocabulary). */
  tag: string;
  /** group name -> expected verdict. Empty when the source declares none. */
  expect: Record<string, Verdict>;
}

export interface PreparedStatement {
  path: string;
  text: string;
  /** Whether an English section was found (D10 wants vi **and** en). */
  hasEnglish: boolean;
}

export interface FlagRecord {
  id: string;
  phase?: string;
  severity?: string;
  kind?: string;
  what?: string;
  resolved?: boolean;
}

export interface PreparedProblem {
  layout: Layout;
  /** Absolute path of the prepared directory. */
  dir: string;
  /** DuckOJ problem code — the directory name unless overridden. */
  code: string;
  name: string;
  /**
   * `null` when the directory carries no publishable Markdown statement —
   * a gate FAILURE reported by the `statement` check, not a load error, so
   * everything else about the directory is still checked and reported.
   */
  statement: PreparedStatement | null;
  /** Why `statement` is what it is, in one line, for the report. */
  statementDetail: string;
  /** Absolute path to `editorial.md`, when the directory carries one. */
  editorialPath: string | null;
  limits: { timeMs: number; memoryKb: number };
  /** Absolute path of the checker source, when the manifest names one. */
  checkerSourcePath: string | null;
  /** Absolute path of `files/validator.cpp`, when the layout has one. */
  validatorPath: string | null;
  /** The `@tag main` solution. Absent is a gate failure, not a load error. */
  modelPath: string | null;
  solutions: PreparedSolution[];
  tests: PreparedTest[];
  tags: string[];
  difficulty: number | null;
  flags: FlagRecord[];
  /** Ready for `buildPackage` once `copies` have been executed. */
  manifest: PackageManifestDto;
  /** Absolute source path -> package-relative destination. */
  copies: Array<{ from: string; to: string }>;
}

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface PrepareCheck {
  id: string;
  status: CheckStatus;
  detail: string;
  /** Free-form evidence — timings, per-test verdicts, missing paths. */
  data?: unknown;
}

export interface PrepareReport {
  schemaVersion: 1;
  generatedAt: string;
  dir: string;
  layout: Layout;
  code: string;
  name: string;
  ok: boolean;
  checks: PrepareCheck[];
}

/** Collapse a group's per-test verdicts the way a judge would report it. */
export function groupVerdict(perTest: Verdict[]): Verdict {
  for (const verdict of VERDICT_SEVERITY) {
    if (perTest.includes(verdict)) return verdict;
  }
  // Unreachable while `perTest` holds only `Verdict`s, and cheaper than a
  // throw that every caller would have to prove impossible.
  return 'OK';
}

/**
 * Whether a locally observed verdict satisfies a declared expectation.
 *
 * Exact, with ONE deliberate widening: this gate runs solutions under
 * `ulimit -v`, and a C++ program that hits an address-space limit dies as an
 * abort or a bad_alloc — indistinguishable, from outside, from any other
 * non-zero exit. So `ML` is satisfied by `RE` too. The alternative is to
 * report a wrong-solution matrix as failing for a solution that failed
 * exactly as its author said it would, on a distinction this runner
 * provably cannot make.
 */
export function verdictSatisfies(expected: Verdict, actual: Verdict): boolean {
  if (expected === actual) return true;
  return expected === 'ML' && actual === 'RE';
}
