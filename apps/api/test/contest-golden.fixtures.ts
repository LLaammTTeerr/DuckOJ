import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import {
  caseVerdict,
  contestParticipations,
  contestProblems,
  contestSubmissions,
  contests,
  problemRevisions,
  problems,
  submissionCases,
  submissions,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import type { ContestInput, ProblemSpec, TestCaseSpec } from '@duckoj/contest-formats';

/**
 * Turning a golden's `contest.json` into rows in a real Postgres.
 *
 * This is the other half of Phase 4c's acceptance criterion: the mapping under
 * test (`contest.mapping.ts`) reads rows and produces `ContestInput`; this
 * writes rows *from* a `ContestInput`, so the round trip through the database
 * must land back on the golden. The two are written independently and meet in
 * the middle — a shared helper would let one bug cancel the other out.
 *
 * Everything here inserts directly rather than going through the API, which is
 * deliberate and is what design §4 means by "seed participations directly":
 * joining a contest does not exist in this phase, and does not need to for the
 * mapping to be provable.
 */

export const FIXTURE_ROOT = fileURLToPath(
  new URL('../../../fixtures/contest-goldens/', import.meta.url),
);

/** Directories under the fixture root that are not scenarios. */
const NOT_A_FORMAT = new Set(['_generator']);

export interface Fixture {
  /** `<format>/<scenario>`, e.g. `ioi16/09-partial-subtasks-multiple-submissions`. */
  id: string;
  dir: string;
}

/**
 * Enumerated, never listed — the same rule 4b's harness follows. A hard-coded
 * list of 23 silently stops covering the twenty-fourth fixture someone adds.
 */
export function discoverFixtures(): Fixture[] {
  const fixtures: Fixture[] = [];
  for (const format of readdirSync(FIXTURE_ROOT, { withFileTypes: true })) {
    if (!format.isDirectory() || NOT_A_FORMAT.has(format.name)) continue;
    const formatDir = join(FIXTURE_ROOT, format.name);
    for (const scenario of readdirSync(formatDir, { withFileTypes: true })) {
      if (!scenario.isDirectory()) continue;
      fixtures.push({ id: `${format.name}/${scenario.name}`, dir: join(formatDir, scenario.name) });
    }
  }
  return fixtures.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readContest(fixture: Fixture): ContestInput {
  return readJson(join(fixture.dir, 'contest.json')) as ContestInput;
}

/**
 * The dataset's total, walked exactly as DMOJ walks `ProblemTestCase` rows: a
 * batch start carries its batch's points, a loose case carries its own, and a
 * case inside a batch carries nothing.
 *
 * This is what a DuckOJ package manifest would sum to for the same dataset —
 * `renderInitYml` gives a batch `points = sum of its member tests' points` —
 * so it is the honest value for `problem_revisions.total_points`. Returns null
 * for a problem the generator gave no dataset at all; such a problem is seeded
 * with **no published revision**, which is how "this problem has no
 * `ProblemTestCase` rows" is spelled in this schema.
 */
export function datasetTotal(problem: ProblemSpec): number | null {
  const cases = problem.problem_test_cases;
  if (cases === undefined || cases.length === 0) return null;
  let total = 0;
  let inBatch = false;
  for (const testCase of cases) {
    const points = testCase.points ?? 0;
    if (testCase.type === 'C' && !inBatch) total += points;
    if (testCase.type === 'S') {
      inBatch = true;
      total += points;
    }
    if (testCase.type === 'E') inBatch = false;
  }
  return total;
}

/** DMOJ's `Submission.status` letter -> our `submissions.state`. */
function stateOf(status: string): 'queued' | 'compiling' | 'grading' | 'done' | 'errored' {
  switch (status) {
    case 'QU':
      return 'queued';
    case 'P':
      return 'compiling';
    case 'G':
      return 'grading';
    case 'IE':
      return 'errored';
    default:
      return 'done';
  }
}

type Verdict = (typeof caseVerdict.enumValues)[number];

function verdictOf(value: string | null | undefined): Verdict | null {
  if (value === null || value === undefined) return null;
  const known = caseVerdict.enumValues as readonly string[];
  if (!known.includes(value)) {
    throw new Error(`fixture verdict "${value}" is not a member of the case_verdict enum`);
  }
  return value as Verdict;
}

export interface SeededContest {
  contestId: number;
  key: string;
}

/**
 * Seeds one golden contest — users, problems, revisions, submissions with
 * their cases, the contest, its problems, its participations and its contest
 * submissions — and returns the contest's key.
 *
 * `visibility: 'public'` so the replay can read it as an anonymous actor, which
 * puts the visibility predicate inside the replay loop rather than beside it.
 *
 * Problem codes are the golden's own (`a`, `b`, `c`). They are shorter than
 * `PROBLEM_CODE` permits over HTTP, which does not apply here: these rows are
 * inserted directly, and the code must survive to the scoreboard unchanged for
 * the comparison to mean anything.
 */
export async function seedGoldenContest(db: Db, input: ContestInput): Promise<SeededContest> {
  const key = input.contest.key;
  const suffix = key.replace(/[^a-z0-9]/gi, '');

  const [language] = await db
    .insert(schema.languages)
    .values({ key: `cpp-${suffix}`, name: 'C++', extension: 'cpp' })
    .returning();

  const [owner] = await db
    .insert(schema.users)
    .values({
      username: `setter-${suffix}`,
      email: `setter-${suffix}@e.com`,
      passwordHash: 'x',
      displayName: 'setter',
      globalRole: 'setter',
    })
    .returning({ id: schema.users.id });

  const packageHash = `golden-${suffix}`;
  await db.insert(schema.packages).values({ hash: packageHash, sizeBytes: 1, fileCount: 1 });

  // --- problems, one revision each; published only when there is a dataset ---
  const problemIds = new Map<string, number>();
  const revisionIds = new Map<string, number>();
  for (const problem of input.problems) {
    const total = datasetTotal(problem);
    const [row] = await db
      .insert(problems)
      .values({
        code: problem.code,
        name: problem.name ?? problem.code,
        statement: '',
        visibility: 'public',
        createdBy: owner!.id,
      })
      .returning({ id: problems.id });
    const [revision] = await db
      .insert(problemRevisions)
      .values({
        problemId: row!.id,
        version: 1,
        packageHash,
        // A datasetless golden problem becomes a problem whose only revision
        // is a draft: `points_scaling_factor` is null for exactly those, and
        // the published revision is where the mapping looks for a dataset.
        state: total === null ? 'draft' : 'published',
        createdBy: owner!.id,
        timeMs: 1000,
        memoryKb: 256_000,
        testCount: 1,
        // Never `problem.points`: that is `ContestProblem.points`, the
        // contest-scaled value. `ioi16/10-points-scaling-factor` is 200 there
        // against a 100-point dataset, and this is the 100.
        totalPoints: total ?? problem.points,
        checkerKind: 'wcmp',
      })
      .returning({ id: problemRevisions.id });
    if (total !== null) {
      await db
        .update(problems)
        .set({ currentRevisionId: revision!.id })
        .where(eq(problems.id, row!.id));
    }
    problemIds.set(problem.code, row!.id);
    revisionIds.set(problem.code, revision!.id);
  }

  // --- the contest and its problems ---
  const [contest] = await db
    .insert(contests)
    .values({
      key,
      name: input.contest.name ?? key,
      startTime: new Date(input.contest.start_time),
      endTime: new Date(input.contest.end_time),
      format: input.format,
      formatConfig: input.format_config,
      pointsPrecision: input.contest.points_precision,
      frozenLastMinutes: input.contest.frozen_last_minutes,
      timeLimitSeconds: input.contest.time_limit_seconds,
      visibility: 'public',
      createdBy: owner!.id,
    })
    .returning({ id: contests.id });

  const contestProblemIds = new Map<string, number>();
  for (const [index, problem] of input.problems.entries()) {
    const [row] = await db
      .insert(contestProblems)
      .values({
        contestId: contest!.id,
        problemId: problemIds.get(problem.code)!,
        label: String(index + 1),
        points: problem.points,
        partial: problem.partial,
        order: index,
      })
      .returning({ id: contestProblems.id });
    contestProblemIds.set(problem.code, row!.id);
  }

  // --- participants, seeded directly: joining is out of scope (design §4) ---
  const userIds = new Map<string, number>();
  const participationIds = new Map<string, number>();
  for (const participant of input.participants) {
    // Reused if the username already exists, so two contests can be seeded
    // with the *same* people — which the rating fold needs, since a rating
    // carried from one contest into the next is the whole point of it. Each
    // golden has distinct names within itself, so this changes nothing there.
    const [user] = await db
      .insert(schema.users)
      .values({
        username: participant.name,
        email: `${participant.name}@e.com`,
        passwordHash: 'x',
        displayName: participant.name,
      })
      .onConflictDoNothing()
      .returning({ id: schema.users.id });
    const userId =
      user?.id ??
      (
        await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.username, participant.name))
          .limit(1)
      )[0]!.id;
    const [participation] = await db
      .insert(contestParticipations)
      .values({
        contestId: contest!.id,
        userId,
        startTime: new Date(participant.real_start),
        virtual: participant.virtual,
        isDisqualified: participant.is_disqualified ?? false,
      })
      .returning({ id: contestParticipations.id });
    userIds.set(participant.name, userId);
    participationIds.set(participant.name, participation!.id);
  }

  // --- submissions, in fixture order, which becomes contest_submissions.id order ---
  for (const submission of input.submissions) {
    const cases: TestCaseSpec[] = submission.cases;
    const [row] = await db
      .insert(submissions)
      .values({
        userId: userIds.get(submission.participant)!,
        problemId: problemIds.get(submission.problem)!,
        revisionId: revisionIds.get(submission.problem)!,
        languageId: language!.id,
        source: '',
        state: stateOf(submission.status),
        verdict: verdictOf(submission.result),
        // The judge's own aggregate (`dmoj-driver.ts` sums every case), not
        // the contest-scaled score — that lives on `contest_submissions`.
        points: cases.reduce((sum, c) => sum + c.points, 0),
        maxPoints: cases.reduce((sum, c) => sum + c.total, 0),
        timeMs: 0,
        memoryKb: 0,
        createdAt: new Date(submission.date),
      })
      .returning({ id: submissions.id });

    if (cases.length > 0) {
      await db.insert(submissionCases).values(
        cases.map((testCase, index) => ({
          submissionId: row!.id,
          attempt: 1,
          // `null` and `0` are the same batch upstream; `group_index` is NOT
          // NULL, so both are written as 0.
          groupIndex: testCase.batch ?? 0,
          // The goldens carry no case number — nothing reads one — so the
          // position within the submission is used, which is what the judge
          // writes anyway.
          caseIndex: index,
          verdict: verdictOf(testCase.status),
          skipped: false,
          flags: [],
          timeMs: 0,
          memoryKb: 0,
          points: testCase.points,
          maxPoints: testCase.total,
        })),
      );
    }

    await db.insert(contestSubmissions).values({
      participationId: participationIds.get(submission.participant)!,
      contestProblemId: contestProblemIds.get(submission.problem)!,
      submissionId: row!.id,
    });
  }

  return { contestId: contest!.id, key };
}
