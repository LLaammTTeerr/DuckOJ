/**
 * The organiser's live monitor — D95.
 *
 * **What it is.** `GET /contests/{key}/monitor` is contest day in one
 * response: what each problem is doing, what the judge still owes this
 * contest, whether the judges are alive, the last fifty submissions with
 * their real verdicts, the questions nobody has answered yet, how many
 * competitors have a live socket open, and how many submissions the rate
 * limiter turned away. One response rather than seven for D47's reason — the
 * panels only mean anything together, and a five-second refresh of seven
 * routes is seven times the load for one page.
 *
 * **Why it lives in `authz/`.** It reads six guarded tables, which the
 * runbook's "Reading a guarded table" confines to this directory —
 * `ContestSimilarityService`'s reason exactly. It invents no visibility rule
 * of its own: `ContestAccessService.loadVisible` decides who may see the
 * contest (404) and `canRunContest` decides who may run it (403), which are
 * the same two gates the similarity report is behind.
 *
 * **Nothing here is frozen.** D22 hands the contest's creator and a global
 * admin the live scoreboard, and D23 exempts the same set from the
 * submission mask. This route is gated on exactly that set, so the feed shows
 * real verdicts inside a freeze window — an organiser who could not see what
 * the judge was doing during the last hour of their own contest would have no
 * monitor at all.
 *
 * **Every query is bounded, and by the CONTEST rather than by a window.** A
 * time window bounds the rows a query returns; only an index bounds the rows
 * it scans (D47's amendment, the sentence that cost migration 0025). So:
 *
 * - the FEED enters `contest_submissions` through
 *   `contest_submissions_contest_problem_idx` (migration 0035) — before it,
 *   there was no index into that table from a contest at all, and it scanned
 *   every contest submission the deployment had ever taken. Measured on a
 *   seeded 100k-row fixture (B-17): `Index Scan Backward using
 *   contest_submissions_contest_problem_idx`, 82 shared buffers, 1.4 ms;
 * - the PER-PROBLEM counts read **counters** rather than aggregating
 *   anything (D100, migration 0037). They used to be a grouped outer join,
 *   and B-17 measured what that cost: on a fixture with 100k rows belonging
 *   to a DIFFERENT contest and 200 to this one, `Seq Scan on
 *   contest_submissions (rows=100200)` + `Seq Scan on submissions
 *   (rows=100200)`, 32 ms, to produce ten rows. Two `LATERAL` rewrites drove
 *   `contest_submissions` through 0035 and measured WORSE (98 ms), because
 *   the planner's ~5010-rows-per-problem estimate hashes `submissions` ten
 *   times over. The cost was never in the query: an aggregate over every
 *   submission ever made cannot be made O(problems) by rewriting it. So
 *   `contest_problem_stats` is maintained on write by the three processes
 *   that can move it, and this panel is now one index scan of
 *   `contest_problems` with a primary-key probe per row — bounded by the
 *   CONTEST'S PROBLEM LIST, which is ten;
 * - the feed is a `LATERAL` top-50 per problem, so it reads at most
 *   `50 × problems` rows however large the contest is, rather than sorting
 *   the whole contest to discard all but fifty;
 * - the queue panel is driven from `grading_jobs` under
 *   `grading_jobs_active_idx`'s predicate, spelled `state <> 'done'` word for
 *   word so the planner can prove it applies (D47's rule, and the reason its
 *   comment says not to tidy the clause);
 * - the refusals count rides `rate_events_created_at_idx` (migration 0029)
 *   inside a ten-minute window.
 *
 * **And it is cached for five seconds**, unlike D47's dashboard, which
 * deliberately caches nothing. The difference is who is holding the page
 * open: the dashboard is one admin, and this is every organiser and
 * invigilator in a province during the two hours the system is busiest, on a
 * screen that polls every five seconds. Five seconds is the poll interval
 * itself, so the cache collapses a room of organisers into one snapshot per
 * tick and nobody ever sees a number older than their own refresh.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { recomputeContestStats, type Db } from '@duckoj/db';
import type {
  ContestMonitorClarificationDto,
  ContestMonitorDto,
  ContestMonitorEntryDto,
  ContestMonitorProblemDto,
  ContestMonitorQueryDto,
} from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import { REFUSAL_PREFIX } from '../common/rate-limiter.js';
import { CONTEST_PRESENCE, type ContestPresence } from '../realtime/contest-presence.js';
import { SUBMISSION_PURPOSE } from './submission.access.js';
import { ContestAccessService, canRunContest } from './contest.access.js';
import { JUDGE_SILENCE_SECONDS } from './dashboard.access.js';
import { ScoreboardCache } from './scoreboard.cache.js';
import type { Actor } from './actor.js';

/**
 * Five seconds — and the page's own poll interval, not a number chosen
 * separately from it. If the two ever disagree the reader is shown a
 * staleness they cannot perceive the shape of: a 2 s cache under a 5 s poll
 * buys nothing, and a 30 s cache under a 5 s poll is a page that lies for six
 * refreshes in a row.
 */
