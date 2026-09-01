import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  contestParticipations,
  contestProblems,
  contestSeats,
  contestSubmissions,
  contests,
  organizations,
  problemRevisions,
  problems,
  submissions,
  teamMembers,
  teams,
} from '../src/schema/guarded.js';
import { schema, type Db } from '../src/index.js';
import { withTestDb } from './harness.js';

/**
 * What the foreign keys of this deployment actually SAY, asserted against a
 * real migrated database.
 *
 * Every `ON DELETE` rule in this schema is a product ruling: `restrict` on
 * `contest_submissions.contest_problem_id` is migration 0016's "a scoreboard
 * must never vanish silently", `cascade` from `contest_participations` to
 * `contest_seats` is D104's "a seat cannot outlive the row it names", and
 * `set null` on `grading_jobs.judge_node_id` is D68's "retiring a judge must
 * not delete grading history". None of that is visible in a diff of one
 * table, and B-31 found a rule that had been quietly untrue since 0016
 * shipped — the RESTRICT it added was reachable around, through a cascade in
 * a third table.
 *
 * So the inventory below is the whole map, in one literal. Changing a delete
 * rule now means editing this list, which is the point: an `ON DELETE` is a
 * decision about history (D11), and no such decision should be possible to
 * make by accident in a schema file.
 */
