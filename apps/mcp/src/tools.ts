/**
 * Every DuckOJ tool, one table.
 *
 * Two rules hold across the whole table and are checked by
 * `test/tools.spec.ts` rather than by convention:
 *
 * - **Nothing under `/admin` appears here at all.** Not withheld, not gated —
 *   absent. D50 already makes it unreachable (every admin route is
 *   `@SessionOnly` and this server authenticates with a bearer token, which
 *   `SessionOnlyGuard` refuses), so an admin tool could only ever return a
 *   403. Registering one would advertise a capability that does not exist and
 *   invite an agent to try it.
 * - **`mutates` is exactly "the route changes server state"**, which is the
 *   same set as "its scope ends in `:write` or `:publish`". `submissions_submit`
 *   is a write: it enqueues a grading container, it is the one route in the
 *   API with its own meter (D80), and a contest submission is a scored,
 *   irreversible act. The gate is not about danger to data, it is about an
 *   agent doing something on the user's behalf that the user did not watch.
 *
 * Output is always one line of prose plus compact JSON, and the JSON is a
 * PROJECTION rather than the API response. A `GET /problems` page carries
 * `hasPublishedRevision`, `orgSlugs` and a `me` object per row; an agent
 * choosing a problem needs the code, the name, the difficulty and the tags.
 * Handing it everything costs context on every call and buries the four
 * fields it will actually use.
 */
import { z } from 'zod';
import { extractSamples } from './samples.js';
import { ApiFailure, unwrap } from './errors.js';
import { definedOnly, defineTool, type Client, type ToolContext, type ToolSpec } from './tool.js';

const VERDICTS = ['AC', 'WA', 'TLE', 'MLE', 'OLE', 'RTE', 'IR', 'CE', 'IE'] as const;

const problemCode = z.string().min(1).max(64).describe('the problem code, e.g. `tong-hai-so`');
const contestKey = z.string().min(1).max(64).describe('the contest key, e.g. `hsg-2026`');
/**
 * The draft id pattern, copied from the contract rather than written as
 * `z.string().uuid()`: zod 4's `uuid()` enforces the RFC 9562 version and
 * variant nibbles, and the API's own pattern is plain lowercase hex in the
 * UUID layout. A validator stricter than the server's rejects ids the server
 * would have accepted, which is a refusal invented by the client.
 */
const draftId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .describe('the `draftId` from `problems_draft_create`');
const cursor = z.string().optional().describe('`nextCursor` from a previous page');
const limit = z.number().int().min(1).max(100).optional().describe('page size, 1–100');

// ---------------------------------------------------------------- projections

interface TagRef {
  slug: string;
}
interface ProblemRow {
  code: string;
  name: string;
  difficulty: number | null;
  tags: TagRef[];
  timeMs: number | null;
  memoryKb: number | null;
  testCount: number | null;
  solvedCount: number;
  attemptedCount: number;
  me: { verdict: string; points: number | null; maxPoints: number | null } | null;
}

function problemSummary(problem: ProblemRow) {
  return {
    code: problem.code,
    name: problem.name,
    difficulty: problem.difficulty,
    tags: problem.tags.map((tag) => tag.slug),
    timeMs: problem.timeMs,
    memoryKb: problem.memoryKb,
    testCount: problem.testCount,
    solvedCount: problem.solvedCount,
    attemptedCount: problem.attemptedCount,
    myVerdict: problem.me?.verdict ?? null,
  };
}

interface CaseRow {
  groupIndex: number;
  caseIndex: number;
  verdict: string | null;
  skipped: boolean;
  timeMs: number;
  memoryKb: number;
  points: number;
  maxPoints: number;
  feedback: string | null;
}

/**
 * The cases, as a number an agent can act on rather than a list it has to
 * read. A hundred-case run is a hundred objects and one useful fact: which
 * case first stopped being `AC`, and what the judge said about it.
 */
