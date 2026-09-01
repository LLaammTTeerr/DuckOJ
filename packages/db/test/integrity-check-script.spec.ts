/**
 * `scripts/integrity-check.ts` — the audit that asks the database whether the
 * facts spanning two tables are still true (B-31).
 *
 * Driven as a SUBPROCESS, like `org-import-script.spec.ts` and
 * `bootstrap-admin.spec.ts` drive their neighbours and for the same reason:
 * the thing under test is the command an operator types during an incident,
 * including the exit code a runbook branches on.
 *
 * The property worth pinning is not "the script runs". It is that EVERY check
 * in the list actually catches the thing it names — a check whose SQL is
 * subtly wrong reports a clean database forever, which is worse than no check
 * at all because somebody will trust it. So the fixture below plants one
 * deliberate violation of each, over a database that satisfies every foreign
 * key: that is the whole point of these checks, since anything a foreign key
 * could have caught is already impossible.
 */
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrations, type Db } from '../src/index.js';

const execFileAsync = promisify(execFile);

// Same podman shim as harness.ts — see its comment.
if (!process.env.DOCKER_HOST) {
  const podmanSocket = `/run/user/${process.getuid?.() ?? 1000}/podman/podman.sock`;
  if (!existsSync('/var/run/docker.sock') && existsSync(podmanSocket)) {
    process.env.DOCKER_HOST = `unix://${podmanSocket}`;
  }
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const script = join(repoRoot, 'scripts', 'integrity-check.ts');

let container: StartedPostgreSqlContainer | undefined;

afterAll(async () => {
  await container?.stop().catch(() => undefined);
  container = undefined;
}, 30_000);

interface Run {
  code: number;
  stdout: string;
}

async function runScript(url: string): Promise<Run> {
  try {
    const { stdout } = await execFileAsync('node', ['--import', 'tsx', script, '--url', url], { cwd: repoRoot });
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '' };
  }
}

/** Check ids reported as FAIL, in the script's own output format. */
function failed(stdout: string): Set<string> {
  const ids = new Set<string>();
  for (const line of stdout.split('\n')) {
    const match = /^FAIL \[\w+\] ([\w-]+):/.exec(line);
    if (match?.[1]) ids.add(match[1]);
  }
  return ids;
}

/**
 * A database in which every foreign key holds and every check has exactly one
 * thing to find. Written as SQL with explicit ids because the point is the
 * shape of the rows, and a drizzle builder would bury it.
 */
