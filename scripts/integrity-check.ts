/**
 * Data-integrity audit: the invariants no foreign key states.
 *
 * A foreign key can only say "this id exists". Everything a schema believes
 * BEYOND that — a seat's participation is for the seat's own contest, a
 * cached counter equals the aggregate it caches, a solver actually has an
 * `AC` — is enforced by application code alone, and application code is what
 * drifts. This script asks the database directly, so a drift is a number an
 * operator can read rather than a bug report from a competitor.
 *
 * Two transports, ONE list of checks:
 *
 *   corepack pnpm tsx scripts/integrity-check.ts --url postgres://...
 *   corepack pnpm tsx scripts/integrity-check.ts --live [--container NAME]
 *
 * `--live` shells out to `podman exec ... psql` because the deployed Postgres
 * publishes no host port (`docker-compose.yml`'s `postgres` service has no
 * `ports:` — only the compose network reaches it), so no client on the host
 * can dial it. Both transports run every statement with
 * `default_transaction_read_only` on: this is an audit, and a script pointed
 * at production must not be able to write even if a check is later edited
 * carelessly.
 *
 * Exit codes: 0 clean, 1 violations found, 2 could not run.
 */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createDb } from '@duckoj/db';
import { sql } from 'drizzle-orm';

const run = promisify(execFile);

/** psql's column separator here — three characters no `detail` string builds. */
const FIELD_SEPARATOR = '~|~';

type Severity = 'high' | 'medium' | 'low';

interface Check {
  readonly id: string;
  readonly severity: Severity;
  /** What a non-zero count MEANS — printed beside the number. */
  readonly what: string;
  /**
   * A query selecting one `detail` text column per VIOLATING row. Zero rows
   * is a healthy database; the runner wraps it to count and sample, so this
   * must never end in a semicolon.
   */
  readonly sql: string;
}

/**
 * Orphans and invariants, in the order a reader should meet them: rows whose
 * two foreign keys disagree, facts that span two tables, then the cached
 * counters and the ids that live in jsonb where no key can reach them.
 */
