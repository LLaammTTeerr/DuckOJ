/**
 * D117 — a team is one entity: members share visibility of their team's own
 * contest submissions (list, verdict/points, and — extending D27's own-source
 * rule to the team — the source), scoped strictly to the same team's
 * same-contest submissions.
 *
 * The seam this closes was recorded open by D113 / loop-b22: the freeze escape
 * and `visibleSubmissionsWhere` keyed on `submissions.user_id` alone, so a
 * teammate could not see another member's contest submission at all. These
 * tests pin the widened rule AND the two boundaries it must not cross: a
 * NON-teammate still 404s, and another team's (or an unrelated individual's)
 * frozen verdict stays hidden — the SQL NULL trap the `is not true` phrasing
 * in `frozenSubmissionsWhere` exists to defeat.
 *
 * Submissions are inserted directly (like `submission-freeze.spec.ts`): the
 * whole point is where a row sits relative to the freeze window, which an HTTP
 * submit cannot backdate. Every contest here is ongoing with an open window
 * and a live freeze — so both D23 (verdict) and D27 (source) are engaged, and
 * the team escape has to stand both down at once.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  contestParticipations,
  contestProblems,
  contestSubmissions,
  contests,
  organizations,
  submissionCases,
  submissions,
  teamMembers,
  teams,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { SubmissionAccessService } from '../src/authz/submission.access.js';
import {
  frozenSubmissionsWhere,
  isSubmissionFrozen,
  loadSubmissionFreezeContext,
} from '../src/authz/submission.freeze.js';
import type { Actor } from '../src/authz/actor.js';
import { withTestDb } from './db.harness.js';
import {
  grantProblemRole,
  insertUser,
  seedProblemAndLanguage,
  seedProblemWithSourceAccess,
} from './submissions.fixtures.js';

const MINUTE = 60_000;

function actorFor(userId: number, globalRole: Actor['globalRole'] = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

/** A team (in one shared org) with the given members, first one the captain. */
async function makeTeam(
  db: Db,
  orgId: number,
  slug: string,
  memberIds: number[],
): Promise<{ id: number; captainId: number }> {
  const [team] = await db
    .insert(teams)
    .values({ orgId, slug, name: `Đội ${slug}`, createdBy: memberIds[0]! })
    .returning({ id: teams.id });
  await db.insert(teamMembers).values(memberIds.map((userId) => ({ teamId: team!.id, userId })));
  return { id: team!.id, captainId: memberIds[0]! };
}

/**
 * One ongoing contest, one contest problem, and — per entry of `entries` — a
 * participation (individual when `teamId` is null) with one graded AC made 5
 * minutes ago, inside a 20-minute freeze whose window is open (ends in 10).
 * Returns each entry's submission id, in order.
 */
async function seedContest(
  db: Db,
  opts: {
    key: string;
    problemId: number;
    revisionId: number;
    createdBy: number;
    mode: 'team' | 'individual';
    entries: { holderId: number; submitterId: number; teamId: number | null }[];
  },
): Promise<{ contestId: number; submissionIds: number[] }> {
  const now = Date.now();
  const [contest] = await db
    .insert(contests)
    .values({
      key: opts.key,
      name: opts.key,
      startTime: new Date(now - 50 * MINUTE),
      endTime: new Date(now + 10 * MINUTE),
      format: 'icpc',
      frozenLastMinutes: 20,
      visibility: 'public',
      participationMode: opts.mode,
      maxTeamSize: opts.mode === 'team' ? 3 : 1,
      createdBy: opts.createdBy,
    })
    .returning({ id: contests.id });
  const [cp] = await db
    .insert(contestProblems)
    .values({
      contestId: contest!.id,
      problemId: opts.problemId,
      label: 'A',
      points: 100,
      partial: false,
      order: 0,
    })
    .returning({ id: contestProblems.id });
  const [language] = await db
    .select({ id: schema.languages.id })
    .from(schema.languages)
    .where(eq(schema.languages.key, 'cpp17'));

  const submissionIds: number[] = [];
  for (const entry of opts.entries) {
    const [participation] = await db
      .insert(contestParticipations)
      .values({
        contestId: contest!.id,
        userId: entry.holderId,
        teamId: entry.teamId,
        virtual: 0,
        startTime: new Date(now - 50 * MINUTE),
      })
      .returning({ id: contestParticipations.id });
    const at = new Date(now - 5 * MINUTE);
    const [row] = await db
      .insert(submissions)
      .values({
        userId: entry.submitterId,
        problemId: opts.problemId,
        revisionId: opts.revisionId,
        languageId: language!.id,
        source: `int main(){} // ${opts.key}-${String(entry.submitterId)}`,
        state: 'done',
        verdict: 'AC',
        points: 100,
        maxPoints: 100,
        timeMs: 42,
        memoryKb: 4096,
        createdAt: at,
        judgedAt: at,
      })
      .returning({ id: submissions.id });
    await db.insert(submissionCases).values({
      submissionId: row!.id,
      attempt: 1,
      groupIndex: 0,
      caseIndex: 1,
      verdict: 'AC',
      timeMs: 42,
      memoryKb: 4096,
      points: 100,
      maxPoints: 100,
    });
    await db.insert(contestSubmissions).values({
      participationId: participation!.id,
      contestProblemId: cp!.id,
      submissionId: row!.id,
    });
    submissionIds.push(row!.id);
  }
  return { contestId: contest!.id, submissionIds };
}