const FOREIGN_KEYS: Readonly<Record<string, string>> = {
  'access_tokens.user_id -> users': 'CASCADE',
  'contest_clarifications.answered_by -> users': 'NO ACTION',
  'contest_clarifications.asked_by -> users': 'CASCADE',
  'contest_clarifications.contest_id -> contests': 'CASCADE',
  'contest_clarifications.problem_id -> problems': 'NO ACTION',
  'contest_orgs.contest_id -> contests': 'CASCADE',
  'contest_orgs.org_id -> organizations': 'CASCADE',
  // RESTRICT since B-31's migration 0040. `contest_submissions` cascades from
  // its participation, so while this was `cascade` a `DELETE FROM contests`
  // walked contests -> participations -> contest submissions and emptied the
  // scoreboard BEFORE 0016's restrict on `contest_problem_id` was ever
  // evaluated. A contest that anybody entered is history and is refused.
  'contest_participations.contest_id -> contests': 'RESTRICT',
  'contest_participations.team_id -> teams': 'RESTRICT',
  'contest_participations.user_id -> users': 'CASCADE',
  'contest_problem_solvers.contest_problem_id -> contest_problems': 'CASCADE',
  'contest_problem_solvers.user_id -> users': 'CASCADE',
  'contest_problem_stats.contest_problem_id -> contest_problems': 'CASCADE',
  'contest_problems.contest_id -> contests': 'CASCADE',
  'contest_problems.problem_id -> problems': 'NO ACTION',
  'contest_seats.contest_id -> contests': 'CASCADE',
  'contest_seats.participation_id -> contest_participations': 'CASCADE',
  'contest_seats.user_id -> users': 'CASCADE',
  'contest_submissions.contest_problem_id -> contest_problems': 'RESTRICT',
  'contest_submissions.participation_id -> contest_participations': 'CASCADE',
  'contest_submissions.submission_id -> submissions': 'CASCADE',
  'contests.created_by -> users': 'NO ACTION',
  'grading_jobs.judge_node_id -> judge_nodes': 'SET NULL',
  'grading_jobs.revision_id -> problem_revisions': 'NO ACTION',
  'grading_jobs.submission_id -> submissions': 'CASCADE',
  'language_driver_keys.language_id -> languages': 'CASCADE',
  'notifications.user_id -> users': 'CASCADE',
  'one_time_tokens.user_id -> users': 'CASCADE',
  'org_join_requests.decided_by -> users': 'NO ACTION',
  'org_join_requests.org_id -> organizations': 'CASCADE',
  'org_join_requests.user_id -> users': 'CASCADE',
  'org_members.org_id -> organizations': 'CASCADE',
  'org_members.user_id -> users': 'CASCADE',
  'package_files.package_hash -> packages': 'CASCADE',
  'problem_comments.author_id -> users': 'CASCADE',
  'problem_comments.parent_id -> problem_comments': 'CASCADE',
  'problem_comments.problem_id -> problems': 'CASCADE',
  // D154. Both CASCADE: an override says "on THIS problem, THIS language gets
  // these limits", so it is meaningless once either side is gone. Nothing
  // else points at it and no history is lost — a graded submission keeps its
  // own limits in `submission_cases`, not here.
  'problem_language_limits.language_id -> languages': 'CASCADE',
  'problem_language_limits.problem_id -> problems': 'CASCADE',
  'problem_members.problem_id -> problems': 'CASCADE',
  'problem_members.user_id -> users': 'CASCADE',
  'problem_orgs.org_id -> organizations': 'CASCADE',
  'problem_orgs.problem_id -> problems': 'CASCADE',
  'problem_revisions.created_by -> users': 'NO ACTION',
  'problem_revisions.package_hash -> packages': 'NO ACTION',
  'problem_revisions.problem_id -> problems': 'CASCADE',
  'problem_set_items.problem_id -> problems': 'NO ACTION',
  'problem_set_items.set_id -> problem_sets': 'CASCADE',
  'problem_sets.created_by -> users': 'NO ACTION',
  'problem_sets.org_id -> organizations': 'CASCADE',
  'problem_tags.problem_id -> problems': 'CASCADE',
  'problem_tags.tag_id -> tags': 'RESTRICT',
  // B-31's migration 0040. The one id column in this schema that carried no
  // foreign key at all, and it decides which package grades a submission:
  // `SubmissionAccessService.create` loads the revision by this id alone and
  // never re-checks whose problem it belongs to. COMPOSITE, so it states the
  // fact that matters — the current revision is a revision OF THIS PROBLEM —
  // rather than only "some revision exists". `MATCH SIMPLE` leaves a NULL
  // (an unpublished problem) unconstrained, which is the intended state.
  'problems.id,current_revision_id -> problem_revisions': 'NO ACTION',
  'problems.created_by -> users': 'NO ACTION',
  'rating_event.contest_id -> contests': 'CASCADE',
  'rating_event.user_id -> users': 'CASCADE',
  'sessions.user_id -> users': 'CASCADE',
  'similarity_runs.contest_id -> contests': 'CASCADE',
  'similarity_runs.requested_by -> users': 'SET NULL',
  'submission_cases.submission_id -> submissions': 'CASCADE',
  'submissions.language_id -> languages': 'NO ACTION',
  'submissions.problem_id -> problems': 'NO ACTION',
  'submissions.revision_id -> problem_revisions': 'NO ACTION',
  'submissions.user_id -> users': 'CASCADE',
  'team_members.team_id -> teams': 'CASCADE',
  'team_members.user_id -> users': 'CASCADE',
  'teams.created_by -> users': 'NO ACTION',
  'teams.org_id -> organizations': 'CASCADE',
  'totp_credentials.user_id -> users': 'CASCADE',
  'totp_recovery_codes.user_id -> users': 'CASCADE',
};

/**
 * Every uniqueness rule the product assumes, as the index definition
 * Postgres reports.
 *
 * A rule the code believes and the database does not is the shape of bug
 * D104 and D99 each cost a loop to find: the application check is the thing
 * that races, and the index is the thing that decides. Case folding is half
 * the list on purpose — `lower()` is what makes `Anh` and `anh` one account,
 * one contest key, one org.
 */