export const CHECKS: readonly Check[] = [
  {
    id: 'seat-participation-contest-mismatch',
    severity: 'high',
    what: 'contest_seats whose participation belongs to a DIFFERENT contest (D104: a seat names the row the person competes on)',
    sql: `select 'contest=' || s.contest_id || ' user=' || s.user_id || ' participation=' || p.id || ' (contest ' || p.contest_id || ')' as detail
            from contest_seats s
            join contest_participations p on p.id = s.participation_id
           where p.contest_id <> s.contest_id`,
  },
  {
    id: 'seat-on-virtual-participation',
    severity: 'high',
    what: 'contest_seats pointing at a virtual/spectator participation (D104 seats LIVE rows only)',
    sql: `select 'contest=' || s.contest_id || ' user=' || s.user_id || ' virtual=' || p.virtual as detail
            from contest_seats s
            join contest_participations p on p.id = s.participation_id
           where p.virtual <> 0`,
  },
  {
    id: 'seat-holder-not-on-row',
    severity: 'high',
    what: 'contest_seats whose holder is neither the participation owner nor a member of its team',
    sql: `select 'contest=' || s.contest_id || ' user=' || s.user_id || ' participation=' || p.id as detail
            from contest_seats s
            join contest_participations p on p.id = s.participation_id
           where p.user_id <> s.user_id
             and not exists (select 1 from team_members tm
                              where tm.team_id = p.team_id and tm.user_id = s.user_id)`,
  },
  {
    id: 'live-participation-without-seat',
    severity: 'medium',
    what: 'live individual participations holding no seat (D104: every live row is seated; rows the 0038 backfill skipped land here)',
    sql: `select 'contest=' || p.contest_id || ' user=' || p.user_id || ' participation=' || p.id as detail
            from contest_participations p
           where p.virtual = 0
             and p.team_id is null
             and not exists (select 1 from contest_seats s where s.participation_id = p.id and s.user_id = p.user_id)`,
  },
  {
    id: 'team-member-without-seat',
    severity: 'medium',
    what: 'members of a competing team roster with no seat on that contest (D104: enterTeam seats every member)',
    sql: `select 'contest=' || p.contest_id || ' team=' || p.team_id || ' user=' || tm.user_id as detail
            from contest_participations p
            join team_members tm on tm.team_id = p.team_id
           where p.virtual = 0
             and p.team_id is not null
             and not exists (select 1 from contest_seats s
                              where s.participation_id = p.id and s.user_id = tm.user_id)`,
  },
  {
    id: 'contest-submission-cross-contest',
    severity: 'high',
    what: 'contest_submissions whose participation and contest problem belong to different contests (two foreign keys, neither can state this)',
    sql: `select 'contest_submission=' || cs.id || ' participation contest=' || p.contest_id || ' problem contest=' || cp.contest_id as detail
            from contest_submissions cs
            join contest_participations p on p.id = cs.participation_id
            join contest_problems cp on cp.id = cs.contest_problem_id
           where p.contest_id <> cp.contest_id`,
  },
  {
    id: 'contest-submission-problem-mismatch',
    severity: 'high',
    what: 'contest_submissions attaching a submission to a contest problem for a DIFFERENT problem',
    sql: `select 'contest_submission=' || cs.id || ' submission problem=' || s.problem_id || ' contest problem=' || cp.problem_id as detail
            from contest_submissions cs
            join submissions s on s.id = cs.submission_id
            join contest_problems cp on cp.id = cs.contest_problem_id
           where s.problem_id <> cp.problem_id`,
  },
  {
    id: 'submission-revision-not-of-problem',
    severity: 'high',
    what: 'submissions graded against a revision of another problem (submissions.problem_id and .revision_id are two independent foreign keys)',
    sql: `select 'submission=' || s.id || ' problem=' || s.problem_id || ' revision problem=' || r.problem_id as detail
            from submissions s
            join problem_revisions r on r.id = s.revision_id
           where r.problem_id <> s.problem_id`,
  },
  {
    id: 'grading-job-revision-not-of-submission',
    severity: 'medium',
    what: 'grading_jobs whose revision is not the revision of the submission they grade',
    sql: `select 'job=' || j.id || ' submission=' || j.submission_id || ' job revision=' || j.revision_id || ' submission revision=' || s.revision_id as detail
            from grading_jobs j
            join submissions s on s.id = j.submission_id
           where j.revision_id <> s.revision_id`,
  },
  {
    id: 'solver-without-accepted-submission',
    severity: 'high',
    what: 'contest_problem_solvers rows with no AC contest submission behind them (D100: the set IS the AC facts)',
    sql: `select 'contest_problem=' || sv.contest_problem_id || ' user=' || sv.user_id as detail
            from contest_problem_solvers sv
           where not exists (
                 select 1 from contest_submissions cs
                   join submissions s on s.id = cs.submission_id
                   join contest_participations p on p.id = cs.participation_id
                  where cs.contest_problem_id = sv.contest_problem_id
                    and p.user_id = sv.user_id
                    and s.verdict = 'AC')`,
  },
  {
    id: 'accepted-submission-without-solver',
    severity: 'high',
    what: 'AC contest submissions whose author is missing from contest_problem_solvers (the other direction of the same set)',
    sql: `select 'contest_problem=' || cs.contest_problem_id || ' user=' || p.user_id as detail
            from contest_submissions cs
            join submissions s on s.id = cs.submission_id
            join contest_participations p on p.id = cs.participation_id
           where s.verdict = 'AC'
             and not exists (select 1 from contest_problem_solvers sv
                              where sv.contest_problem_id = cs.contest_problem_id
                                and sv.user_id = p.user_id)
           group by cs.contest_problem_id, p.user_id`,
  },
  {
    id: 'contest-problem-stats-drift',
    severity: 'high',
    what: 'contest_problem_stats disagreeing with the aggregate they cache (the D100 reconcile — B-28 fixed one writer that could drift them)',
    sql: `with truth as (
            select cp.id as contest_problem_id,
                   count(cs.id) as submitted,
                   count(*) filter (where s.verdict = 'AC') as accepted,
                   count(distinct part.user_id) filter (where s.verdict = 'AC') as solvers,
                   count(*) filter (where cs.id is not null and s.state not in ('done', 'errored')) as pending
              from contest_problems cp
              left join contest_submissions cs      on cs.contest_problem_id = cp.id
              left join submissions s               on s.id = cs.submission_id
              left join contest_participations part on part.id = cs.participation_id
             group by cp.id)
          select 'contest_problem=' || t.contest_problem_id
                 || ' stored(' || st.submitted || ',' || st.accepted || ',' || st.solvers || ',' || st.pending || ')'
                 || ' truth(' || t.submitted || ',' || t.accepted || ',' || t.solvers || ',' || t.pending || ')' as detail
            from truth t
            join contest_problem_stats st on st.contest_problem_id = t.contest_problem_id
           where st.submitted <> t.submitted
              or st.accepted  <> t.accepted
              or st.solvers   <> t.solvers
              or st.pending   <> t.pending`,
  },
  {
    id: 'stats-solvers-not-set-size',
    severity: 'high',
    what: 'contest_problem_stats.solvers disagreeing with the size of contest_problem_solvers it caches',
    sql: `select 'contest_problem=' || st.contest_problem_id || ' cached=' || st.solvers
                 || ' set=' || (select count(*) from contest_problem_solvers sv where sv.contest_problem_id = st.contest_problem_id) as detail
            from contest_problem_stats st
           where st.solvers <> (select count(*) from contest_problem_solvers sv
                                 where sv.contest_problem_id = st.contest_problem_id)`,
  },
  {
    id: 'participation-virtual-out-of-range',
    severity: 'medium',
    what: 'contest_participations.virtual below -1 — only -1 (spectator), 0 (live) and n>0 (the n-th replay) have a meaning',
    sql: `select 'participation=' || id || ' virtual=' || virtual as detail
            from contest_participations where virtual < -1`,
  },
  {
    id: 'rating-event-on-unrated-contest',
    severity: 'medium',
    what: 'rating_event rows for a contest whose is_rated is false (the fold only ever reads rated contests, so these can never be replayed)',
    sql: `select 'contest=' || c.id || ' key=' || c.key || ' events=' || count(*) as detail
            from rating_event re join contests c on c.id = re.contest_id
           where c.is_rated = false
           group by c.id, c.key`,
  },
  {
    id: 'rated-user-without-rating-event',
    severity: 'medium',
    what: 'users carrying a rating with no rating_event behind it (the events are the audit trail a replay must reproduce)',
    sql: `select 'user=' || u.id || ' rating=' || u.rating as detail
            from users u
           where u.rating is not null
             and not exists (select 1 from rating_event re where re.user_id = u.id)`,
  },
  {
    id: 'published-revision-without-package',
    severity: 'high',
    what: 'published problem_revisions whose package holds no files (a package row with no package_files cannot be materialised by a judge)',
    sql: `select 'revision=' || r.id || ' problem=' || r.problem_id || ' package=' || r.package_hash as detail
            from problem_revisions r
           where r.state = 'published'
             and not exists (select 1 from package_files f where f.package_hash = r.package_hash)`,
  },
  {
    id: 'team-member-not-in-org',
    severity: 'medium',
    what: "team_members who are no longer on the roster of the team's organization (removing an org member leaves their team rows behind)",
    sql: `select 'team=' || t.id || ' org=' || t.org_id || ' user=' || tm.user_id as detail
            from team_members tm
            join teams t on t.id = tm.team_id
           where not exists (select 1 from org_members m where m.org_id = t.org_id and m.user_id = tm.user_id)`,
  },
  {
    id: 'team-participation-captain-not-member',
    severity: 'medium',
    what: 'team participations whose user_id (the captain) is not on the team roster',
    sql: `select 'participation=' || p.id || ' team=' || p.team_id || ' captain=' || p.user_id as detail
            from contest_participations p
           where p.team_id is not null
             and not exists (select 1 from team_members tm where tm.team_id = p.team_id and tm.user_id = p.user_id)`,
  },
  {
    id: 'pending-org-join-request-for-member',
    severity: 'low',
    what: 'pending org_join_requests from people already on the roster',
    sql: `select 'org=' || r.org_id || ' user=' || r.user_id as detail
            from org_join_requests r
            join org_members m on m.org_id = r.org_id and m.user_id = r.user_id
           where r.state = 'pending'`,
  },
  {
    id: 'notification-payload-dangling-id',
    severity: 'low',
    what: 'notifications whose jsonb payload names a contest, problem or submission that no longer exists (jsonb holds no foreign keys)',
    sql: `select 'notification=' || n.id || ' kind=' || n.kind || ' payload=' || n.payload::text as detail
            from notifications n
           where (n.payload ? 'submissionId'
                  and not exists (select 1 from submissions s where s.id = (n.payload->>'submissionId')::bigint))
              or (n.payload ? 'contestId'
                  and not exists (select 1 from contests c where c.id = (n.payload->>'contestId')::bigint))
              or (n.payload ? 'problemId'
                  and not exists (select 1 from problems p where p.id = (n.payload->>'problemId')::bigint))`,
  },
  {
    id: 'similarity-pairs-dangling-submission',
    severity: 'low',
    what: 'similarity_runs whose stored pairs name a submission that no longer exists (jsonb again)',
    sql: `select 'run=' || r.id || ' submission=' || x.sid as detail
            from similarity_runs r
            cross join lateral (
              select (value->>'submissionId')::bigint as sid
                from jsonb_array_elements(case when jsonb_typeof(r.pairs->'pairs') = 'array'
                                               then r.pairs->'pairs' else '[]'::jsonb end)
               union all
              select (value->>'otherSubmissionId')::bigint
                from jsonb_array_elements(case when jsonb_typeof(r.pairs->'pairs') = 'array'
                                               then r.pairs->'pairs' else '[]'::jsonb end)
            ) x
           where x.sid is not null
             and not exists (select 1 from submissions s where s.id = x.sid)`,
  },
  {
    id: 'submission-job-kind-without-submission',
    severity: 'low',
    what: "grading_jobs of kind 'submission' carrying no submission_id (the column is nullable only for a job kind that does not exist yet)",
    sql: `select 'job=' || id as detail from grading_jobs where kind = 'submission' and submission_id is null`,
  },
];

