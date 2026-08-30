/**
 * The student progress page (F16, D83) — `GET /users/me/progress` and the
 * public half of it, `GET /users/{username}/progress`.
 *
 * **Why it lives in `authz/`.** It reads `submissions`, `problems`,
 * `problem_tags`, `contest_participations`, `problem_sets` and `org_members`,
 * all guarded, and it filters on `problems.visibility` — which is the exact
 * shape of decision the lint rule confining `@duckoj/db/guarded` to this
 * directory exists to keep out of a controller (`UserAccessService`'s header
 * says the same thing about the same numbers).
 *
 * ## What counts (D83)
 *
 * **One exclusion, D49's, applied to every outcome.** A submission joins the
 * bars and the streak only once its contest participation window has closed
 * — `contestWindowOpenWhere`, reused verbatim, never transcribed. That is
 * the brief's "a frozen contest's late verdicts don't count until reveal",
 * and it has to be the *window* rule rather than D23's freeze mask for two
 * independent reasons:
 *
 * - D23 never masks a submission from its own submitter, so on a page that
 *   shows you nothing but your own work the freeze predicate would be
 *   constant `false` and the brief's requirement would not bind at all.
 * - The answer is cached for 60 s per user (below). A viewer-dependent
 *   predicate baked into a cached aggregate is a cache poisoned for every
 *   other viewer — D49 made this argument for the problem statistics and it
 *   is the same argument here.
 *
 * It also happens to be D35's mask for free: a problem being solved inside a
 * live contest contributes no tag and no difficulty to anybody's bars until
 * that room's window closes, so the page cannot become the hint D35
 * withholds.
 *
 * **The heatmap is deliberately NOT excluded.** It counts that a submission
 * exists, which is precisely what D23 says a freeze never hides ("existence
 * is public; the outcome is not") and what `UserStats.submissionCount`
 * already publishes unfiltered. Filtering it would buy no secrecy and would
 * make the reader's own calendar lie to them about a day they remember.
 *
 * **`recent` is not excluded either**, and for D23's own clause: these are
 * the reader's own submissions, and a competitor watching their own
 * submission grade is the normal experience of submitting.
 *
 * ## Public vs. your own
 *
 * `progressFor` (public) counts **public problems only**, exactly like
 * `UserStats` and for §3/§4's reason. `myProgress` counts every problem the
 * reader has submitted to, because a province's students spend most of their
 * time on school-visible homework and a page that silently dropped it would
 * be a dashboard of the wrong life. Nothing leaks: it is their own work, and
 * no problem code, name or tag reaches anybody else through it — the public
 * route serves a different, narrower object rather than the same one masked.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import {
  contestParticipations,
  contests,
  orgMembers,
  organizations,
  problemSetItems,
  problemSets,
  problemTags,
  problems,
  submissions,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import type {
  ActivityHeatmapDto,
  DifficultyProgressDto,
  MyProgressDto,
  ProgressStreakDto,
  RecentVerdictDto,
  TagProgressDto,
  UpcomingContestDto,
  UpcomingHomeworkDto,
  UserProgressDto,
} from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import type { Actor } from './actor.js';
import { ScoreboardCache } from './scoreboard.cache.js';
import { contestWindowOpenWhere, participationEndsAtSql } from './submission.freeze.js';

const { tags, users } = schema;

/**
 * D57's `NULL` means "not chosen", and the server has no browser to ask —
 * so the fallback here is the same one the recovery mails take, and the same
 * one the column carried before 0023 made it nullable.
 */
export const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';

/** Twelve months of calendar, today included. */
export const HEATMAP_DAYS = 365;

/** The last handful of verdicts — a glance, not a submissions page. */
export const RECENT_LIMIT = 10;

/**
 * How many contests and how many homework sets the "what is due" tiles will
 * list. Bounded for D78's reason: a pupil in thirty schools is a payload
 * nobody sized for, and the page is a summary that links to the real lists.
 */
export const UPCOMING_LIMIT = 20;

/** Sixty seconds, per the brief. One key per user, per shape. */
export const PROGRESS_CACHE_TTL_MS = 60_000;
const PROGRESS_CACHE_PREFIX = 'duckoj:progress:v1';