const UNIQUE_INDEXES: Readonly<Record<string, string>> = {
  users_username_lower_idx: 'CREATE UNIQUE INDEX users_username_lower_idx ON public.users USING btree (lower(username))',
  users_email_lower_idx: 'CREATE UNIQUE INDEX users_email_lower_idx ON public.users USING btree (lower(email))',
  contests_key_lower_idx: 'CREATE UNIQUE INDEX contests_key_lower_idx ON public.contests USING btree (lower(key))',
  problems_code_lower_idx: 'CREATE UNIQUE INDEX problems_code_lower_idx ON public.problems USING btree (lower(code))',
  organizations_slug_lower_idx:
    'CREATE UNIQUE INDEX organizations_slug_lower_idx ON public.organizations USING btree (lower(slug))',
  teams_org_slug_lower_idx:
    'CREATE UNIQUE INDEX teams_org_slug_lower_idx ON public.teams USING btree (org_id, lower(slug))',
  problem_sets_org_slug_lower_idx:
    'CREATE UNIQUE INDEX problem_sets_org_slug_lower_idx ON public.problem_sets USING btree (org_id, lower(slug))',
  // One participation per (person, contest, attempt) — D99, with `virtual` in
  // the key so a replay is a separate row (D36).
  contest_participations_identity_idx:
    'CREATE UNIQUE INDEX contest_participations_identity_idx ON public.contest_participations USING btree (contest_id, user_id, virtual)',
  // One participation per team per contest, partial because `team_id` is null
  // on every individual row (D99).
  contest_participations_team_idx:
    'CREATE UNIQUE INDEX contest_participations_team_idx ON public.contest_participations USING btree (team_id, contest_id) WHERE (team_id IS NOT NULL)',
  // One seat per person per contest — D104's backstop for the rule two
  // application checks in two transactions cannot hold.
  contest_seats_contest_id_user_id_pk:
    'CREATE UNIQUE INDEX contest_seats_contest_id_user_id_pk ON public.contest_seats USING btree (contest_id, user_id)',
  // At most one published revision per problem (partial), and one revision per
  // (problem, version).
  problem_revisions_one_published_idx:
    "CREATE UNIQUE INDEX problem_revisions_one_published_idx ON public.problem_revisions USING btree (problem_id) WHERE (state = 'published'::revision_state)",
  problem_revisions_version_idx:
    'CREATE UNIQUE INDEX problem_revisions_version_idx ON public.problem_revisions USING btree (problem_id, version)',
  // The composite foreign key on `problems.current_revision_id` needs a
  // unique index on the columns it references (migration 0040).
  problem_revisions_problem_identity_idx:
    'CREATE UNIQUE INDEX problem_revisions_problem_identity_idx ON public.problem_revisions USING btree (problem_id, id)',
  // One contest problem per (contest, problem), one submission per contest
  // submission, one solver row per (contest problem, person).
  contest_problems_problem_idx:
    'CREATE UNIQUE INDEX contest_problems_problem_idx ON public.contest_problems USING btree (contest_id, problem_id)',
  contest_submissions_submission_idx:
    'CREATE UNIQUE INDEX contest_submissions_submission_idx ON public.contest_submissions USING btree (submission_id)',
  contest_problem_solvers_contest_problem_id_user_id_pk:
    'CREATE UNIQUE INDEX contest_problem_solvers_contest_problem_id_user_id_pk ON public.contest_problem_solvers USING btree (contest_problem_id, user_id)',
  // One rating event per (contest, person), and at most one pending join
  // request per (org, person).
  rating_event_identity_idx:
    'CREATE UNIQUE INDEX rating_event_identity_idx ON public.rating_event USING btree (contest_id, user_id)',
  org_join_requests_pending_idx:
    "CREATE UNIQUE INDEX org_join_requests_pending_idx ON public.org_join_requests USING btree (org_id, user_id) WHERE (state = 'pending'::join_request_state)",
  // Credentials: a session or access token is FOUND by its hash, so the hash
  // being unique is the lookup's correctness, not a nicety.
  sessions_token_hash_idx: 'CREATE UNIQUE INDEX sessions_token_hash_idx ON public.sessions USING btree (token_hash)',
  access_tokens_token_hash_idx:
    'CREATE UNIQUE INDEX access_tokens_token_hash_idx ON public.access_tokens USING btree (token_hash)',
  one_time_tokens_hash_idx:
    'CREATE UNIQUE INDEX one_time_tokens_hash_idx ON public.one_time_tokens USING btree (token_hash)',
  judge_nodes_token_idx: 'CREATE UNIQUE INDEX judge_nodes_token_idx ON public.judge_nodes USING btree (token_hash)',
  judge_nodes_name_idx: 'CREATE UNIQUE INDEX judge_nodes_name_idx ON public.judge_nodes USING btree (name)',
  languages_key_idx: 'CREATE UNIQUE INDEX languages_key_idx ON public.languages USING btree (key)',
  tags_slug_idx: 'CREATE UNIQUE INDEX tags_slug_idx ON public.tags USING btree (slug)',
  // One row per (submission, attempt, group, case) — the fence's guarantee
  // that a re-graded attempt does not double the case list.
  submission_cases_identity_idx:
    'CREATE UNIQUE INDEX submission_cases_identity_idx ON public.submission_cases USING btree (submission_id, attempt, group_index, case_index)',
  org_members_org_id_user_id_pk:
    'CREATE UNIQUE INDEX org_members_org_id_user_id_pk ON public.org_members USING btree (org_id, user_id)',
  team_members_team_id_user_id_pk:
    'CREATE UNIQUE INDEX team_members_team_id_user_id_pk ON public.team_members USING btree (team_id, user_id)',
};