export interface IntegrityResult {
  readonly id: string;
  readonly severity: Severity;
  readonly what: string;
  readonly count: number;
  readonly sample: string;
}

/** Count and sample in ONE round trip, so both transports parse one line. */
function wrap(check: Check): string {
  return `with v as (${check.sql})
          select (select count(*) from v)::text as n,
                 coalesce((select string_agg(detail, ' | ') from (select detail from v limit 5) t), '') as sample`;
}

type Transport = (statement: string) => Promise<readonly [string, string]>;

async function livePsql(container: string, database: string, user: string): Promise<Transport> {
  // Prove the container answers before running twenty checks against it.
  await run('podman', ['exec', container, 'psql', '-U', user, '-d', database, '-Atc', 'select 1']);
  return async (statement) => {
    const { stdout } = await run(
      'podman',
      [
        'exec', container, 'psql', '-U', user, '-d', database,
        '-At', '-F', FIELD_SEPARATOR, '-v', 'ON_ERROR_STOP=1',
        // Two `-c`s run in ONE session, so the read-only default set by the
        // first governs the second. Not a promise in a comment: an accidental
        // write in a check errors instead of touching production.
        '-c', 'set default_transaction_read_only = on',
        '-c', statement,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const line = stdout.split('\n').filter((row) => row.includes(FIELD_SEPARATOR)).at(-1) ?? '';
    const [count, sample] = line.split(FIELD_SEPARATOR);
    return [count ?? '0', sample ?? ''] as const;
  };
}

function urlTransport(url: string): { transport: Transport; close: () => Promise<void> } {
  // `createDb` rather than `postgres` directly: this package depends on
  // `@duckoj/db`, not on the driver, and one place builds a connection.
  const { db, close } = createDb(url);
  const transport: Transport = async (statement) => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql.raw('set transaction read only'));
      return tx.execute<{ n: string; sample: string }>(sql.raw(statement));
    });
    const row = rows[0];
    return [row?.n ?? '0', row?.sample ?? ''] as const;
  };
  return { transport, close };
}