export const MONITOR_CACHE_TTL_MS = 5_000;

/** How many lines the feed carries. A readout, not a log. */
const FEED_LIMIT = 50;

/** How many unanswered questions ride along with their count. */
const CLARIFICATION_LIMIT = 5;

const FORBIDDEN = new AppError(
  403,
  'contest_forbidden',
  'Only the people who run this contest may watch it.',
);

/**
 * One key per contest, and only one — unlike the scoreboard's, which carries
 * a view and a freeze phase (D25), because this response has exactly one
 * audience and no freeze to be on either side of.
 *
 * No invalidation, deliberately. Every write that would change this snapshot
 * is a submission or a verdict, and the API does not handle the verdict at
 * all (D25 records the same asymmetry for the scoreboard: `judged` is a
 * separate process that never calls in). A monitor five seconds behind the
 * judge is what the TTL already promises, and the `contest-activity`
 * WebSocket frame is what makes the *page* faster than the cache — it
 * triggers a refetch that lands on the next tick rather than pretending the
 * cache is fresher than it is.
 */
export function monitorCacheKey(contestId: number): string {
  return `duckoj:monitor:v1:${String(contestId)}`;
}

/** `db.execute` hands back strings for bigint and numeric columns. */
function num(value: unknown): number {
  return Number(value ?? 0);
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

@Injectable()
export class ContestMonitorService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ContestAccessService) private readonly contests: ContestAccessService,
    @Inject(ScoreboardCache) private readonly cache: ScoreboardCache,
    @Inject(CONTEST_PRESENCE) private readonly presence: ContestPresence,
  ) {}

  /**
   * `recompute` is the organiser's repair (D100), and it deliberately runs
   * AFTER both gates: rebuilding a contest's counters is a write, and a write
   * behind a route that 404s strangers and 403s spectators is a write only
   * the people who run the contest can make.
   *
   * It also **replaces** the cached snapshot rather than reading through it.
   * Recomputing the counters and then serving a snapshot taken five seconds
   * before the recompute would show the organiser exactly the numbers they
   * pressed the button to correct, and they would press it again.
   */
  async snapshot(
    actor: Actor,
    key: string,
    query: ContestMonitorQueryDto = {},
  ): Promise<ContestMonitorDto> {
    // `loadVisible` first, so a contest this caller may not see 404s and the
    // 403 below can only ever be reached by somebody who already knows the
    // contest exists. The similarity report's order, for its reason.
    const contest = await this.contests.loadVisible(actor, key);
    if (!canRunContest(actor, contest)) throw FORBIDDEN;

    if (query.recompute === '1') {
      await recomputeContestStats(this.db, contest.id);
      const fresh = await this.compute(contest.id);
      await this.cache.put(monitorCacheKey(contest.id), fresh, MONITOR_CACHE_TTL_MS);
      return fresh;
    }

    const { value } = await this.cache.through(
      monitorCacheKey(contest.id),
      () => this.compute(contest.id),
      MONITOR_CACHE_TTL_MS,
    );
    return value;
  }

  /**
   * May this actor watch this contest's activity over the WebSocket, and
   * under what key?
   *
   * The same two gates as `snapshot`, called out as their own method so
   * `SubmissionsGateway` — which must not import `contest.access.js`, and
   * must not grow a second opinion about who runs a contest — asks the
   * question rather than answering it. `AuthGuard` covers HTTP routes only:
   * a WebSocket upgrade never passes through it, so this IS the check, not
   * defence in depth.
   *
   * Returns the contest's canonical `key`, not the one the client typed.
   * Contest keys are matched case-insensitively (`contests_key_lower_idx`),
   * and the `contest-activity` frame has to carry the same spelling
   * `contestKeyForSubmission` will produce or the fan-out silently matches
   * nobody.
   */
  async assertMayWatch(actor: Actor, key: string): Promise<string> {
    const contest = await this.contests.loadVisible(actor, key);
    if (!canRunContest(actor, contest)) throw FORBIDDEN;
    return contest.key;
  }

  /**
   * Which contest a submission was made into, or `null` for a practice one.
   *
   * A **system** read: it takes no actor, answers no request, and is called
   * by `SubmissionsGateway` to decide which contest a wake-up belongs to. The
   * link is the `contest_submissions` row, walked through
   * `contest_participations` exactly as D24 rules — never "a submission
   * against a problem this contest happens to contain". Safe because
   * `contest_submissions_submission_idx` is UNIQUE on `submission_id`, so
   * this is one index lookup and at most one row.
   *
   * It leaks nothing on its own: the gateway sends the key only to sockets it
   * has already authorized with `canRunContest`.
   */
  async contestKeyForSubmission(submissionId: number): Promise<string | null> {
    const rows = await this.db.execute<{ key: string }>(sql`
      select c.key
        from contest_submissions cs
        join contest_participations part on part.id = cs.participation_id
        join contests c                  on c.id = part.contest_id
       where cs.submission_id = ${submissionId}
       limit 1
    `);
    return rows[0]?.key ?? null;
  }

  private async compute(contestId: number): Promise<ContestMonitorDto> {
    // Sequential, not `Promise.all`: one postgres.js connection serialises
    // its queries anyway, so parallelism would buy nothing and would make a
    // failure in one panel harder to attribute. `DashboardService.snapshot`'s
    // reasoning, unchanged.
    const problems = await this.problems(contestId);
    const queue = await this.queue(contestId);
    const feed = await this.feed(contestId);
    const clarifications = await this.clarifications(contestId);
    const judges = await this.judges();
    const participantsOnline = await this.participantsOnline(contestId);
    const submitRefusalsLast10Min = await this.refusals();

    return {
      problems,
      queue: { depth: queue.depth, oldestPendingSeconds: queue.oldestPendingSeconds },
      judges,
      feed,
      clarifications,
      participantsOnline,
      submitRefusalsLast10Min,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Per problem: how many attempts, how many passed, how many DISTINCT
   * people passed, and how many are still waiting — read from
   * `contest_problem_stats` (D100, migration 0037).
   *
   * `submitted` counts rows and `solvers` counts people, and the gap between
   * them is the whole reason both are here — "40 submissions, 6 solvers" is a
   * problem the room is stuck on, and either number alone hides it.
   *
   * **A `left join` onto the counters, and it is load-bearing twice over.** A
   * problem nobody has touched is a row of zeros rather than an absence — a
   * contest's problem list is what the panel is a table OF, and dropping the
   * untouched ones would renumber it every time somebody submitted. And a
   * contest problem created after 0037's backfill has no counter row until
   * its first submission, so `coalesce` is what makes "no row yet" and "no
   * submissions yet" the same answer instead of a crash.
   *
   * Disqualified participations are counted, deliberately and now
   * structurally: this is a monitor, not a scoreboard — the submission
   * happened, the judge spent a container on it, and hiding it here would
   * make the queue panel and this one disagree about the same rows.
   *
   * The plan is `contest_problems` by `contest_id` (its own unique index's
   * leading column) with one primary-key probe of `contest_problem_stats` per
   * row: O(the contest's problem list), which is ten.
   * `contest-monitor-plan.spec.ts` asserts exactly that, on a fixture where
   * the old grouped join sequentially scanned 100 200 rows twice.
   */
  private async problems(contestId: number): Promise<ContestMonitorProblemDto[]> {
    const rows = await this.db.execute<{
      code: string;
      label: string;
      submitted: string;
      accepted: string;
      solvers: string;
      pending: string;
    }>(sql`
      select p.code,
             cp.label,
             coalesce(st.submitted, 0) as submitted,
             coalesce(st.accepted, 0)  as accepted,
             coalesce(st.solvers, 0)   as solvers,
             coalesce(st.pending, 0)   as pending
        from contest_problems cp
        join problems p                    on p.id = cp.problem_id
        left join contest_problem_stats st on st.contest_problem_id = cp.id
       where cp.contest_id = ${contestId}
       order by cp."order", cp.id
    `);
    return rows.map((row) => ({
      code: row.code,
      label: row.label,
      submitted: num(row.submitted),
      accepted: num(row.accepted),
      solvers: num(row.solvers),
      pending: num(row.pending),
    }));
  }

  /**
   * What the judge still owes THIS contest, split by problem and totalled.
   *
   * Driven from `grading_jobs`, not from `submissions.state`: the queue is
   * the thing an organiser is actually asking about, and a job is what a
   * judge picks up. `state <> 'done'` is `grading_jobs_active_idx`'s
   * predicate spelled word for word — do not tidy it into an `in (…)` or a
   * `not in (…)`: Postgres serves a partial index only where it can prove the
   * restriction implies the predicate, and the failure mode of getting that
   * wrong is silent (D47's amendment says so about the same index).
   *
   * `oldestPendingSeconds` is `null` for an empty queue, never `0` — D47's
   * ruling, for D47's reason: zero reads as "queued this instant", which is
   * the opposite of calm.
   *
   * **No longer split by problem** (D100). It used to also feed the
   * per-problem `pending` column, which made one number on the page come from
   * `grading_jobs` and its neighbours from `contest_submissions` — two facts
   * that can honestly disagree (a job row swept away leaves a submission
   * still un-judged). `contest_problem_stats.pending` is now the one source
   * for "what is this problem still waiting on", and this panel keeps the one
   * question only `grading_jobs` can answer: how deep the queue is and how
   * long its oldest entry has sat there.
   */
  private async queue(contestId: number): Promise<{
    depth: number;
    oldestPendingSeconds: number | null;
  }> {
    const rows = await this.db.execute<{
      n: string;
      oldest_seconds: string | null;
    }>(sql`
      select count(*) as n,
             extract(epoch from (now() - min(gj.created_at))) as oldest_seconds
        from grading_jobs gj
        join contest_submissions cs on cs.submission_id = gj.submission_id
        join contest_problems cp    on cp.id = cs.contest_problem_id
       where gj.state <> 'done'
         and cp.contest_id = ${contestId}
    `);

    const row = rows[0];
    const depth = num(row?.n);
    const seconds = row?.oldest_seconds;
    const oldest =
      depth === 0 || seconds === null || seconds === undefined
        ? null
        : Math.max(0, Math.round(Number(seconds)));
    return { depth, oldestPendingSeconds: oldest };
  }

  /**
   * The last fifty submissions into this contest, newest first.
   *
   * **A `LATERAL` top-50 per problem, not an `order by … limit 50` over the
   * contest.** The two return the same rows; only one of them is bounded. A
   * plain sort reads every contest submission ever made into this contest and
   * throws all but fifty away, which grows with the contest all the way to
   * the last minute — precisely when this page is being watched. The lateral
   * reads at most fifty rows per problem through
   * `contest_submissions_contest_problem_idx` (migration 0035, whose second
   * column is `id` for exactly this), and the outer sort then has at most
   * `50 × problems` rows in front of it. Ten problems is 500 rows, forever.
   *
   * `contest_submissions.id` orders the feed rather than `submissions.id`.
   * The two agree — a contest submission row is written with the submission
   * it names — and only the first is in the index the lateral scans.
   */
  private async feed(contestId: number): Promise<ContestMonitorEntryDto[]> {
    const rows = await this.db.execute<{
      submission_id: string;
      username: string;
      team: string | null;
      code: string;
      label: string;
      state: string;
      verdict: string | null;
      created_at: Date;
    }>(sql`
      select x.submission_id, u.username, t.name as team,
             p.code, cp.label, s.state, s.verdict, s.created_at
        from contest_problems cp
        join problems p on p.id = cp.problem_id
        cross join lateral (
          select cs.id, cs.submission_id, cs.participation_id
            from contest_submissions cs
           where cs.contest_problem_id = cp.id
           order by cs.id desc
           limit ${FEED_LIMIT}
        ) x
        join submissions s                    on s.id = x.submission_id
        -- D105. submissions.user_id, NOT the participation's: a team is one
        -- row held by whoever pressed Join (D99), so part.user_id is the
        -- captain, and naming them here put a pupil who may not have touched
        -- a keyboard against every teammate's submission — on the one screen
        -- an invigilator uses to find the pupil who did.
        join users u                          on u.id = s.user_id
        join contest_participations part      on part.id = x.participation_id
        -- The board is keyed by TEAM, so the name alone cannot say which row
        -- a submission scored on. A left join: null for an individual round.
        left join teams t                     on t.id = part.team_id
       where cp.contest_id = ${contestId}
       order by x.id desc
       limit ${FEED_LIMIT}
    `);
    return rows.map((row) => ({
      submissionId: num(row.submission_id),
      username: row.username,
      team: row.team,
      problemCode: row.code,
      problemLabel: row.label,
      state: row.state,
      verdict: row.verdict,
      createdAt: iso(row.created_at),
    }));
  }

  /**
   * The questions nobody has answered, counted and then listed.
   *
   * `answer is null` is the whole predicate. D31 makes an announcement the
   * same row with no question and its text in `answer`, and a CHECK refuses a
   * row with neither — so `answer is null` selects questions awaiting a reply
   * and can never select an announcement.
   *
   * The list is the newest **unanswered** five, not the newest five: this
   * panel is a work queue, and a contest whose last five questions were all
   * answered while twenty sit waiting is exactly the state where showing the
   * answered ones would be worse than showing nothing.
   */
  private async clarifications(contestId: number): Promise<{
    unanswered: number;
    latest: ContestMonitorClarificationDto[];
  }> {
    const counted = await this.db.execute<{ n: string }>(sql`
      select count(*) as n
        from contest_clarifications
       where contest_id = ${contestId}
         and answer is null
    `);

    const rows = await this.db.execute<{
      id: string;
      code: string | null;
      username: string;
      question: string | null;
      created_at: Date;
    }>(sql`
      select c.id, p.code, u.username, c.question, c.created_at
        from contest_clarifications c
        join users u          on u.id = c.asked_by
        left join problems p  on p.id = c.problem_id
       where c.contest_id = ${contestId}
         and c.answer is null
       order by c.id desc
       limit ${CLARIFICATION_LIMIT}
    `);

    return {
      unanswered: num(counted[0]?.n),
      latest: rows.map((row) => ({
        id: num(row.id),
        problemCode: row.code,
        askedBy: row.username,
        question: row.question,
        createdAt: iso(row.created_at),
      })),
    };
  }

  /**
   * The judge fleet, counted rather than listed — the drill-down is
   * `/admin/dashboard`, which already lists every node with what it is
   * carrying, and duplicating that table here would be a second answer to
   * "is this judge alive".
   *
   * `JUDGE_SILENCE_SECONDS` is imported from `DashboardService` rather than
   * restated. The brief for this page said "seen in the last minute"; 90
   * seconds is judged's own rule (`PING_INTERVAL_MS × MISSED_PING_LIMIT`),
   * and a monitor that called a judge dead thirty seconds before the bridge
   * did would have organisers reporting an outage the operations page says is
   * not happening. One number, one place.
   */
  private async judges(): Promise<{ online: number; total: number }> {
    const rows = await this.db.execute<{ total: string; online: string }>(sql`
      select count(*) as total,
             count(*) filter (
               where last_seen is not null
                 and last_seen > now() - make_interval(secs => ${JUDGE_SILENCE_SECONDS}::double precision)
             ) as online
        from judge_nodes
    `);
    return { total: num(rows[0]?.total), online: num(rows[0]?.online) };
  }

  /**
   * How many of this contest's competitors have a live socket open.
   *
   * Two halves, because neither side knows the whole thing: the gateway knows
   * who is CONNECTED and cannot know which contest they are here for (D31
   * gave the contest page no socket of its own, and a participant's socket
   * watches a submission), while the database knows who holds a
   * participation and nothing about sockets. The intersection is the answer,
   * and it is a floor rather than a roster — a competitor reading a statement
   * with no socket open is not counted.
   *
   * **A TEAM's members all count** (D99). A team is one participant with ONE
   * participation, on the account of whichever member pressed Join, so
   * `contest_participations.user_id` names one person per squad and the
   * other two are invisible to it. "Participants online" is the invigilator's
   * "is the room here" number: in a team round it would have reported a third
   * of the people actually sitting the paper, and reported them leaving when
   * only the captain closed a tab. The union is over the two ways a
   * connected user competes here — they hold a row, or they are on the team
   * that holds one.
   *
   * Bounded twice over: the presence set is trimmed to a five-minute window
   * by its own store, and an empty one short-circuits before any query at
   * all, which is the state every deployment that is not mid-contest is in.
   */
  private async participantsOnline(contestId: number): Promise<number> {
    const userIds = await this.presence.recent();
    if (userIds.length === 0) return 0;
    const connected = sql`string_to_array(${userIds.join(',')}, ',')::bigint[]`;
    const rows = await this.db.execute<{ n: string }>(sql`
      select count(*) as n from (
        select part.user_id
          from contest_participations part
         where part.contest_id = ${contestId}
           and part.user_id = any(${connected})
         union
        select tm.user_id
          from contest_participations part
          join team_members tm on tm.team_id = part.team_id
         where part.contest_id = ${contestId}
           and tm.user_id = any(${connected})
      ) present
    `);
    return num(rows[0]?.n);
  }

  /**
   * How many submissions the D80 meter turned away in the last ten minutes.
   *
   * **Deployment-wide, and that is a ruling rather than an oversight.** D80
   * keys the submission meter on the USER — deliberately, because a school
   * computer room is one IP and a session is free to re-mint — so a refusal
   * carries no contest at all. Reporting it here anyway is the honest
   * trade: during a contest almost every submission in the system is that
   * contest's, and an organiser watching the number climb is watching
   * somebody's script, which is the thing the panel exists to surface.
   *
   * The purpose string is composed from `REFUSAL_PREFIX` and
   * `SUBMISSION_PURPOSE` rather than typed out, so a rename of either moves
   * this count with it instead of silently zeroing it.
   */
  private async refusals(): Promise<number> {
    const rows = await this.db.execute<{ n: string }>(sql`
      select count(*) as n
        from rate_events
       where purpose = ${`${REFUSAL_PREFIX}${SUBMISSION_PURPOSE}`}
         and created_at > now() - interval '10 minutes'
    `);
    return num(rows[0]?.n);
  }
}