interface Fixture {
  userId: number;
  problemId: number;
  revisionId: number;
  contestId: number;
  contestProblemId: number;
  participationId: number;
  submissionId: number;
  languageId: number;
}

/** One competitor, one problem, one contest, one submission on the board. */
async function seed(db: Db): Promise<Fixture> {
  const [user] = await db
    .insert(schema.users)
    .values({ username: 'ri-anh', email: 'ri-anh@example.com', passwordHash: 'x', displayName: 'Anh' })
    .returning({ id: schema.users.id });
  await db.insert(schema.packages).values({ hash: 'ri-package', sizeBytes: 1, fileCount: 1 });
  await db
    .insert(schema.packageFiles)
    .values({ packageHash: 'ri-package', path: 'manifest.json', sizeBytes: 1, sha256: 'aa' });
  const [problem] = await db
    .insert(problems)
    .values({ code: 'RI1', name: 'Bài một', statement: 's', createdBy: user!.id })
    .returning({ id: problems.id });
  const [revision] = await db
    .insert(problemRevisions)
    .values({
      problemId: problem!.id,
      version: 1,
      packageHash: 'ri-package',
      state: 'published',
      createdBy: user!.id,
      timeMs: 1000,
      memoryKb: 65536,
      testCount: 1,
      totalPoints: 100,
      checkerKind: 'std',
    })
    .returning({ id: problemRevisions.id });
  await db
    .update(problems)
    .set({ currentRevisionId: revision!.id })
    .where(eq(problems.id, problem!.id));
  const [language] = await db
    .insert(schema.languages)
    .values({ key: 'ri-cpp', name: 'C++', extension: 'cpp' })
    .returning({ id: schema.languages.id });
  const [contest] = await db
    .insert(contests)
    .values({
      key: 'ri-contest',
      name: 'Thi thử',
      startTime: new Date(),
      endTime: new Date(Date.now() + 3_600_000),
      format: 'ioi',
      createdBy: user!.id,
    })
    .returning({ id: contests.id });
  const [contestProblem] = await db
    .insert(contestProblems)
    .values({ contestId: contest!.id, problemId: problem!.id, label: 'A', points: 100, order: 1 })
    .returning({ id: contestProblems.id });
  const [participation] = await db
    .insert(contestParticipations)
    .values({ contestId: contest!.id, userId: user!.id, startTime: new Date() })
    .returning({ id: contestParticipations.id });
  await db
    .insert(contestSeats)
    .values({ contestId: contest!.id, userId: user!.id, participationId: participation!.id });
  const [submission] = await db
    .insert(submissions)
    .values({
      userId: user!.id,
      problemId: problem!.id,
      revisionId: revision!.id,
      languageId: language!.id,
      source: 'int main(){}',
      state: 'done',
      verdict: 'AC',
    })
    .returning({ id: submissions.id });
  await db.insert(contestSubmissions).values({
    participationId: participation!.id,
    contestProblemId: contestProblem!.id,
    submissionId: submission!.id,
  });
  return {
    userId: user!.id,
    problemId: problem!.id,
    revisionId: revision!.id,
    contestId: contest!.id,
    contestProblemId: contestProblem!.id,
    participationId: participation!.id,
    submissionId: submission!.id,
    languageId: language!.id,
  };
}

/**
 * A statement expected to violate a constraint, run inside a SAVEPOINT so its
 * abort does not poison the enclosing rollback transaction (the pattern
 * `tags.spec.ts` established).
 */