function caseSummary(cases: CaseRow[]) {
  const byVerdict: Record<string, number> = {};
  let skipped = 0;
  let firstFailure: CaseRow | null = null;
  for (const testCase of cases) {
    if (testCase.skipped) skipped++;
    const key = testCase.verdict ?? 'unjudged';
    byVerdict[key] = (byVerdict[key] ?? 0) + 1;
    if (firstFailure === null && !testCase.skipped && testCase.verdict !== null && testCase.verdict !== 'AC') {
      firstFailure = testCase;
    }
  }
  return {
    total: cases.length,
    skipped,
    byVerdict,
    firstFailure:
      firstFailure === null
        ? null
        : {
            groupIndex: firstFailure.groupIndex,
            caseIndex: firstFailure.caseIndex,
            verdict: firstFailure.verdict,
            timeMs: firstFailure.timeMs,
            memoryKb: firstFailure.memoryKb,
            feedback: firstFailure.feedback,
          },
  };
}

function verdictLine(detail: {
  id: number;
  problemCode: string;
  state: string;
  verdict: string | null;
  points: number | null;
  maxPoints: number | null;
}): string {
  const score =
    detail.points === null || detail.maxPoints === null
      ? ''
      : ` ${String(detail.points)}/${String(detail.maxPoints)}`;
  return `#${String(detail.id)} ${detail.problemCode}: ${detail.verdict ?? detail.state}${score}`;
}

// ---------------------------------------------------------------------- watch

/** How many polls in a row may fail before `submissions_watch` gives up. */
const TRANSIENT_TOLERANCE = 5;
const POLL_INTERVAL_MS = 2000;

/**
 * Polls one submission until it leaves the pipeline, the deadline passes, or
 * the network has been broken for long enough to mean it.
 *
 * The deadline is the difference from `oj watch`, which polls 150 times and
 * only then complains. An MCP host cancels a tool call that does not answer —
 * often at 60 s — so a watch that "keeps trying" past the host's patience
 * returns nothing at all, and the agent learns neither the verdict nor that
 * it should ask again. So this one ANSWERS: `timedOut: true`, the state it
 * last saw, and a summary that says to call again. That is a normal result,
 * not an error — nothing went wrong, the judge is simply still working.
 *
 * The transient tolerance is `oj`'s, for `oj`'s reason: one dropped packet
 * must not abandon a submission that is grading perfectly well. A 401/403/404
 * is final and is raised immediately — retrying a refused credential five
 * times only delays the message.
 */
export async function watchSubmission(
  client: Client,
  ctx: ToolContext,
  id: number,
  timeoutMs: number,
): Promise<{ detail: SubmissionDetail | null; polls: number; timedOut: boolean; lastState: string | null }> {
  const deadline = ctx.now() + timeoutMs;
  let consecutiveFailures = 0;
  let polls = 0;
  let lastState: string | null = null;

  for (;;) {
    polls++;
    let detail: SubmissionDetail | undefined;
    let status: number | undefined;
    try {
      const result = await client.GET('/submissions/{id}', { params: { path: { id } } });
      status = result.response.status;
      if (result.error === undefined && result.data !== undefined) {
        detail = result.data;
      }
    } catch {
      // A transport failure: `openapi-fetch` rethrows those instead of
      // resolving them, so both shapes have to be collected before either
      // can be judged transient.
      status = undefined;
    }

    if (detail === undefined) {
      if (status === 401 || status === 403 || status === 404) {
        throw new ApiFailure({
          code: status === 404 ? 'not_found' : 'unauthorized',
          status,
          detail:
            status === 404
              ? `no submission #${String(id)}, or one you may not see`
              : 'the token was refused while watching — it may have expired or lack `submissions:read`',
        });
      }
      consecutiveFailures++;
      if (consecutiveFailures > TRANSIENT_TOLERANCE) {
        throw new ApiFailure({
          code: 'transport_error',
          status: status ?? 0,
          detail: `${String(consecutiveFailures)} consecutive failed polls while watching #${String(id)}`,
        });
      }
    } else {
      consecutiveFailures = 0;
      lastState = detail.state;
      if (detail.state === 'done' || detail.state === 'errored') {
        return { detail, polls, timedOut: false, lastState };
      }
    }

    if (ctx.now() + POLL_INTERVAL_MS >= deadline) {
      return { detail: null, polls, timedOut: true, lastState };
    }
    await ctx.sleep(POLL_INTERVAL_MS);
  }
}

