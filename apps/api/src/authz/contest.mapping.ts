import type { ContestInput, ProblemSpec, SubmissionSpec, TestCaseSpec } from '@duckoj/contest-formats';
import { AppError } from '../common/app.error.js';

/**
 * Database rows in, `ContestInput` out.
 *
 * This is the whole risk of Phase 4c. 4b's formats are pure and proved right
 * against 23 goldens *given correct input*; this file is what produces that
 * input, and `apps/api/test/contest-golden-replay.spec.ts` reuses the same 23
 * goldens to prove it does. If 4b is green and the replay is red, the bug is
 * here, every time.
 *
 * Deliberately pure and free of the database: the service queries, this maps.
 * A mapping that could issue its own query would eventually issue one that
 * disagrees with the service's ordering, and ordering is load-bearing below.
 */

export interface ContestRow {
  key: string;
  name: string;
  startTime: Date;
  endTime: Date;
  format: string;
  formatConfig: Record<string, unknown> | null;
  pointsPrecision: number;
  frozenLastMinutes: number;
  timeLimitSeconds: number | null;
}

export interface ContestProblemRow {
  code: string;
  name: string;
  /**
   * `contest_problems.points` — NOT `problem_revisions.total_points`. The two
   * are equal in most contests, which is exactly what makes confusing them
   * dangerous: only `ioi16/10-points-scaling-factor` separates them (design
   * §7), where the contest problem is worth 200 against a 100-point dataset.
   */
  points: number;
  partial: boolean;
  /**
   * `total_points` of the problem's **published** revision, or `null` when it
   * has none. This is the denominator of `points_scaling_factor`.
   */
  datasetTotalPoints: number | null;
}

export interface ParticipationRow {
  id: number;
  username: string;
  startTime: Date;
  virtual: number;
  isDisqualified: boolean;
}

export interface ContestCaseRow {
  groupIndex: number;
  caseIndex: number;
  points: number;
  maxPoints: number;
  verdict: string | null;
}

export interface ContestSubmissionRow {
  participationId: number;
  problemCode: string;
  date: Date;
  /** `submissions.verdict`; `null` for an internal error that never got one. */
  verdict: string | null;
  state: string;
  /** Every case of this submission's **latest attempt**, in insertion order. */
  cases: ContestCaseRow[];
}

export interface ContestRows {
  contest: ContestRow;
  /** In `contest_problems.order`, then id — the order labels are assigned in. */
  problems: ContestProblemRow[];
  /** In `contest_participations.id`. */
  participations: ParticipationRow[];
  /** In `contest_submissions.id` — see `mapContest`'s note on ordering. */
  submissions: ContestSubmissionRow[];
}

/**
 * `submissions.state` -> DMOJ's `Submission.status` letter.
 *
 * Nothing in any of the four formats reads `status` — `result` is what
 * `icpc`'s penalty rule keys on — so this exists to fill a required field of
 * the fixture shape faithfully rather than to drive behaviour. Mapping it to a
 * constant would be shorter and would also be a lie the moment a format starts
 * reading it.
 */
const STATUS_BY_STATE: Readonly<Record<string, string>> = Object.freeze({
  queued: 'QU',
  compiling: 'P',
  grading: 'G',
  done: 'D',
  errored: 'IE',
});

/**
 * The dataset, as `pointsScalingFactor` needs to see it.
 *
 * DMOJ divides `ContestProblem.points` by the sum of the dataset's *batch*
 * points, walked from `ProblemTestCase` rows — a batch start carries its
 * batch's points, a loose case carries its own. DuckOJ has no such table: a
 * package manifest carries per-test points and a group index, and
 * `renderInitYml` gives a batch `points = sum of its member tests' points`.
 * So the sum DMOJ divides by is, exactly, the sum of our tests' points — which
 * `problem_revisions.total_points` already denormalises.
 *
 * Hence one synthetic loose case carrying that total: `pointsScalingFactor` is
 * the only consumer of `problem_test_cases`, it only ever sums, and this sums
 * to the same number the real rows would. Reading the package manifest off the
 * store on every scoreboard read would produce the identical factor at the
 * cost of an I/O per problem.
 *
 * A problem with no published revision has no dataset at all, and the goldens
 * pin that case too: `points_scaling_factor` is `null` for every problem the
 * generator gave no `ProblemTestCase` rows (all of `default`/`icpc`, and two
 * of the four `legacy_ioi` scenarios). Returning `undefined` here is what
 * reproduces it — and it is per problem, never per format:
 * `legacy_ioi/09-best-submission-not-best-batch` carries a dataset while its
 * siblings do not.
 */
