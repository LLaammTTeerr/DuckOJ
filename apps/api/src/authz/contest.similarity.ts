/**
 * Contest source-similarity reports — chống gian lận (D77).
 *
 * **What this is.** For each problem of a contest, one submission per
 * competitor — their accepted one, else their highest-scoring one — is
 * fingerprinted by `@duckoj/similarity` and compared against every other
 * competitor's. Pairs whose fingerprint containment reaches the run's
 * threshold are recorded, and an organiser can open any of them to read both
 * sources side by side with the matching regions marked.
 *
 * **What this is NOT, and the whole of D77's caution.** A high score is a
 * reason for a human to LOOK. It is not evidence of guilt, and the product
 * never treats it as one: nothing here disqualifies anybody, notifies
 * anybody, or appears on any screen a competitor can reach. Two students
 * taught the same technique by the same teacher, solving the same easy
 * problem, will score high on it and be innocent.
 *
 * **Why it lives in `authz/`.** It reads five guarded tables and writes a
 * sixth (`similarity_runs`), which the runbook's "Reading a guarded table"
 * confines to this directory — the same reason `ContestClarificationsService`
 * is here rather than beside its controller. Every visibility question it
 * asks is delegated to `ContestAccessService.loadVisible` and
 * `canRunContest`; it invents none of its own.
 *
 * **The gate is `canRunContest`, and the pair view is why that matters.**
 * `GET /contests/{key}/similarity/{a}/{b}` serves two competitors' sources to
 * a third person. D27 withholds a contest submission's source from everyone
 * but its submitter, the contest's creator and a global admin while the
 * participation window is open — and the set D27 exempts is exactly the set
 * `canRunContest` describes. So this route hands an organiser nothing they
 * could not already read one submission at a time; what it adds is that they
 * no longer have to know which two to open.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  contestParticipations,
  contestProblems,
  contestSubmissions,
  problems,
  similarityRuns,
  submissions,
  teams,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import {
  compareFingerprints,
  fingerprint,
  languageFamily,
  matchedSpans,
  type Fingerprinted,
  type LanguageFamily,
} from '@duckoj/similarity';
import type {
  SimilarityPairDto,
  SimilarityPairViewDto,
  SimilarityProblemSummaryDto,
  SimilarityReportDto,
  SimilarityRunDto,
} from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import type { Actor } from './actor.js';
import { ContestAccessService, canRunContest } from './contest.access.js';

/**
 * The per-contest advisory lock. Two arguments (`class`, `contestId`) on
 * `ORG_OWNER_LOCK`'s pattern, so two DIFFERENT contests are checked in
 * parallel and the same contest never is — which is what makes this
 * cluster-safe rather than merely single-process-safe: `main.ts` forks
 * `API_WORKERS` workers, and a `Set` in this process would guard one of them.
 */
export const SIMILARITY_LOCK = 0x73696d6c; // 'siml'

/**
 * The two caps, injected rather than hard-coded, on `PROGRESS_EXPORT_BOUNDS`'
 * precedent: a test that had to seed 3001 participants to prove the refusal
 * would take longer than the feature it guards.
 */
export interface SimilarityBounds {
  /** Above this many participants the run is refused outright (422). */
  readonly maxParticipants: number;
  /** Above this many reported pairs on one problem, the tail is dropped. */
  readonly maxPairsPerProblem: number;
}

export const SIMILARITY_BOUNDS = Symbol('SIMILARITY_BOUNDS');
export const DEFAULT_SIMILARITY_BOUNDS: SimilarityBounds = {
  maxParticipants: 3000,
  maxPairsPerProblem: 500,
};

const FORBIDDEN = new AppError(
  403,
  'contest_forbidden',
  'Only the people who run this contest may check it for copied sources.',
);

const PAIR_NOT_FOUND = new AppError(
  404,
  'similarity_pair_not_found',
  'The latest similarity run did not report that pair.',
);

/** The jsonb `similarity_runs.pairs` carries. This file is its authority. */
export interface SimilarityRunSummary {
  participants: number;
  problems: SimilarityProblemSummaryDto[];
  pairs: SimilarityPairDto[];
}

/** One candidate submission, metadata only — the source is fetched later. */
interface CandidateRow {
  username: string;
  contestProblemId: number;
  submissionId: number;
  verdict: string | null;
  points: number | null;
}

@Injectable()
export class ContestSimilarityService {
  private readonly logger = new Logger(ContestSimilarityService.name);