interface SubmissionDetail {
  id: number;
  problemCode: string;
  languageKey: string;
  source: string | null;
  state: string;
  verdict: string | null;
  points: number | null;
  maxPoints: number | null;
  timeMs: number | null;
  memoryKb: number | null;
  compileOutput: string | null;
  cases: CaseRow[];
  contestKey: string | null;
  createdAt: string;
  judgedAt: string | null;
  frozen: boolean;
  sourceHidden: boolean;
}

// ---------------------------------------------------------------- read tools

const readTools: ToolSpec[] = [
  defineTool({
    name: 'problems_search',
    title: 'Search problems',
    description:
      'List the problems this token may see, narrowed by free text, tag slugs and a difficulty band. ' +
      'Called with no arguments it is the plain problem list; every argument is a filter on top of it. ' +
      'Returns one page — pass `cursor` from `nextCursor` for the next.',
    scope: 'problems:read',
    mutates: false,
    shape: {
      q: z.string().max(100).optional().describe('free text matched against the code and the name'),
      tags: z
        .array(z.string().max(64))
        .max(10)
        .optional()
        .describe('tag slugs (see the `duckoj://tags` resource)'),
      difficultyMin: z.number().int().min(1).max(10).optional(),
      difficultyMax: z.number().int().min(1).max(10).optional(),
      limit,
      cursor,
    },
    run: async (client, args) => {
      const data = unwrap(
        await client.GET('/problems', {
          params: {
            query: definedOnly({
              q: args.q,
              // The API's parameter is `tag`, singular and repeated; `tags`
              // is the name a caller reaches for.
              tag: args.tags,
              difficultyMin: args.difficultyMin,
              difficultyMax: args.difficultyMax,
              limit: args.limit,
              cursor: args.cursor,
            }),
          },
        }),
      );
      return {
        summary:
          `${String(data.items.length)} problem(s)` +
          (data.nextCursor === null ? '' : ' — more available, pass `cursor`'),
        data: { items: data.items.map(problemSummary), nextCursor: data.nextCursor },
      };
    },
  }),

  defineTool({
    name: 'problems_get',
    title: 'Read a problem',
    description:
      'The full problem: statement Markdown, time and memory limits, the sample tests parsed out of ' +
      'the statement, tags, difficulty and whether an editorial is available. This is what to read ' +
      'before writing a solution.',
    scope: 'problems:read',
    mutates: false,
    shape: { code: problemCode },
    run: async (client, args) => {
      const problem = unwrap(
        await client.GET('/problems/{code}', { params: { path: { code: args.code } } }),
      );
      const samples = extractSamples(problem.statement);
      return {
        summary:
          `${problem.code} — ${problem.name} ` +
          `(${problem.timeMs === null ? 'no' : String(problem.timeMs) + ' ms'} limit, ` +
          `${String(samples.length)} sample(s))`,
        data: {
          ...problemSummary(problem),
          visibility: problem.visibility,
          totalPoints: problem.totalPoints,
          checkerKind: problem.checkerKind,
          editorialAvailable: problem.editorialAvailable,
          statement: problem.statement,
          // `source` says where the samples came from, because the API models
          // none: `none` means "read the statement yourself", NOT "this
          // problem has no samples". See `samples.ts`.
          samples: { source: samples.length > 0 ? 'statement-table' : 'none', items: samples },
        },
      };
    },
  }),

  defineTool({
    name: 'problems_stats',
    title: 'Problem statistics',
    description:
      'Submission statistics for one problem: totals, acceptance rate, the verdict and language ' +
      'breakdowns, the first solver and the fastest accepted runs.',
    scope: 'problems:read',
    mutates: false,
    shape: { code: problemCode },
    run: async (client, args) => {
      const stats = unwrap(
        await client.GET('/problems/{code}/stats', { params: { path: { code: args.code } } }),
      );
      return {
        summary:
          `${args.code}: ${String(stats.solvedUsers)}/${String(stats.attemptedUsers)} solvers, ` +
          `${String(stats.totalSubmissions)} submissions`,
        data: {
          totalSubmissions: stats.totalSubmissions,
          attemptedUsers: stats.attemptedUsers,
          solvedUsers: stats.solvedUsers,
          acceptanceRate: stats.acceptanceRate,
          verdicts: stats.verdicts,
          languages: stats.languages,
          firstSolver: stats.firstSolver,
          fastest: stats.fastest.slice(0, 5),
        },
      };
    },
  }),

  defineTool({
    name: 'problems_editorial',
    title: 'Read an editorial',
    description:
      "The problem's editorial as Markdown, when the caller may read it — an unpublished editorial, " +
      'or one for a problem you have not solved, answers 404 rather than admitting it exists.',
    scope: 'problems:read',
    mutates: false,
    shape: { code: problemCode },
    run: async (client, args) => {
      const editorial = unwrap(
        await client.GET('/problems/{code}/editorial', { params: { path: { code: args.code } } }),
      );
      return {
        summary: `editorial for ${args.code} (${String(editorial.markdown.length)} characters)`,
        data: { code: args.code, markdown: editorial.markdown },
      };
    },
  }),

  defineTool({
    name: 'submissions_list',
    title: 'List submissions',
    description:
      'Submissions visible to this token, newest first, optionally narrowed to one problem, user, ' +
      'verdict or contest.',
    scope: 'submissions:read',
    mutates: false,
    shape: {
      problem: z.string().max(64).optional().describe('problem code'),
      user: z.string().max(64).optional().describe('username'),
      verdict: z.enum(VERDICTS).optional(),
      contest: z.string().max(64).optional().describe('contest key'),
      limit,
      cursor,
    },
    run: async (client, args) => {
      const data = unwrap(
        await client.GET('/submissions', {
          params: {
            query: definedOnly({
              problem: args.problem,
              user: args.user,
              verdict: args.verdict,
              contest: args.contest,
              limit: args.limit,
              cursor: args.cursor,
            }),
          },
        }),
      );
      return {
        summary:
          `${String(data.items.length)} submission(s)` +
          (data.nextCursor === null ? '' : ' — more available, pass `cursor`'),
        data: {
          items: data.items.map((item) => ({
            id: item.id,
            problemCode: item.problemCode,
            username: item.username,
            languageKey: item.languageKey,
            state: item.state,
            verdict: item.verdict,
            points: item.points,
            maxPoints: item.maxPoints,
            contestKey: item.contestKey,
            createdAt: item.createdAt,
            frozen: item.frozen,
          })),
          nextCursor: data.nextCursor,
        },
      };
    },
  }),

  defineTool({
    name: 'submissions_get',
    title: 'Read one submission',
    description:
      'One submission with its verdict, score, timings and a summary of its test cases. The source ' +
      'and the full case list are omitted unless asked for, because both are large and neither is ' +
      'usually what the caller wants.',
    scope: 'submissions:read',
    mutates: false,
    shape: {
      id: z.number().int().positive(),
      includeSource: z.boolean().optional().default(false),
      includeCases: z.boolean().optional().default(false),
    },
    run: async (client, args) => {
      const detail = unwrap(
        await client.GET('/submissions/{id}', { params: { path: { id: args.id } } }),
      );
      return {
        summary: verdictLine(detail),
        data: {
          id: detail.id,
          problemCode: detail.problemCode,
          languageKey: detail.languageKey,
          state: detail.state,
          verdict: detail.verdict,
          points: detail.points,
          maxPoints: detail.maxPoints,
          timeMs: detail.timeMs,
          memoryKb: detail.memoryKb,
          compileOutput: detail.compileOutput,
          contestKey: detail.contestKey,
          createdAt: detail.createdAt,
          judgedAt: detail.judgedAt,
          frozen: detail.frozen,
          sourceHidden: detail.sourceHidden,
          cases: caseSummary(detail.cases),
          ...(args.includeCases ? { caseDetail: detail.cases } : {}),
          ...(args.includeSource ? { source: detail.source } : {}),
        },
      };
    },
  }),

  defineTool({
    name: 'submissions_watch',
    title: 'Wait for a verdict',
    description:
      'Polls one submission until it is judged, then returns the verdict, the score and a summary of ' +
      'its cases. If the judge is still working when `timeoutSeconds` runs out this returns ' +
      '`timedOut: true` with the last state seen — that is not a failure, call it again.',
    scope: 'submissions:read',
    mutates: false,
    shape: {
      id: z.number().int().positive(),
      timeoutSeconds: z
        .number()
        .int()
        .min(1)
        .max(600)
        .optional()
        .default(120)
        .describe('how long to keep polling before answering `timedOut`'),
    },
    run: async (client, args, ctx) => {
      const outcome = await watchSubmission(client, ctx, args.id, args.timeoutSeconds * 1000);
      if (outcome.detail === null) {
        return {
          summary:
            `#${String(args.id)} is still ${outcome.lastState ?? 'queued'} after ` +
            `${String(args.timeoutSeconds)}s — call submissions_watch again`,
          data: {
            id: args.id,
            state: outcome.lastState,
            timedOut: true,
            polls: outcome.polls,
          },
        };
      }
      const detail = outcome.detail;
      return {
        summary: verdictLine(detail),
        data: {
          id: detail.id,
          problemCode: detail.problemCode,
          state: detail.state,
          verdict: detail.verdict,
          points: detail.points,
          maxPoints: detail.maxPoints,
          timeMs: detail.timeMs,
          memoryKb: detail.memoryKb,
          // The compiler's own words: on a `CE` this is the entire content of
          // the verdict, and on anything else it is the compile warning.
          compileOutput: detail.compileOutput,
          cases: caseSummary(detail.cases),
          timedOut: false,
          polls: outcome.polls,
        },
      };
    },
  }),

  defineTool({
    name: 'contests_list',
    title: 'List contests',
    description: 'Contests visible to this token, optionally limited to one organization.',
    scope: 'contests:read',
    mutates: false,
    shape: {
      org: z.string().min(1).max(64).optional().describe('organization slug'),
      limit,
      cursor,
    },
    run: async (client, args) => {
      const data = unwrap(
        await client.GET('/contests', {
          params: {
            query: definedOnly({ org: args.org, limit: args.limit, cursor: args.cursor }),
          },
        }),
      );
      return {
        summary:
          `${String(data.items.length)} contest(s)` +
          (data.nextCursor === null ? '' : ' — more available, pass `cursor`'),
        data: {
          items: data.items.map((contest) => ({
            key: contest.key,
            name: contest.name,
            startTime: contest.startTime,
            endTime: contest.endTime,
            format: contest.format,
            visibility: contest.visibility,
            isRated: contest.isRated,
            orgs: contest.orgs.map((org) => org.slug),
          })),
          nextCursor: data.nextCursor,
        },
      };
    },
  }),

  defineTool({
    name: 'contests_get',
    title: 'Read a contest',
    description:
      'One contest with its window, format, freeze length and the problems it carries (label, code, ' +
      'points, whether partial scoring is on).',
    scope: 'contests:read',
    mutates: false,
    shape: { key: contestKey },
    run: async (client, args) => {
      const contest = unwrap(
        await client.GET('/contests/{key}', { params: { path: { key: args.key } } }),
      );
      return {
        summary: `${contest.key} — ${contest.name} (${String(contest.problems.length)} problems, ${contest.format})`,
        data: {
          key: contest.key,
          name: contest.name,
          startTime: contest.startTime,
          endTime: contest.endTime,
          format: contest.format,
          visibility: contest.visibility,
          isRated: contest.isRated,
          frozenLastMinutes: contest.frozenLastMinutes,
          timeLimitSeconds: contest.timeLimitSeconds,
          canEdit: contest.canEdit,
          orgs: contest.orgs.map((org) => org.slug),
          problems: contest.problems.map((problem) => ({
            label: problem.label,
            code: problem.code,
            name: problem.name,
            points: problem.points,
            partial: problem.partial,
          })),
        },
      };
    },
  }),

  defineTool({
    name: 'contests_scoreboard',
    title: 'Read a scoreboard',
    description:
      "The contest's scoreboard as its format computes it. `frozen` says whether the board is " +
      'hiding recent submissions (D22); when it is, the visible scores are the frozen ones.',
    scope: 'contests:read',
    mutates: false,
    shape: {
      key: contestKey,
      top: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(50)
        .describe('how many ranked rows to return'),
    },
    run: async (client, args) => {
      const board = unwrap(
        await client.GET('/contests/{key}/scoreboard', { params: { path: { key: args.key } } }),
      );
      const labels = board.label_by_problem;
      return {
        summary:
          `${args.key}: ${String(board.ranking.length)} ranked, ` +
          `${String(board.problems.length)} problems${board.frozen ? ' (frozen)' : ''}`,
        data: {
          frozen: board.frozen,
          frozenAt: board.frozenAt,
          problems: board.problems.map((problem) => ({
            label: problem.label,
            code: problem.code,
            points: problem.points,
            totalAccepted: problem.total_ac,
            firstSolve: problem.first_solve,
          })),
          ranking: board.ranking.slice(0, args.top).map((row) => ({
            rank: row.rank,
            participant: row.participant,
            score: row.score,
            cumtime: row.cumtime,
            virtual: row.virtual,
            isDisqualified: row.is_disqualified,
            // `format_data` is keyed by problem CODE; a scoreboard is read by
            // label, so it is re-keyed here rather than at the caller.
            scores: Object.fromEntries(
              Object.entries(row.format_data).map(([code, cell]) => [
                labels[code] ?? code,
                cell.points,
              ]),
            ),
          })),
        },
      };
    },
  }),

  defineTool({
    name: 'contests_clarifications',
    title: 'Read clarifications',
    description:
      'Clarifications and public announcements for one contest, newest first — your own questions ' +
      'and every answer the organisers published.',
    scope: 'contests:read',
    mutates: false,
    shape: { key: contestKey },
    run: async (client, args) => {
      const data = unwrap(
        await client.GET('/contests/{key}/clarifications', { params: { path: { key: args.key } } }),
      );
      return {
        summary:
          `${String(data.items.length)} clarification(s) for ${args.key}` +
          (data.truncated ? ' (truncated)' : ''),
        data: {
          truncated: data.truncated,
          items: data.items.map((item) => ({
            id: item.id,
            problemCode: item.problemCode,
            askedBy: item.askedBy,
            question: item.question,
            answer: item.answer,
            answeredBy: item.answeredBy,
            visibility: item.visibility,
            createdAt: item.createdAt,
          })),
        },
      };
    },
  }),

  defineTool({
    name: 'me_progress',
    title: 'My progress',
    description:
      "The caller's own progress: solved and attempted counts by tag and by difficulty, the activity " +
      'streak, recent verdicts, upcoming contests and outstanding homework.',
    scope: 'users:read',
    mutates: false,
    shape: {},
    run: async (client) => {
      const progress = unwrap(await client.GET('/users/me/progress'));
      const solved = progress.byTag.reduce((total, tag) => total + tag.solved, 0);
      return {
        summary:
          `${String(solved)} tag-solves, streak ${String(progress.streak.current)} day(s) ` +
          `(longest ${String(progress.streak.longest)})`,
        data: {
          byTag: progress.byTag.map((tag) => ({
            slug: tag.slug,
            solved: tag.solved,
            attempted: tag.attempted,
          })),
          byDifficulty: progress.byDifficulty,
          streak: progress.streak,
          recent: progress.recent,
          upcomingContests: progress.upcomingContests,
          homework: progress.homework,
        },
      };
    },
  }),
];