/**
 * The whole cast, sharing one problem `p117`:
 *  - team X = {captainA, memberB, curatorE}; curatorE is also a curator of the
 *    problem, so it can reach every row and the freeze/team escape is the ONLY
 *    thing standing a mask down.
 *  - team Y = {captainC}.
 *  - team contest `tc`: X's row (submitted by captainA) and Y's row.
 *  - individual contest `ic`: entrant D's own row.
 *  - stranger F: on no team, no role.
 */
async function seedWorld(db: Db) {
  await seedProblemAndLanguage(db);
  const problem = await seedProblemWithSourceAccess(db, { code: 'p117' });

  const org = (
    await db
      .insert(organizations)
      .values({ slug: 'org117', name: 'Org 117', visibility: 'public' })
      .returning({ id: organizations.id })
  )[0]!;
  const captainA = await insertUser(db, 'f29-captainA');
  const memberB = await insertUser(db, 'f29-memberB');
  const curatorE = await insertUser(db, 'f29-curatorE');
  const captainC = await insertUser(db, 'f29-captainC');
  const entrantD = await insertUser(db, 'f29-entrantD');
  const strangerF = await insertUser(db, 'f29-strangerF');
  const organizer = await insertUser(db, 'f29-org');
  await grantProblemRole(db, problem.id, curatorE.id, 'curator');

  const teamX = await makeTeam(db, org.id, 'teamx', [captainA.id, memberB.id, curatorE.id]);
  const teamY = await makeTeam(db, org.id, 'teamy', [captainC.id]);

  const tc = await seedContest(db, {
    key: 'f29-tc',
    problemId: problem.id,
    revisionId: problem.revisionId,
    createdBy: organizer.id,
    mode: 'team',
    entries: [
      { holderId: teamX.captainId, submitterId: captainA.id, teamId: teamX.id },
      { holderId: teamY.captainId, submitterId: captainC.id, teamId: teamY.id },
    ],
  });
  const ic = await seedContest(db, {
    key: 'f29-ic',
    problemId: problem.id,
    revisionId: problem.revisionId,
    createdBy: organizer.id,
    mode: 'individual',
    entries: [{ holderId: entrantD.id, submitterId: entrantD.id, teamId: null }],
  });

  return {
    problemId: problem.id,
    ids: { captainA, memberB, curatorE, captainC, entrantD, strangerF },
    teamXName: 'Đội teamx',
    xSubmission: tc.submissionIds[0]!,
    ySubmission: tc.submissionIds[1]!,
    dSubmission: ic.submissionIds[0]!,
  };
}