async function expectRefused(db: Db, run: (tx: Db) => Promise<unknown>): Promise<void> {
  await expect(
    db.transaction(async (tx) => {
      await run(tx as unknown as Db);
    }),
  ).rejects.toThrow();
}

describe('referential integrity', () => {
  it('every foreign key carries the delete rule this repo decided on', async () => {
    await withTestDb(async (db) => {
      const rows = await db.execute<{ key: string; rule: string }>(sql`
        select src.relname || '.'
               || (select string_agg(a.attname, ',' order by k.ord)
                     from unnest(c.conkey) with ordinality k(att, ord)
                     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.att)
               || ' -> ' || tgt.relname as key,
               case c.confdeltype
                 when 'a' then 'NO ACTION' when 'r' then 'RESTRICT' when 'c' then 'CASCADE'
                 when 'n' then 'SET NULL' when 'd' then 'SET DEFAULT' end as rule
          from pg_constraint c
          join pg_class src on src.oid = c.conrelid
          join pg_class tgt on tgt.oid = c.confrelid
         where c.contype = 'f'
      `);
      const actual = Object.fromEntries(rows.map((row) => [row.key, row.rule]));
      expect(actual).toEqual(FOREIGN_KEYS);
    });
  });

  it('every uniqueness rule the product assumes exists as an index', async () => {
    await withTestDb(async (db) => {
      const rows = await db.execute<{ name: string; definition: string }>(sql`
        select i.relname as name, pg_get_indexdef(ix.indexrelid) as definition
          from pg_index ix
          join pg_class i on i.oid = ix.indexrelid
          join pg_class t on t.oid = ix.indrelid
          join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
         where ix.indisunique
      `);
      const byName = new Map(rows.map((row) => [row.name, row.definition]));
      for (const [name, definition] of Object.entries(UNIQUE_INDEXES)) {
        expect(byName.get(name), `missing unique index ${name}`).toBe(definition);
      }
    });
  });

  it('refuses to delete a contest anybody entered, so a scoreboard cannot vanish', async () => {
    await withTestDb(async (db) => {
      const fixture = await seed(db);
      // Migration 0016 made `contest_submissions.contest_problem_id` RESTRICT
      // for exactly this reason, and until 0040 it was reachable AROUND:
      // `contest_participations` cascaded from the contest and
      // `contest_submissions` cascaded from the participation, so the children
      // were gone before the RESTRICT was ever evaluated and the DELETE
      // succeeded silently. D11 keeps grading history forever.
      await expectRefused(db, (tx) => tx.delete(contests).where(eq(contests.id, fixture.contestId)));
      const [remaining] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(contestSubmissions);
      expect(remaining!.n).toBe(1);
    });
  });

  it('still deletes a contest nobody entered', async () => {
    await withTestDb(async (db) => {
      const fixture = await seed(db);
      const [empty] = await db
        .insert(contests)
        .values({
          key: 'ri-empty',
          name: 'Chưa ai vào',
          startTime: new Date(),
          endTime: new Date(Date.now() + 3_600_000),
          format: 'ioi',
          createdBy: fixture.userId,
        })
        .returning({ id: contests.id });
      await db.delete(contests).where(eq(contests.id, empty!.id));
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(contests)
        .where(eq(contests.id, empty!.id));
      expect(row!.n).toBe(0);
    });
  });

  it('refuses to point a problem at another problem’s revision', async () => {
    await withTestDb(async (db) => {
      const fixture = await seed(db);
      const [other] = await db
        .insert(problems)
        .values({ code: 'RI2', name: 'Bài hai', statement: 's', createdBy: fixture.userId })
        .returning({ id: problems.id });
      const [otherRevision] = await db
        .insert(problemRevisions)
        .values({
          problemId: other!.id,
          version: 1,
          packageHash: 'ri-package',
          state: 'published',
          createdBy: fixture.userId,
          timeMs: 1000,
          memoryKb: 65536,
          testCount: 1,
          totalPoints: 100,
          checkerKind: 'std',
        })
        .returning({ id: problemRevisions.id });
      // `SubmissionAccessService.create` reads the revision by this id alone —
      // it never re-checks whose problem it belongs to — so a crossed pointer
      // grades one problem's submissions against another's package.
      await expectRefused(db, (tx) =>
        tx
          .update(problems)
          .set({ currentRevisionId: otherRevision!.id })
          .where(eq(problems.id, fixture.problemId)),
      );
    });
  });

  it('leaves an unpublished problem’s null current revision alone', async () => {
    await withTestDb(async (db) => {
      const fixture = await seed(db);
      await db
        .update(problems)
        .set({ currentRevisionId: null })
        .where(eq(problems.id, fixture.problemId));
      const [row] = await db
        .select({ current: problems.currentRevisionId })
        .from(problems)
        .where(eq(problems.id, fixture.problemId));
      expect(row!.current).toBeNull();
    });
  });

  it('refuses to delete a contest problem that has been submitted to (migration 0016)', async () => {
    await withTestDb(async (db) => {
      const fixture = await seed(db);
      await expectRefused(db, (tx) =>
        tx.delete(contestProblems).where(eq(contestProblems.id, fixture.contestProblemId)),
      );
    });
  });

  it('refuses to disband a team that has competed, and cascades its roster otherwise', async () => {
    await withTestDb(async (db) => {
      const fixture = await seed(db);
      const [org] = await db
        .insert(organizations)
        .values({ slug: 'ri-school', name: 'Trường' })
        .returning({ id: organizations.id });
      const [team] = await db
        .insert(teams)
        .values({ orgId: org!.id, slug: 'doi-1', name: 'Đội 1', createdBy: fixture.userId })
        .returning({ id: teams.id });
      await db.insert(teamMembers).values({ teamId: team!.id, userId: fixture.userId });
      // Unentered: the roster cascades away with the team (D99).
      await db.delete(teams).where(eq(teams.id, team!.id));
      const [members] = await db.select({ n: sql<number>`count(*)::int` }).from(teamMembers);
      expect(members!.n).toBe(0);

      const [competed] = await db
        .insert(teams)
        .values({ orgId: org!.id, slug: 'doi-2', name: 'Đội 2', createdBy: fixture.userId })
        .returning({ id: teams.id });
      const [second] = await db
        .insert(schema.users)
        .values({ username: 'ri-binh', email: 'ri-binh@example.com', passwordHash: 'x', displayName: 'Bình' })
        .returning({ id: schema.users.id });
      await db.insert(teamMembers).values({ teamId: competed!.id, userId: second!.id });
      await db.insert(contestParticipations).values({
        contestId: fixture.contestId,
        userId: second!.id,
        teamId: competed!.id,
        startTime: new Date(),
      });
      // Entered: RESTRICT, because deleting the team would delete a contest's
      // results. `TeamAccessService.remove` turns this into a 409.
      await expectRefused(db, (tx) => tx.delete(teams).where(eq(teams.id, competed!.id)));
    });
  });

  it('takes a seat with the participation it names, and never the other way round (D104)', async () => {
    await withTestDb(async (db) => {
      const fixture = await seed(db);
      await db.delete(contestSubmissions);
      await db
        .delete(contestParticipations)
        .where(eq(contestParticipations.id, fixture.participationId));
      const [seats] = await db.select({ n: sql<number>`count(*)::int` }).from(contestSeats);
      expect(seats!.n).toBe(0);
    });
  });

  it('keeps grading history when a judge node is retired (D68)', async () => {
    await withTestDb(async (db) => {
      const fixture = await seed(db);
      const [node] = await db
        .insert(schema.judgeNodes)
        .values({ name: 'ri-judge', tokenHash: 'ri-hash', driver: 'dmoj' })
        .returning({ id: schema.judgeNodes.id });
      const [job] = await db
        .insert(schema.gradingJobs)
        .values({
          submissionId: fixture.submissionId,
          revisionId: fixture.revisionId,
          packageHash: 'ri-package',
          state: 'done',
          judgeNodeId: node!.id,
        })
        .returning({ id: schema.gradingJobs.id });
      await db.delete(schema.judgeNodes).where(eq(schema.judgeNodes.id, node!.id));
      const [row] = await db
        .select({ judgeNodeId: schema.gradingJobs.judgeNodeId })
        .from(schema.gradingJobs)
        .where(eq(schema.gradingJobs.id, job!.id));
      expect(row!.judgeNodeId).toBeNull();
    });
  });
});
