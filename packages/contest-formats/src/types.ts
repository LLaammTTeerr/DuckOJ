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
   * Freeze window, in minutes before the end. Every golden pins this to 0; a
   * non-zero value makes the output depend on the clock, which is why `lower()`
   * takes `now` explicitly and never reads it (D22).
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
  /**
   * DuckOJ's own addition (D36), absent from every golden: the identity a
   * submission is attached to, when `name` is not one.
   *
   * The fixture shape keys a submission on the participant's **name**, which
   * is only an identity while a person holds at most one participation. The
   * product's `join` makes that false routinely — a live entrant may replay
   * the contest virtually, and a virtual join is deliberately not idempotent
   * — so one name can address two rows. Where this is set it, not the name,
   * is what `lower()` matches on; the name stays what the ranking row and
   * `first_solve` print.
   *
   * Absent throughout `fixtures/contest-goldens/`, so every golden lowers by
   * name exactly as before and stays byte-identical.
   */
  participation_id?: number;
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
  /**
   * The participation this submission counts toward, when the participant's
   * name does not identify one (D36). Set it on both sides or neither: a
   * submission carrying an id matches only a participant carrying the same
   * one, and a submission without one matches only by name.
   */
  participation_id?: number;
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
  /**
   * Problem code → attempts the freeze is hiding from this row (D22).
   * **Present on every row iff the board is frozen**, and absent otherwise —
   * a golden must stay byte-identical, and an always-present empty map would
   * change all 23 of them.
   */
  pending?: Record<string, number>;
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
  /**
   * Whether this board hides anything — at least one ranked row is inside its
   * own freeze window at the `now` the caller supplied (D22).
   *
   * `frozen`/`frozenAt` are camelCase where everything around them is
   * snake_case: the snake_case fields are the goldens' own shape, frozen from
   * DMOJ, and these two are DuckOJ's own additions. The goldens compare
   * `ranking`, `problems` and `label_by_problem` only, so adding them here
   * costs no fixture.
   */
  frozen: boolean;
  /** `end_time − F·60s` whenever `F > 0`, whatever the clock says; else null. */
  frozenAt: Instant | null;
}

/** A contest format: a pure function from the input shape to the output shape. */
export type ContestFormat = (
  input: ContestInput,
  semantics?: 'duckoj' | 'dmojCompat',
  /** The clock the freeze window is judged against; omitted means "no freeze". */
  now?: Instant,
) => Scoreboard;