function datasetOf(problem: ContestProblemRow): ProblemSpec['problem_test_cases'] {
  if (problem.datasetTotalPoints === null) return undefined;
  return [{ type: 'C', points: problem.datasetTotalPoints }];
}

function mapCases(cases: ContestCaseRow[]): TestCaseSpec[] {
  return cases.map((row) => ({
    // `submission_cases.group_index` is `0` for an ungrouped case where DMOJ
    // writes `NULL`. Both formats that look at a batch treat `null` and `0`
    // identically (`batch ?? 0`, and `batch === null || batch === 0` is
    // loose), so `0` is the faithful spelling of both.
    batch: row.groupIndex,
    case: row.caseIndex,
    points: row.points,
    total: row.maxPoints,
    status: row.verdict ?? 'IE',
  }));
}

/**
 * Order is load-bearing in three places and is the caller's responsibility:
 *
 * - `contest_problems.order` decides which problem gets label `A`/`1`.
 * - `contest_submissions.id` decides `groupByProblem`'s first-seen order,
 *   which `ioi16` sums in — and IEEE addition is not associative.
 * - `submission_cases.id` decides the order loose cases are summed in.
 *
 * The service's queries sort on exactly those columns.
 */
export function mapContest(rows: ContestRows): ContestInput {
  const { contest } = rows;

  const byParticipation = new Map(rows.participations.map((p) => [p.id, p]));

  const problems: ProblemSpec[] = rows.problems.map((problem) => {
    const dataset = datasetOf(problem);
    return {
      code: problem.code,
      name: problem.name,
      points: problem.points,
      partial: problem.partial,
      // `Problem.partial` upstream — a per-problem switch DuckOJ does not
      // have. The effective flag the formats use is `partial &&
      // problem_partial`, so a constant `true` leaves `contest_problems
      // .partial` as the only gate, which is precisely what design §3's table
      // describes. No golden can tell the difference: all eight fixtures
      // carrying `problem_partial: false` carry `partial: false` too.
      problem_partial: true,
      // Spread, not `problem_test_cases: dataset`: under
      // `exactOptionalPropertyTypes` an explicit `undefined` is not the same
      // as an absent key, and `pointsScalingFactor` keys on absence.
      ...(dataset === undefined ? {} : { problem_test_cases: dataset }),
    };
  });

  const submissions: SubmissionSpec[] = rows.submissions.map((row) => {
    const participation = byParticipation.get(row.participationId);
    if (participation === undefined) {
      throw new AppError(
        500,
        'contest_orphan_submission',
        'a contest submission referenced a participation that is not in this contest',
      );
    }
    return {
      participant: participation.username,
      // The identity, alongside the name (D36). One person may hold a live
      // participation and any number of virtual attempts in one contest —
      // `join` is built to produce exactly that — and the name alone would
      // merge their submissions into whichever row lowered last.
      participation_id: participation.id,
      problem: row.problemCode,
      date: row.date.toISOString(),
      result: row.verdict,
      status: STATUS_BY_STATE[row.state] ?? 'D',
      cases: mapCases(row.cases),
    };
  });

  return {
    format: contest.format,
    format_config: contest.formatConfig,
    problems,
    contest: {
      key: contest.key,
      name: contest.name,
      start_time: contest.startTime.toISOString(),
      end_time: contest.endTime.toISOString(),
      time_limit_seconds: contest.timeLimitSeconds,
      points_precision: contest.pointsPrecision,
      frozen_last_minutes: contest.frozenLastMinutes,
    },
    participants: rows.participations.map((participation) => ({
      name: participation.username,
      participation_id: participation.id,
      real_start: participation.startTime.toISOString(),
      virtual: participation.virtual,
      is_disqualified: participation.isDisqualified,
    })),
    submissions,
  };
}
