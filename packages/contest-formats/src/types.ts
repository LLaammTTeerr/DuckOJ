/**
 * The input and output shapes, mirroring `fixtures/contest-goldens/` exactly.
 *
 * These types deliberately keep the fixtures' snake_case field names and their
 * slightly awkward field set (`problem_partial` beside `partial`,
 * `points_scaling_factor` that is null for three of the four formats). The
 * fixtures were frozen from what DMOJ actually produced; mirroring them is the
 * point, and "improving" the shape here would put a translation layer between
 * the goldens and the code they are supposed to pin.
 */

/** An ISO-8601 instant with an explicit offset, e.g. `2026-03-01T09:00:00Z`. */
export type Instant = string;

export interface ContestSpec {
  key: string;
  name?: string;
  /**
   * Inclusive contest window. No *format* filters by it — DuckOJ filters during
   * lowering instead, against each participation's own window, which for a
   * virtual entrant legitimately extends past `end_time` (DIV-1).
   */
  start_time: Instant;
  end_time: Instant;
  /** `null` means "no per-participant time limit", which also pins `start`. */
  time_limit_seconds: number | null;
  /** Decimal places `score` is rounded to — once, at the end. */
  points_precision: number;
  /**
   * Freeze window. Every golden pins this to 0; a non-zero value makes the
   * output depend on `timezone.now()`, so it is out of scope for this phase
   * (4a ledger, deferred-decisions table) and the formats reject it.
   */
  frozen_last_minutes: number;
}

/** A row of `ProblemTestCase`: `C`ase, batch `S`tart, batch `E`nd. */
export interface ProblemTestCaseSpec {
  type: 'C' | 'S' | 'E';
  points: number | null;
}

export interface ProblemSpec {
  code: string;
  name?: string;
  /** `ContestProblem.points`. */
  points: number;
  /** `ContestProblem.partial`. */
  partial: boolean;
  /** `Problem.partial`. Both must be true for partial scoring to apply. */
  problem_partial: boolean;
  /** The dataset. Absent means `points_scaling_factor` is not computable. */
  problem_test_cases?: ProblemTestCaseSpec[];
}

export interface ParticipantSpec {
  name: string;
  real_start: Instant;
  /** 0 = live, -1 = spectator (excluded from the ranking), n > 0 = n-th virtual. */
  virtual: number;
  is_disqualified?: boolean;
}

export interface TestCaseSpec {
  /** `null` and `0` both mean "unbatched"; they share the implicit batch 0. */
  batch: number | null;
  case: number;
  points: number;
  total: number;
  status: string;
}

export interface SubmissionSpec {
  participant: string;
  problem: string;
  date: Instant;
  /** `null` for an internal error. `CE`/`IE`/`null` are free of ICPC penalty. */
  result: string | null;
  status: string;
  cases: TestCaseSpec[];
}

/**
 * A whole contest as the goldens describe it. Fixture files carry extra
 * documentation keys (`description`, `findings`, `sensitivity`, `null_probe`);
 * they are not part of the format interface and are ignored.
 */
export interface ContestInput {
  format: string;
  format_config: Record<string, unknown> | null;
  contest: ContestSpec;
  problems: ProblemSpec[];
  participants: ParticipantSpec[];
  submissions: SubmissionSpec[];
}

/** `format_data[problemCode]` for `default`, `ioi` and `ioi16`. */
export interface FormatData {
  points: number;
  time: number;
}

/** `format_data[problemCode]` for `icpc`, which also tracks tries and freezing. */
export interface IcpcFormatData extends FormatData {
  frozen_points: number;
  tries: number;
  frozen_tries: number;
  is_frozen: boolean;
}

export interface RankingRow {
  rank: number;
  participant: string;
  virtual: number;
  is_disqualified: boolean;
  score: number;
  cumtime: number;
  tiebreaker: number;
  frozen_score: number;
  frozen_cumtime: number;
  frozen_tiebreaker: number;
  submission_count: number;
  format_data: Record<string, FormatData | IcpcFormatData>;
}

export interface ScoreboardProblem {
  code: string;
  label: string;
  points: number;
  points_scaling_factor: number | null;
  total_ac: number;
  /** The participant name, or null. Virtual participations never count. */
  first_solve: string | null;
}

export interface Scoreboard {
  label_by_problem: Record<string, string>;
  problems: ScoreboardProblem[];
  ranking: RankingRow[];
}

/** A contest format: a pure function from the input shape to the output shape. */
export type ContestFormat = (
  input: ContestInput,
  semantics?: 'duckoj' | 'dmojCompat',
) => Scoreboard;