async function plantOneOfEach(db: Db): Promise<void> {
  await db.execute(sql`
    insert into users (id, username, email, password_hash, display_name, rating) values
      (1,'ic-anh','ic-anh@example.com','x','Anh',null),
      (2,'ic-binh','ic-binh@example.com','x','Bình',null),
      (3,'ic-cuong','ic-cuong@example.com','x','Cường',1500),
      (4,'ic-dung','ic-dung@example.com','x','Dũng',null);

    insert into packages (hash, size_bytes, file_count) values ('ic-pkg',1,1), ('ic-empty',1,0);
    insert into package_files (package_hash, path, size_bytes, sha256) values ('ic-pkg','manifest.json',1,'aa');

    insert into problems (id, code, name, statement, created_by) values
      (1,'IC1','Bài 1','s',1), (2,'IC2','Bài 2','s',1), (3,'IC3','Bài 3','s',1);
    insert into problem_revisions
      (id, problem_id, version, package_hash, state, created_by, time_ms, memory_kb, test_count, total_points, checker_kind)
    values
      (1,1,1,'ic-pkg','published',1,1000,65536,1,100,'std'),
      (2,2,1,'ic-pkg','published',1,1000,65536,1,100,'std'),
      -- published, but its package holds no files: nothing can materialise it.
      (3,3,1,'ic-empty','published',1,1000,65536,1,100,'std');
    update problems set current_revision_id = 1 where id = 1;
    update problems set current_revision_id = 2 where id = 2;
    update problems set current_revision_id = 3 where id = 3;

    -- id 901, not 1: migration 0042 seeds the catalogue, so the low ids are
    -- taken. Pinned rather than serial because the submissions below name it.
    insert into languages (id, key, name, extension) values (901,'ic-cpp','C++','cpp');

    insert into contests (id, key, name, start_time, end_time, format, created_by, is_rated) values
      (1,'ic-c1','Kỳ 1', now(), now() + interval '1 hour','ioi',1,false),
      (2,'ic-c2','Kỳ 2', now(), now() + interval '1 hour','ioi',1,false);
    insert into contest_problems (id, contest_id, problem_id, label, points, "order") values
      (1,1,1,'A',100,1), (2,2,2,'A',100,1);

    insert into organizations (id, slug, name) values (1,'ic-truong','Trường');
    insert into org_members (org_id, user_id) values (1,1);
    insert into teams (id, org_id, slug, name, created_by) values (1,1,'doi-1','Đội 1',1), (2,1,'doi-2','Đội 2',1);
    -- On a roster, off the organization's: removing an org member leaves this.
    insert into team_members (team_id, user_id) values (1,2), (2,3);

    insert into contest_participations (id, contest_id, user_id, start_time, virtual, team_id) values
      (1,1,1,now(),0,null),
      (2,1,2,now(),1,null),      -- a replay …
      (3,1,3,now(),0,null),      -- live, and never seated
      (4,2,4,now(),-5,null),     -- a virtual value no code has a meaning for
      (5,1,4,now(),0,2);         -- team row whose captain is not on the roster

    insert into contest_seats (contest_id, user_id, participation_id) values
      (1,1,1),
      (1,2,2),   -- … seated anyway
      (2,2,1),   -- seat says contest 2, the participation says contest 1
      (2,3,4);   -- seated on somebody else's individual row

    insert into submissions (id, user_id, problem_id, revision_id, language_id, source, state, verdict) values
      (1,1,1,1,901,'x','done','AC'),
      (2,1,1,2,901,'x','done','WA'),   -- graded against problem 2's revision
      (3,2,2,2,901,'x','done','WA'),
      (4,2,2,2,901,'x','done','WA');
    insert into contest_submissions (id, participation_id, contest_problem_id, submission_id) values
      (1,1,1,1),
      (2,1,2,3),   -- participation is in contest 1, the contest problem is in contest 2
      (3,1,1,4);   -- submission is for problem 2, the contest problem is problem 1

    insert into grading_jobs (id, kind, submission_id, revision_id, package_hash, state) values
      (1,'submission',1,2,'ic-pkg','done'),      -- job revision is not the submission's
      (2,'submission',null,1,'ic-pkg','queued'); -- a submission job with no submission

    -- A solver who never landed an AC here; and submission 1's AC author, who
    -- is missing from the set.
    insert into contest_problem_solvers (contest_problem_id, user_id) values (1,2);
    -- Counters that agree with nothing: not the aggregate, not the set.
    insert into contest_problem_stats (contest_problem_id, submitted, accepted, solvers, pending) values (1,99,99,99,99);

    insert into rating_event
      (contest_id, user_id, rating_before, rd_before, volatility_before, rating_after, rd_after, volatility_after, rank)
    values (1,1,1500,350,0.06,1520,340,0.06,1);

    insert into org_join_requests (org_id, user_id, state) values (1,1,'pending');
    -- D165's derived column. A submission with no case rows summarises to the
    -- empty list, so 1 and 3 are correct; 2 is left NULL, which is a terminal
    -- submission the fold must re-read case rows for on every fold forever; and
    -- 4 carries case rows its stored summary does not describe (sumPoints 40
    -- where the rows sum to 20) — a scoreboard scoring it twice over.
    update submissions set subtask_summary = '[]'::jsonb where id in (1,3);
    insert into submission_cases (submission_id, attempt, group_index, case_index, verdict, time_ms, memory_kb, points, max_points) values
      (4,1,0,0,'AC',1,1,20,20),
      (4,1,0,1,'WA',1,1,0,20);
    update submissions set subtask_summary =
      '[{"batch":0,"minPoints":0,"maxTotal":20,"sumPoints":40,"sumTotal":40}]'::jsonb where id = 4;

    insert into notifications (user_id, kind, payload) values (1,'submission_judged','{"submissionId": 999999}'::jsonb);
    insert into similarity_runs (contest_id, status, threshold, pairs) values
      (1,'finished',0.8,'{"pairs":[{"submissionId":999999,"otherSubmissionId":999998}]}'::jsonb);
  `);
}

describe('scripts/integrity-check.ts', () => {
  it('reports every planted violation and exits 1, then exits 0 once they are gone', async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    const url = container.getConnectionUri();
    await runMigrations(url);
    const { db, close } = createDb(url);
    try {
      // A migrated but empty database has nothing to find, and says so.
      const clean = await runScript(url);
      expect(clean.stdout).toContain('0 with violations');
      expect(clean.code).toBe(0);

      await plantOneOfEach(db);
      const dirty = await runScript(url);
      const reported = failed(dirty.stdout);
      expect([...reported].sort()).toEqual(
        [
          'accepted-submission-without-solver',
          'contest-problem-stats-drift',
          'contest-submission-cross-contest',
          'contest-submission-problem-mismatch',
          'grading-job-revision-not-of-submission',
          'live-participation-without-seat',
          'notification-payload-dangling-id',
          'participation-virtual-out-of-range',
          'pending-org-join-request-for-member',
          'published-revision-without-package',
          'rated-user-without-rating-event',
          'rating-event-on-unrated-contest',
          'seat-holder-not-on-row',
          'seat-on-virtual-participation',
          'seat-participation-contest-mismatch',
          'similarity-pairs-dangling-submission',
          'solver-without-accepted-submission',
          'stats-solvers-not-set-size',
          'submission-job-kind-without-submission',
          'submission-revision-not-of-problem',
          'submission-summary-disagrees-with-cases',
          'submission-summary-missing-on-terminal',
          'team-member-not-in-org',
          'team-member-without-seat',
          'team-participation-captain-not-member',
        ].sort(),
      );
      // The exit code is what a runbook branches on, so it is asserted rather
      // than assumed from the text above it.
      expect(dirty.code).toBe(1);
    } finally {
      await close();
    }
  }, 180_000);
});