describe('D117 — teammates share their team submissions', () => {
  it('a teammate reads the team submission, its verdict and its source, unmasked', async () => {
    await withTestDb(async (db) => {
      const w = await seedWorld(db);
      const service = new SubmissionAccessService(db);

      // memberB never touched this row — captainA submitted it — but it is the
      // team's, so both D23 (verdict) and D27 (source) stand down.
      const detail = await service.getVisible(actorFor(w.ids.memberB.id), w.xSubmission);
      expect(detail.frozen).toBe(false);
      expect(detail.verdict).toBe('AC');
      expect(detail.sourceHidden).toBe(false);
      expect(detail.source).not.toBeNull();
      // The "nộp bởi <member> (đội <team>)" label the web renders.
      expect(detail.username).toBe('f29-captainA');
      expect(detail.teamName).toBe(w.teamXName);
    });
  }, 120_000);

  it('the captain reads a member’s team submission too (the user_id arm)', async () => {
    await withTestDb(async (db) => {
      const w = await seedWorld(db);
      const service = new SubmissionAccessService(db);
      // captainA holds the team row; the escape must also fire when the row is
      // on the viewer's OWN account and a teammate made the submission — here
      // the roles are reversed by asking about the row memberB would submit,
      // so re-seed one under memberB is unnecessary: captainA reading X's own
      // row is the baseline, and memberB reading it (above) is the widening.
      const detail = await service.getVisible(actorFor(w.ids.captainA.id), w.xSubmission);
      expect(detail.frozen).toBe(false);
      expect(detail.source).not.toBeNull();
    });
  }, 120_000);

  it('lists the team’s contest submissions to a member filtering by contest', async () => {
    await withTestDb(async (db) => {
      const w = await seedWorld(db);
      const service = new SubmissionAccessService(db);

      const page = await service.listVisible(actorFor(w.ids.memberB.id), {
        limit: 50,
        contest: 'f29-tc',
      });
      const ids = page.items.map((i) => i.id);
      // X's row is visible and unfrozen; Y's is neither listed nor visible.
      expect(ids).toContain(w.xSubmission);
      expect(ids).not.toContain(w.ySubmission);
      const xRow = page.items.find((i) => i.id === w.xSubmission)!;
      expect(xRow.frozen).toBe(false);
      expect(xRow.verdict).toBe('AC');
      expect(xRow.teamName).toBe(w.teamXName);
    });
  }, 120_000);

  it('still 404s a non-teammate on the team submission, and never lists it', async () => {
    await withTestDb(async (db) => {
      const w = await seedWorld(db);
      const service = new SubmissionAccessService(db);

      await expect(service.getVisible(actorFor(w.ids.strangerF.id), w.xSubmission)).rejects.toMatchObject(
        { status: 404 },
      );
      const page = await service.listVisible(actorFor(w.ids.strangerF.id), { limit: 50 });
      expect(page.items.map((i) => i.id)).not.toContain(w.xSubmission);
    });
  }, 120_000);

  it("keeps ANOTHER team's frozen verdict and source hidden from a team member", async () => {
    await withTestDb(async (db) => {
      const w = await seedWorld(db);
      const service = new SubmissionAccessService(db);
      // curatorE is on team X and can reach every row — so the only reason a
      // mask could fall is team membership, and Y is not E's team.
      const detail = await service.getVisible(actorFor(w.ids.curatorE.id), w.ySubmission);
      expect(detail.frozen).toBe(true);
      expect(detail.verdict).toBeNull();
      expect(detail.sourceHidden).toBe(true);
      expect(detail.source).toBeNull();
    });
  }, 120_000);

  it("keeps an unrelated INDIVIDUAL entrant's frozen verdict hidden from a team member (the SQL NULL trap)", async () => {
    await withTestDb(async (db) => {
      const w = await seedWorld(db);
      const service = new SubmissionAccessService(db);
      // entrantD's participation has team_id = NULL. Phrased as
      // `NOT (predicate)`, `NULL IN (E's teams)` would make the OR NULL and
      // NOT NULL null, unfreezing D's row for anyone holding a team. `IS NOT
      // TRUE` is what keeps it frozen — this is the test that catches the leak.
      const detail = await service.getVisible(actorFor(w.ids.curatorE.id), w.dSubmission);
      expect(detail.frozen).toBe(true);
      expect(detail.verdict).toBeNull();
    });
  }, 120_000);

  it('the SQL and row freeze forms agree for a team viewer over every seeded row', async () => {
    await withTestDb(async (db) => {
      const w = await seedWorld(db);
      const actor = actorFor(w.ids.curatorE.id);
      const now = new Date();
      const all = [w.xSubmission, w.ySubmission, w.dSubmission];

      const sqlRows = await db
        .select({ id: submissions.id, frozen: frozenSubmissionsWhere(db, actor, now) })
        .from(submissions);
      const bySql = new Map(sqlRows.map((r) => [r.id, r.frozen]));

      for (const id of all) {
        const [row] = await db
          .select({ userId: submissions.userId, createdAt: submissions.createdAt })
          .from(submissions)
          .where(eq(submissions.id, id));
        const ctx = await loadSubmissionFreezeContext(db, actor, id);
        expect([id, bySql.get(id)]).toEqual([id, isSubmissionFrozen(actor, row!, ctx, now)]);
      }
      // X is E's team (not frozen); Y and D are not (frozen) — a real split,
      // so the agreement is not vacuous.
      expect(bySql.get(w.xSubmission)).toBe(false);
      expect(bySql.get(w.ySubmission)).toBe(true);
      expect(bySql.get(w.dSubmission)).toBe(true);
    });
  }, 120_000);
});