// --------------------------------------------------------------- write tools

const writeTools: ToolSpec[] = [
  defineTool({
    name: 'submissions_submit',
    title: 'Submit a solution',
    description:
      'Submits source code for grading and returns the new submission id — follow it with ' +
      '`submissions_watch`. Pass `contestKey` to submit INTO a contest; leaving it out submits to ' +
      'practice even during one. Metered at one submission every ten seconds and twenty every ten ' +
      'minutes (D80): a refusal carries `retryAfterSeconds`.',
    scope: 'submissions:write',
    mutates: true,
    shape: {
      problemCode,
      languageKey: z.string().min(1).max(32).describe('a key from the `duckoj://languages` resource'),
      source: z.string().min(1).max(65536),
      contestKey: z.string().min(1).max(64).optional(),
    },
    run: async (client, args) => {
      const data = unwrap(
        await client.POST('/submissions', {
          body: {
            problemCode: args.problemCode,
            languageKey: args.languageKey,
            source: args.source,
            ...(args.contestKey !== undefined ? { contestKey: args.contestKey } : {}),
          },
        }),
      );
      return {
        summary: `submitted #${String(data.id)} to ${args.problemCode} as ${args.languageKey}`,
        data: { id: data.id, problemCode: args.problemCode, languageKey: args.languageKey },
      };
    },
  }),

  defineTool({
    name: 'contests_ask',
    title: 'Ask a clarification',
    description:
      'Asks the organisers a question about a contest, optionally about one problem. The question is ' +
      'private until an organiser publishes it.',
    scope: 'contests:write',
    mutates: true,
    shape: {
      key: contestKey,
      question: z.string().min(1).max(2000),
      problemCode: z.string().min(1).optional().describe('narrow the question to one problem'),
    },
    run: async (client, args) => {
      const data = unwrap(
        await client.POST('/contests/{key}/clarifications', {
          params: { path: { key: args.key } },
          body: {
            question: args.question,
            ...(args.problemCode !== undefined ? { problemCode: args.problemCode } : {}),
          },
        }),
      );
      return {
        summary: `asked clarification #${String(data.id)} on ${args.key}`,
        data: { id: data.id, key: args.key, visibility: data.visibility, createdAt: data.createdAt },
      };
    },
  }),

  defineTool({
    name: 'contests_announce',
    title: 'Announce to a contest',
    description:
      'Posts a public announcement to everyone in a contest — the contest creator or an admin only. ' +
      'This is visible to every participant immediately and cannot be unsent.',
    scope: 'contests:write',
    mutates: true,
    shape: {
      key: contestKey,
      text: z.string().min(1).max(4000),
      problemCode: z.string().min(1).optional().describe('attach the announcement to one problem'),
    },
    run: async (client, args) => {
      const data = unwrap(
        await client.POST('/contests/{key}/announcements', {
          params: { path: { key: args.key } },
          body: {
            text: args.text,
            ...(args.problemCode !== undefined ? { problemCode: args.problemCode } : {}),
          },
        }),
      );
      return {
        summary: `announced #${String(data.id)} on ${args.key}`,
        data: { id: data.id, key: args.key, createdAt: data.createdAt },
      };
    },
  }),

  defineTool({
    name: 'problems_patch',
    title: 'Edit a problem',
    description:
      "Edits a problem's statement, tags, difficulty or editorial. Only the fields you pass change; " +
      'omitting one leaves it alone. Setting `editorialPublished` makes the editorial readable by ' +
      'everybody who may read the problem.',
    scope: 'problems:write',
    mutates: true,
    shape: {
      code: problemCode,
      name: z.string().min(1).max(200).optional(),
      statement: z.string().max(262144).optional().describe('the full statement Markdown'),
      tags: z.array(z.string()).max(20).optional().describe('tag slugs — replaces the whole set'),
      difficulty: z.number().int().min(1).max(10).nullable().optional(),
      editorial: z.string().max(262144).nullable().optional(),
      editorialPublished: z.boolean().optional(),
    },
    run: async (client, args) => {
      const body = definedOnly({
        name: args.name,
        statement: args.statement,
        tags: args.tags,
        difficulty: args.difficulty,
        editorial: args.editorial,
        editorialPublished: args.editorialPublished,
      });
      if (Object.keys(body).length === 0) {
        throw new ApiFailure({
          code: 'nothing_to_patch',
          status: 0,
          detail: 'name at least one field to change',
        });
      }
      const problem = unwrap(
        await client.PATCH('/problems/{code}', { params: { path: { code: args.code } }, body }),
      );
      return {
        summary: `updated ${problem.code} (${Object.keys(body).join(', ')})`,
        data: problemSummary(problem),
      };
    },
  }),

  defineTool({
    name: 'problems_draft_create',
    title: 'Open a package draft',
    description:
      "Opens a draft for authoring a problem's package (F-18/D87): files go in one at a time with " +
      '`problems_draft_put_file`, then `problems_draft_build` turns them into a revision. Drafts ' +
      'expire — `expiresAt` says when.',
    scope: 'problems:publish',
    mutates: true,
    shape: { code: problemCode },
    run: async (client, args) => {
      const draft = unwrap(
        await client.POST('/problems/{code}/drafts', { params: { path: { code: args.code } } }),
      );
      return {
        summary: `draft ${draft.draftId} open on ${args.code} until ${draft.expiresAt}`,
        data: draft,
      };
    },
  }),

  defineTool({
    name: 'problems_draft_put_file',
    title: 'Put a file in a draft',
    description:
      'Stores one file in an open draft. Names are flat and must match `^[A-Za-z0-9._-]+$`; putting ' +
      'the same name twice replaces it. A draft needs a `manifest.json` before it will build.',
    scope: 'problems:publish',
    mutates: true,
    shape: {
      code: problemCode,
      draftId: draftId,
      name: z
        .string()
        .min(1)
        .max(255)
        .regex(/^[A-Za-z0-9._-]+$/)
        .describe('flat file name, e.g. `manifest.json` or `01.in`'),
      content: z.string().describe('the file contents, as text'),
    },
    run: async (client, args) => {
      const stored = unwrap(
        await client.PUT('/problems/{code}/drafts/{draftId}/files/{name}', {
          params: { path: { code: args.code, draftId: args.draftId, name: args.name } },
          body: args.content,
          // The route takes raw bytes. Without both of these `openapi-fetch`
          // would JSON-encode the string and send it as `application/json`,
          // which stores a quoted, escaped copy of the file.
          bodySerializer: (body: string | undefined) => body ?? '',
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
      );
      return {
        summary: `stored ${stored.name} (${String(stored.sizeBytes)} bytes; draft holds ${String(stored.fileCount)} files)`,
        data: stored,
      };
    },
  }),

  defineTool({
    name: 'problems_draft_build',
    title: 'Build a draft',
    description:
      "Builds the draft's files into a package and attaches it as a new revision. `publish: true` " +
      'makes it the live revision, archiving whatever was published before; the default leaves it a ' +
      'draft revision for a human to publish.',
    scope: 'problems:publish',
    mutates: true,
    shape: {
      code: problemCode,
      draftId: draftId,
      notes: z.string().max(4096).optional(),
      publish: z.boolean().optional().default(false),
    },
    run: async (client, args) => {
      const built = unwrap(
        await client.POST('/problems/{code}/drafts/{draftId}/build', {
          params: { path: { code: args.code, draftId: args.draftId } },
          body: {
            publish: args.publish,
            ...(args.notes !== undefined ? { notes: args.notes } : {}),
          },
        }),
      );
      return {
        summary:
          `built ${args.code} revision ${String(built.version)} ` +
          `(${built.published ? 'published' : 'draft'})`,
        data: built,
      };
    },
  }),
];

/** Every tool, reads first. Registration filters this by the writes switch. */
export const TOOLS: readonly ToolSpec[] = [...readTools, ...writeTools];