/** Every check against one already-open transport — what the spec drives. */
export async function runChecks(transport: Transport): Promise<IntegrityResult[]> {
  const results: IntegrityResult[] = [];
  for (const check of CHECKS) {
    const [count, sample] = await transport(wrap(check));
    results.push({ id: check.id, severity: check.severity, what: check.what, count: Number(count), sample });
  }
  return results;
}

/** Every check against a plain connection URL — what a test or CI calls. */
export async function checkDatabase(url: string): Promise<IntegrityResult[]> {
  const opened = urlTransport(url);
  try {
    return await runChecks(opened.transport);
  } finally {
    await opened.close();
  }
}

interface Options {
  url: string | undefined;
  live: boolean;
  container: string;
  database: string;
  user: string;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    url: undefined,
    live: false,
    container: 'duckoj_postgres_1',
    database: 'duckoj',
    user: 'duckoj',
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--live') options.live = true;
    else if (arg === '--url') options.url = argv[++index];
    else if (arg === '--container') options.container = argv[++index] ?? options.container;
    else if (arg === '--database') options.database = argv[++index] ?? options.database;
    else if (arg === '--user') options.user = argv[++index] ?? options.user;
  }
  if (!options.live && options.url === undefined) options.url = process.env.DATABASE_URL;
  return options;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  let results: IntegrityResult[];
  if (options.live) {
    results = await runChecks(await livePsql(options.container, options.database, options.user));
  } else if (options.url !== undefined && options.url !== '') {
    results = await checkDatabase(options.url);
  } else {
    console.error(
      'integrity-check: pass --url <DATABASE_URL> (or set DATABASE_URL), or --live for the deployed database',
    );
    return 2;
  }

  const failed = results.filter((result) => result.count > 0);
  for (const result of results) {
    console.log(`${result.count === 0 ? 'ok  ' : 'FAIL'} [${result.severity}] ${result.id}: ${String(result.count)}`);
    if (result.count > 0) {
      console.log(`       ${result.what}`);
      console.log(`       e.g. ${result.sample}`);
    }
  }
  const bySeverity = (severity: Severity): string =>
    String(failed.filter((result) => result.severity === severity).length);
  console.log(
    `\n${String(results.length)} checks, ${String(failed.length)} with violations ` +
      `(high ${bySeverity('high')}, medium ${bySeverity('medium')}, low ${bySeverity('low')})`,
  );
  return failed.length === 0 ? 0 : 1;
}

// `import.meta.main` is not available on Node 22, and this module is imported
// by its own spec (which must get `CHECKS` without the CLI running) — so run
// only when this file IS the entry point.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main();
}