  /**
   * The in-flight run per contest, so a test can await the background work
   * instead of sleeping. **Not** a lock: the advisory lock is, and this map
   * is per-process while that one is per-cluster.
   */
  private readonly running = new Map<number, Promise<void>>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ContestAccessService) private readonly contests: ContestAccessService,
    @Inject(SIMILARITY_BOUNDS) private readonly bounds: SimilarityBounds,
  ) {}

  /**
   * Start a run, and answer with the row it created.
   *
   * The row is INSERTED and committed before the work starts, and the work is
   * deliberately not awaited: a provincial contest is thousands of pairwise
   * comparisons, and an organiser's browser must not hold a request open for
   * them. `GET` is how they find out it finished.
   */
  async start(actor: Actor, key: string, threshold: number): Promise<SimilarityRunDto> {
    const contest = await this.contests.loadVisible(actor, key);
    if (!canRunContest(actor, contest)) throw FORBIDDEN;

    const participants = await this.countParticipants(contest.id);
    if (participants > this.bounds.maxParticipants) {
      // 422, not 400: the request is well formed and the contest is the
      // thing that makes it impossible — the same distinction
      // `contest_freeze_too_long` draws. The hint names the actual number,
      // because "too large" with no figure is a refusal nobody can act on.
      throw new AppError(
        422,
        'similarity_too_large',
        `This contest has ${String(participants)} participants and the check is limited to ` +
          `${String(this.bounds.maxParticipants)}. Split the contest, or check it offline.`,
      );
    }

    const runId = await this.db.transaction(async (tx) => {
      // Check-and-insert under the advisory lock, or two organisers pressing
      // the button at the same second start two runs of the same contest —
      // and on two different workers, where no in-process guard can see the
      // other. The lock is transaction-scoped: it is released by this
      // COMMIT, and the background work takes it again on its own.
      await tx.execute(sql`select pg_advisory_xact_lock(${SIMILARITY_LOCK}, ${contest.id})`);
      const existing = await tx
        .select({ id: similarityRuns.id })
        .from(similarityRuns)
        .where(and(eq(similarityRuns.contestId, contest.id), eq(similarityRuns.status, 'running')))
        .limit(1);
      if (existing[0]) {
        throw new AppError(
          409,
          'similarity_running',
          'A similarity check of this contest is already running.',
        );
      }
      const inserted = await tx
        .insert(similarityRuns)
        .values({
          contestId: contest.id,
          status: 'running',
          threshold,
          requestedBy: actor.userId,
        })
        .returning({ id: similarityRuns.id });
      return inserted[0]!.id;
    });

    // Read the row back BEFORE the work is started, and by its own id
    // rather than as "the latest": `execute` can finish a small contest
    // between the two statements, and a response that said `finished` to the
    // organiser who just pressed the button would be true and useless — the
    // web polls on `running`, and would never poll.
    const created = await this.loadRun(eq(similarityRuns.id, runId));

    const job = this.execute(runId, contest.id, threshold)
      .catch(async (error: unknown) => {
        // A failed run is a FINISHED row that says so, never a row left
        // saying `running` forever: the button would then be dead for that
        // contest with no way back short of editing the table by hand.
        this.logger.error(`similarity run ${String(runId)} failed`, error);
        await this.db
          .update(similarityRuns)
          .set({ status: 'failed', finishedAt: new Date(), error: 'similarity_run_failed' })
          .where(eq(similarityRuns.id, runId));
      })
      .finally(() => {
        this.running.delete(contest.id);
      });
    this.running.set(contest.id, job);

    return created!;
  }

  /**
   * Await the in-flight run of a contest, if there is one.
   *
   * For tests only, and honest about it: production code has `GET` for this.
   * A test that polled instead would be a sleep with extra steps.
   */
  async settle(contestId: number): Promise<void> {
    await this.running.get(contestId);
  }

  /**
   * The latest run of this contest, with everything it found.
   *
   * `{ run: null }` for a contest nobody has checked — never 404. A 404 here
   * would be indistinguishable from "no such contest", and the organiser
   * would have no way to tell "you cannot see this" from "nobody has pressed
   * the button yet".
   */
  async latest(actor: Actor, key: string): Promise<SimilarityReportDto> {
    const contest = await this.contests.loadVisible(actor, key);
    if (!canRunContest(actor, contest)) throw FORBIDDEN;
    const row = await this.loadLatestRun(contest.id);
    return { run: row };
  }

  /**
   * Two matched submissions side by side, with the regions that match.
   *
   * The pair must be one the LATEST run reported. Serving an arbitrary pair
   * of usernames would turn this route into "show me any two competitors'
   * sources", which is a different and much larger permission than the one
   * D77 grants.
   */
  async pairView(
    actor: Actor,
    key: string,
    aName: string,
    bName: string,
    problemCode: string | undefined,
  ): Promise<SimilarityPairViewDto> {
    const contest = await this.contests.loadVisible(actor, key);
    if (!canRunContest(actor, contest)) throw FORBIDDEN;
    const run = await this.loadLatestRun(contest.id);
    if (!run) throw PAIR_NOT_FOUND;

    const wanted = [aName.toLowerCase(), bName.toLowerCase()].sort();
    const candidates = run.pairs.filter((pair) => {
      const names = [pair.a.toLowerCase(), pair.b.toLowerCase()].sort();
      if (names[0] !== wanted[0] || names[1] !== wanted[1]) return false;
      return problemCode === undefined || pair.problemCode === problemCode;
    });
    // The pairs are already sorted by containment, so the first survivor is
    // the highest-scoring one — which is the pair an organiser clicking a
    // row without naming a problem meant.
    const pair = candidates[0];
    if (!pair) throw PAIR_NOT_FOUND;

    const sources = await this.loadSources([pair.aSubmissionId, pair.bSubmissionId]);
    const left = sources.get(pair.aSubmissionId);
    const right = sources.get(pair.bSubmissionId);
    // A submission deleted since the run: the pair is real history, but
    // there is nothing left to show side by side.
    if (!left || !right) throw PAIR_NOT_FOUND;

    const family = languageFamily(left.languageKey) ?? languageFamily(right.languageKey);
    // The report only ever pairs two submissions of one family, so this is
    // unreachable unless the language table changed under the run. Falling
    // back to `cpp` would highlight the wrong thing; refusing says so.
    if (!family) throw PAIR_NOT_FOUND;

    const printedA = fingerprint(left.source, family);
    const printedB = fingerprint(right.source, family);
    const spans = matchedSpans(printedA, printedB);
    return {
      problemCode: pair.problemCode,
      problemLabel: pair.problemLabel,
      jaccard: pair.jaccard,
      containment: pair.containment,
      a: {
        username: pair.a,
        submissionId: pair.aSubmissionId,
        languageKey: left.languageKey,
        source: left.source,
        spans: spans.a,
      },
      b: {
        username: pair.b,
        submissionId: pair.bSubmissionId,
        languageKey: right.languageKey,
        source: right.source,
        spans: spans.b,
      },
    };
  }

  // ---------------------------------------------------------------- the run

  /**
   * The whole check, under the contest's advisory lock.
   *
   * Problem by problem rather than all at once: only one problem's sources
   * are in memory at a time, which is the difference between 15 MB and half
   * a gigabyte on a contest at the participant cap.
   */
  private async execute(runId: number, contestId: number, threshold: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${SIMILARITY_LOCK}, ${contestId})`);
      const problemRows = await tx
        .select({
          id: contestProblems.id,
          code: problems.code,
          label: contestProblems.label,
        })
        .from(contestProblems)
        .innerJoin(problems, eq(problems.id, contestProblems.problemId))
        .where(eq(contestProblems.contestId, contestId))
        .orderBy(asc(contestProblems.order), asc(contestProblems.id));

      const candidates = await this.loadCandidates(contestId);
      const everyone = new Set(candidates.map((row) => row.username));
      const summaries: SimilarityProblemSummaryDto[] = [];
      const pairs: SimilarityPairDto[] = [];

      for (const problem of problemRows) {
        const best = bestPerParticipant(candidates.filter((row) => row.contestProblemId === problem.id));
        const sources = await this.loadSources([...best.values()]);
        const found = comparePeople(best, sources, threshold);
        const capped = found.pairs.slice(0, this.bounds.maxPairsPerProblem);
        summaries.push({
          code: problem.code,
          label: problem.label,
          participants: best.size,
          compared: found.compared,
          reported: found.pairs.length,
          truncated: found.pairs.length > capped.length,
        });
        for (const pair of capped) {
          pairs.push({ ...pair, problemCode: problem.code, problemLabel: problem.label });
        }
      }

      // Highest containment first across the whole contest, then by problem
      // and by name, so two runs of an unchanged contest produce the same
      // table in the same order — a report that reshuffles between two
      // readings is a report nobody can talk about over the phone.
      pairs.sort(
        (x, y) =>
          y.containment - x.containment ||
          y.jaccard - x.jaccard ||
          x.problemCode.localeCompare(y.problemCode) ||
          x.a.localeCompare(y.a) ||
          x.b.localeCompare(y.b),
      );

      const summary: SimilarityRunSummary = {
        participants: everyone.size,
        problems: summaries,
        pairs,
      };
      await tx
        .update(similarityRuns)
        .set({ status: 'finished', finishedAt: new Date(), pairs: summary, error: null })
        .where(eq(similarityRuns.id, runId));
    });
  }

  // ------------------------------------------------------------ the loaders

  /**
   * How many distinct people are in this contest live.
   *
   * **Live participations only** (`virtual = 0`), and disqualified rows
   * INCLUDED. A virtual replay is somebody sitting a finished contest at
   * home with the statements already public — copying there is not the fraud
   * this feature is about, and comparing a replay against the live board
   * would report every competitor who solved a problem the same way as the
   * person who read their solution afterwards. A disqualified competitor, on
   * the other hand, is exactly whose code an organiser wants to compare:
   * that is often WHY they were disqualified.
   */
  private async countParticipants(contestId: number): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(distinct ${contestParticipations.userId})::int` })
      .from(contestParticipations)
      .where(
        and(eq(contestParticipations.contestId, contestId), eq(contestParticipations.virtual, 0)),
      );
    return rows[0]?.count ?? 0;
  }

  /**
   * Every graded submission made into this contest by a live participation,
   * metadata only.
   *
   * Without `source`, deliberately: this is one row per submission of the
   * whole contest, and carrying the text through it would load every attempt
   * anybody made rather than the one per person per problem that is actually
   * compared.
   */
  private async loadCandidates(contestId: number): Promise<CandidateRow[]> {
    const rows = await this.db
      .select({
        username: schema.users.username,
        teamName: teams.name,
        contestProblemId: contestSubmissions.contestProblemId,
        submissionId: contestSubmissions.submissionId,
        verdict: submissions.verdict,
        points: submissions.points,
      })
      .from(contestSubmissions)
      .innerJoin(
        contestParticipations,
        eq(contestParticipations.id, contestSubmissions.participationId),
      )
      .innerJoin(schema.users, eq(schema.users.id, contestParticipations.userId))
      // D99: a team is ONE participant, so every member's submissions are the
      // team's and "one submission per person per problem" becomes one per
      // TEAM per problem. The label is the team's name, which is also what
      // the scoreboard prints and what `pairView` looks a pair up by — three
      // members' independent attempts at one problem must not be reported as
      // three suspiciously similar competitors.
      .leftJoin(teams, eq(teams.id, contestParticipations.teamId))
      .innerJoin(submissions, eq(submissions.id, contestSubmissions.submissionId))
      .where(
        and(eq(contestParticipations.contestId, contestId), eq(contestParticipations.virtual, 0)),
      )
      .orderBy(asc(contestSubmissions.submissionId));
    return rows.map(({ teamName, ...row }) => ({ ...row, username: teamName ?? row.username }));
  }

  /** The sources of the chosen submissions, in one query. */
  private async loadSources(
    ids: number[],
  ): Promise<Map<number, { source: string; languageKey: string }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({
        id: submissions.id,
        source: submissions.source,
        languageKey: schema.languages.key,
      })
      .from(submissions)
      .innerJoin(schema.languages, eq(schema.languages.id, submissions.languageId))
      .where(inArray(submissions.id, ids));
    return new Map(rows.map((row) => [row.id, { source: row.source, languageKey: row.languageKey }]));
  }

  /** The newest run of a contest, as the contract shapes it. */
  private async loadLatestRun(contestId: number): Promise<SimilarityRunDto | null> {
    return this.loadRun(eq(similarityRuns.contestId, contestId));
  }

  /**
   * One run, as the contract shapes it — the newest matching the condition.
   *
   * One query for both callers ("the latest of this contest" and "the one I
   * just inserted") rather than two: the mapping below is the shape of the
   * response, and a second copy of it is a second thing to keep in step.
   */
  private async loadRun(where: SQL): Promise<SimilarityRunDto | null> {
    const rows = await this.db
      .select({
        id: similarityRuns.id,
        status: similarityRuns.status,
        threshold: similarityRuns.threshold,
        startedAt: similarityRuns.startedAt,
        finishedAt: similarityRuns.finishedAt,
        error: similarityRuns.error,
        pairs: similarityRuns.pairs,
        requestedBy: schema.users.username,
      })
      .from(similarityRuns)
      .leftJoin(schema.users, eq(schema.users.id, similarityRuns.requestedBy))
      .where(where)
      .orderBy(desc(similarityRuns.startedAt), desc(similarityRuns.id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const summary = (row.pairs ?? null) as SimilarityRunSummary | null;
    return {
      id: row.id,
      // `status` is text in the schema, and the contract's enum is the
      // authority on what the API may answer: anything else is reported as a
      // failed run rather than crashing the response.
      status: row.status === 'running' || row.status === 'finished' ? row.status : 'failed',
      threshold: row.threshold,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
      requestedBy: row.requestedBy,
      error: row.error,
      participants: summary?.participants ?? 0,
      problems: summary?.problems ?? [],
      pairs: summary?.pairs ?? [],
    };
  }
}

/**
 * One submission per person: their accepted one, else their highest-scoring
 * one, ties broken by the LATEST.
 *
 * An AC beats a higher-scoring non-AC on purpose — an accepted solution is
 * the finished piece of work, and a 90-point wrong answer is a draft. The
 * latest is preferred among equals because it is the one the competitor
 * chose to end on.
 *
 * Exported for its own test: which submission is compared is the single
 * decision most able to make a whole report meaningless, and it is invisible
 * from outside once the numbers come out.
 */
export function bestPerParticipant(rows: readonly CandidateRow[]): Map<string, number> {
  const best = new Map<string, CandidateRow>();
  for (const row of rows) {
    const current = best.get(row.username);
    if (!current || beats(row, current)) best.set(row.username, row);
  }
  return new Map([...best].map(([username, row]) => [username, row.submissionId]));
}

function beats(row: CandidateRow, current: CandidateRow): boolean {
  const rowAc = row.verdict === 'AC';
  const currentAc = current.verdict === 'AC';
  if (rowAc !== currentAc) return rowAc;
  const rowPoints = row.points ?? 0;
  const currentPoints = current.points ?? 0;
  if (rowPoints !== currentPoints) return rowPoints > currentPoints;
  return row.submissionId > current.submissionId;
}

/**
 * Every pair of people on one problem, compared inside its language family.
 *
 * **Only within a family.** A Python file and a C++ file share almost no
 * tokens, so a score between them is noise with a number on it; `cpp17`
 * against `cpp20` is the same language and is compared. A submission in a
 * language this package has no lexer for is SKIPPED — the run says so
 * through `compared` being lower than `n(n-1)/2`, rather than failing.
 *
 * Exported for its own test.
 */
export function comparePeople(
  best: ReadonlyMap<string, number>,
  sources: ReadonlyMap<number, { source: string; languageKey: string }>,
  threshold: number,
): { pairs: Omit<SimilarityPairDto, 'problemCode' | 'problemLabel'>[]; compared: number } {
  const printed: { username: string; submissionId: number; family: LanguageFamily; print: Fingerprinted }[] = [];
  for (const [username, submissionId] of [...best].sort((x, y) => x[0].localeCompare(y[0]))) {
    const row = sources.get(submissionId);
    if (!row) continue;
    const family = languageFamily(row.languageKey);
    if (!family) continue;
    printed.push({ username, submissionId, family, print: fingerprint(row.source, family) });
  }

  const pairs: Omit<SimilarityPairDto, 'problemCode' | 'problemLabel'>[] = [];
  let compared = 0;
  for (let i = 0; i < printed.length; i += 1) {
    for (let j = i + 1; j < printed.length; j += 1) {
      const left = printed[i]!;
      const right = printed[j]!;
      if (left.family !== right.family) continue;
      compared += 1;
      const score = compareFingerprints(left.print, right.print);
      // **Containment**, not Jaccard, is what the threshold tests: a copy
      // padded with fifty lines of unused helpers keeps its containment and
      // loses its Jaccard, and padding is the first thing a copier does.
      // Containment is never below Jaccard, so this admits every pair
      // either measure would.
      if (score.containment < threshold) continue;
      pairs.push({
        a: left.username,
        b: right.username,
        aSubmissionId: left.submissionId,
        bSubmissionId: right.submissionId,
        jaccard: score.jaccard,
        containment: score.containment,
        language: left.family,
      });
    }
  }
  pairs.sort((x, y) => y.containment - x.containment || y.jaccard - x.jaccard || x.a.localeCompare(y.a));
  return { pairs, compared };
}