@Injectable()
export class ProgressService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ScoreboardCache) private readonly cache: ScoreboardCache,
  ) {}

  /** The public half, by username. 404 for no such account, like the profile. */
  async progressFor(username: string, now: Date = new Date()): Promise<UserProgressDto> {
    const subject = await this.loadUser(sql`lower(${users.username}) = lower(${username})`);
    const { value } = await this.cache.through(
      `${PROGRESS_CACHE_PREFIX}:user:${String(subject.id)}`,
      () => this.computePublic(subject, now),
      PROGRESS_CACHE_TTL_MS,
    );
    return value;
  }

  /** Your own page. Everything above, over every problem, plus four panels. */
  async myProgress(actor: Actor, now: Date = new Date()): Promise<MyProgressDto> {
    const subject = await this.loadUser(eq(users.id, actor.userId));
    const { value } = await this.cache.through(
      `${PROGRESS_CACHE_PREFIX}:me:${String(subject.id)}`,
      () => this.computeMine(subject, now),
      PROGRESS_CACHE_TTL_MS,
    );
    return value;
  }

  private async loadUser(
    where: ReturnType<typeof eq> | ReturnType<typeof sql>,
  ): Promise<{ id: number; timezone: string }> {
    const [row] = await this.db
      .select({ id: users.id, timezone: users.timezone })
      .from(users)
      .where(where)
      .limit(1);
    if (!row) throw new AppError(404, 'user_not_found', 'No such user.');
    return { id: row.id, timezone: resolveTimeZone(row.timezone) };
  }

  private async computePublic(
    subject: { id: number; timezone: string },
    now: Date,
  ): Promise<UserProgressDto> {
    const [byTag, byDifficulty, heatmap] = await Promise.all([
      this.tagBars(subject.id, true, now),
      this.difficultyBars(subject.id, true, now),
      this.heatmap(subject, true),
    ]);
    return { byTag, byDifficulty, heatmap };
  }

  private async computeMine(
    subject: { id: number; timezone: string },
    now: Date,
  ): Promise<MyProgressDto> {
    const [byTag, byDifficulty, heatmap, streak, recent, upcomingContests, homework] =
      await Promise.all([
        this.tagBars(subject.id, false, now),
        this.difficultyBars(subject.id, false, now),
        this.heatmap(subject, false),
        this.streak(subject, now),
        this.recent(subject.id),
        this.upcomingContests(subject.id, now),
        this.homework(subject.id, now),
      ]);
    return { byTag, byDifficulty, heatmap, streak, recent, upcomingContests, homework };
  }

  // ------------------------------------------------------------- the bars

  /**
   * One row per problem this person has touched: did they solve it, and what
   * is it worth as a hint.
   *
   * **Per problem, not per submission**, which is the whole meaning of the
   * bars — eleven attempts at one problem is one attempt at one problem —
   * and the reason both bar queries hang off this subquery rather than
   * counting rows of `submissions` directly.
   */
  private touchedProblems(userId: number, publicOnly: boolean, now: Date) {
    return this.db
      .select({
        problemId: submissions.problemId,
        difficulty: problems.difficulty,
        solved: sql<boolean>`bool_or(${submissions.verdict} = 'AC')`.as('solved'),
      })
      .from(submissions)
      .innerJoin(problems, eq(problems.id, submissions.problemId))
      .where(
        and(
          eq(submissions.userId, userId),
          publicOnly ? eq(problems.visibility, 'public') : undefined,
          // D49's exclusion, reused rather than restated.
          sql`not ${contestWindowOpenWhere(now)}`,
        ),
      )
      .groupBy(submissions.problemId, problems.difficulty)
      .as('touched');
  }

  private async tagBars(
    userId: number,
    publicOnly: boolean,
    now: Date,
  ): Promise<TagProgressDto[]> {
    const touched = this.touchedProblems(userId, publicOnly, now);
    const rows = await this.db
      .select({
        slug: tags.slug,
        nameVi: tags.nameVi,
        nameEn: tags.nameEn,
        attempted: sql<number>`count(*)::int`,
        solved: sql<number>`count(*) filter (where ${touched.solved})::int`,
      })
      .from(touched)
      .innerJoin(problemTags, eq(problemTags.problemId, touched.problemId))
      .innerJoin(tags, eq(tags.id, problemTags.tagId))
      .groupBy(tags.id, tags.slug, tags.nameVi, tags.nameEn)
      .orderBy(asc(tags.slug));
    return rows.map((row) => ({
      slug: row.slug,
      nameVi: row.nameVi,
      nameEn: row.nameEn,
      attempted: row.attempted,
      solved: row.solved,
    }));
  }

  private async difficultyBars(
    userId: number,
    publicOnly: boolean,
    now: Date,
  ): Promise<DifficultyProgressDto[]> {
    const touched = this.touchedProblems(userId, publicOnly, now);
    const rows = await this.db
      .select({
        difficulty: touched.difficulty,
        attempted: sql<number>`count(*)::int`,
        solved: sql<number>`count(*) filter (where ${touched.solved})::int`,
      })
      .from(touched)
      .groupBy(touched.difficulty)
      // Unrated last: it is not a difficulty, and sorting it with the 1s
      // would claim it is the easiest kind of problem.
      .orderBy(sql`${touched.difficulty} asc nulls last`);
    return rows.map((row) => ({
      difficulty: row.difficulty,
      attempted: row.attempted,
      solved: row.solved,
    }));
  }

  // ---------------------------------------------------------- the calendar

  /**
   * Submissions per calendar day, bucketed **in the subject's own zone**.
   *
   * `at time zone` on a `timestamptz` is the one place this conversion can
   * happen: doing it in the browser would bucket by the READER's zone, so a
   * teacher in Hanoi and one abroad would disagree about which day a pupil
   * worked — and a submission at 06:00 ICT would land on the previous day
   * for half the readers. The zone travels with the answer so the client
   * cannot re-bucket it by accident.
   */
  private async heatmap(
    subject: { id: number; timezone: string },
    publicOnly: boolean,
  ): Promise<ActivityHeatmapDto> {
    const to = todayIn(subject.timezone, new Date());
    const from = addDays(to, -(HEATMAP_DAYS - 1));
    const day = sql<string>`to_char((${submissions.createdAt} at time zone ${subject.timezone}::text)::date, 'YYYY-MM-DD')`;
    const rows = await this.db
      .select({ date: day, count: sql<number>`count(*)::int` })
      .from(submissions)
      .innerJoin(problems, eq(problems.id, submissions.problemId))
      .where(
        and(
          eq(submissions.userId, subject.id),
          publicOnly ? eq(problems.visibility, 'public') : undefined,
          // A sargable bound as well as the exact one: a day either side
          // covers every zone offset, and it is the clause that can use
          // `submissions`' indexes instead of scanning a lifetime.
          gte(submissions.createdAt, new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS)),
          sql`${day} between ${from} and ${to}`,
        ),
      )
      // By ORDINAL, not by the expression again: the day expression carries a
      // bind parameter, and Postgres compares a `GROUP BY` expression to the
      // select list structurally — `$8` is not `$1`, so repeating it is
      // rejected as "must appear in the GROUP BY clause".
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    return {
      timezone: subject.timezone,
      from,
      to,
      // Sparse: a year of zeros is 365 objects saying nothing.
      days: rows.map((row) => ({ date: row.date, count: row.count })),
    };
  }

  /**
   * Consecutive days ending today (or yesterday) with at least one counted
   * `AC`, plus the longest such run inside the heatmap's window.
   *
   * Yesterday still counts as alive, deliberately: a streak that died at
   * midnight would punish somebody who has not opened the judge yet today,
   * which is every reader before their first submission of the day.
   */
  private async streak(
    subject: { id: number; timezone: string },
    now: Date,
  ): Promise<ProgressStreakDto> {
    const today = todayIn(subject.timezone, now);
    const from = addDays(today, -(HEATMAP_DAYS - 1));
    const day = sql<string>`to_char((${submissions.createdAt} at time zone ${subject.timezone}::text)::date, 'YYYY-MM-DD')`;
    const rows = await this.db
      .selectDistinct({ date: day })
      .from(submissions)
      .where(
        and(
          eq(submissions.userId, subject.id),
          eq(submissions.verdict, 'AC'),
          sql`not ${contestWindowOpenWhere(now)}`,
          gte(submissions.createdAt, new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS)),
          sql`${day} between ${from} and ${today}`,
        ),
      )
      .orderBy(sql`1`);
    return streakOf(rows.map((row) => row.date), today);
  }

  // ------------------------------------------------------------ your own

  private async recent(userId: number): Promise<RecentVerdictDto[]> {
    const rows = await this.db
      .select({
        id: submissions.id,
        problemCode: problems.code,
        problemName: problems.name,
        verdict: submissions.verdict,
        points: submissions.points,
        createdAt: submissions.createdAt,
      })
      .from(submissions)
      .innerJoin(problems, eq(problems.id, submissions.problemId))
      .where(eq(submissions.userId, userId))
      .orderBy(desc(submissions.id))
      .limit(RECENT_LIMIT);
    return rows.map((row) => ({
      id: row.id,
      problemCode: row.problemCode,
      problemName: row.problemName,
      verdict: row.verdict,
      points: row.points,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Contests this person holds a participation in whose OWN window is still
   * open — `participationEndsAtSql`, so a virtual entrant's attempt keeps
   * appearing past the contest's `end_time` exactly as their board does.
   */
  private async upcomingContests(userId: number, now: Date): Promise<UpcomingContestDto[]> {
    const endsAt = participationEndsAtSql();
    const rows = await this.db
      .select({
        key: contests.key,
        name: contests.name,
        startTime: contests.startTime,
        endTime: contests.endTime,
        endsAt: sql<Date>`(${endsAt})`,
      })
      .from(contestParticipations)
      .innerJoin(contests, eq(contests.id, contestParticipations.contestId))
      .where(
        and(
          eq(contestParticipations.userId, userId),
          sql`${now.toISOString()}::timestamptz < (${endsAt})`,
        ),
      )
      .orderBy(sql`(${endsAt}) asc`)
      .limit(UPCOMING_LIMIT);
    return rows.map((row) => ({
      key: row.key,
      name: row.name,
      startTime: row.startTime.toISOString(),
      endTime: row.endTime.toISOString(),
      endsAt: new Date(row.endsAt).toISOString(),
    }));
  }

  /**
   * Dated homework from the schools this person belongs to, nearest deadline
   * first, with how much of each is done.
   *
   * **`solved` counts every `AC`, on time or late, and applies no window
   * exclusion.** Both are D66's own rulings read straight: the teacher's
   * grid is D49-excluded because it is a report about other people, while
   * "the pupil's own page" is exempt — a submission's author is never masked
   * from their own result — and a late solve is an entry beside the on-time
   * one rather than nothing at all. The tile answers "what is left to do";
   * the deadline is printed next to it so nobody mistakes it for a mark.
   */
  private async homework(userId: number, now: Date): Promise<UpcomingHomeworkDto[]> {
    const total = sql<number>`(select count(*)::int from ${problemSetItems} where ${problemSetItems.setId} = ${problemSets.id})`;
    const solved = sql<number>`(
      select count(distinct ${problemSetItems.problemId})::int
      from ${problemSetItems}
      join ${submissions} on ${submissions.problemId} = ${problemSetItems.problemId}
        and ${submissions.userId} = ${userId}
        and ${submissions.verdict} = 'AC'
      where ${problemSetItems.setId} = ${problemSets.id}
    )`;
    const rows = await this.db
      .select({
        orgSlug: organizations.slug,
        orgName: organizations.name,
        slug: problemSets.slug,
        name: problemSets.name,
        deadline: problemSets.deadline,
        total,
        solved,
      })
      .from(problemSets)
      .innerJoin(organizations, eq(organizations.id, problemSets.orgId))
      // Membership is the gate D66 put on every set read: a non-member of a
      // visible school sees nothing, so nothing here can name a set the
      // reader could not open on the school's own page.
      .innerJoin(
        orgMembers,
        and(eq(orgMembers.orgId, problemSets.orgId), eq(orgMembers.userId, userId)),
      )
      .where(and(isNotNull(problemSets.deadline), gte(problemSets.deadline, now)))
      .orderBy(asc(problemSets.deadline))
      .limit(UPCOMING_LIMIT);
    return rows.map((row) => ({
      orgSlug: row.orgSlug,
      orgName: row.orgName,
      slug: row.slug,
      name: row.name,
      deadline: row.deadline!.toISOString(),
      total: row.total,
      solved: row.solved,
    }));
  }
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * The stored zone, or the default — and the default again for a value
 * `Intl` refuses. The column is validated at write time (`UpdateMeRequest`),
 * so this can only fire for a row written before that validation existed;
 * a 500 on somebody's own progress page is a worse answer than ICT.
 */
export function resolveTimeZone(stored: string | null): string {
  if (stored === null) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: stored });
    return stored;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** `YYYY-MM-DD` for `at` as the given zone reads it. */
export function todayIn(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * Calendar arithmetic on a `YYYY-MM-DD`, through UTC.
 *
 * Deliberately not `new Date(y, m, d)`: local-time arithmetic across a DST
 * boundary can land on the same day twice, and these strings are already
 * zone-resolved labels rather than instants.
 */
export function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * The streak, from a sorted list of distinct `YYYY-MM-DD` days.
 *
 * Pure, and exported for the tests: every interesting case here (a run
 * broken by one missing day, a run that ended yesterday, a run that ended
 * last month) is a property of a list of strings and needs no database.
 */
export function streakOf(days: string[], today: string): ProgressStreakDto {
  if (days.length === 0) return { current: 0, longest: 0, lastDate: null };
  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    run = addDays(days[i - 1]!, 1) === days[i]! ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  const last = days.at(-1)!;
  // Alive if the last counted AC was today or yesterday; `run` is the length
  // of the run that ends on `last`, which is that streak.
  const alive = last === today || last === addDays(today, -1);
  return { current: alive ? run : 0, longest, lastDate: last };
}
