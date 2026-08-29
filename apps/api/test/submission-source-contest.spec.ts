/**
 * M3/D27 — a submission's `source` is withheld while its contest
 * participation window is still open.
 *
 * `source_access = 'solved'` is a decision about a PROBLEM: anyone holding an
 * AC on it may read other people's solutions. D23 left `source` outside the
 * freeze on the reasoning that it "is already governed by
 * `canViewSubmission`" — but that predicate has no notion of a contest, so
 * the first competitor to solve a problem could read every rival's accepted
 * C++ for the remaining hours of the contest, live.
 *
 * The rule pinned here is independent of both `source_access` and
 * `frozen_last_minutes`: every contest seeded below has NO freeze, and the
 * problem is fully open to solvers.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  contestParticipations,
  contestProblems,
  contestSubmissions,
  contests,
  submissions,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { SubmissionDetail } from '@duckoj/contracts';
import { SubmissionAccessService } from '../src/authz/submission.access.js';
import type { Actor } from '../src/authz/actor.js';
import { withTestDb } from './db.harness.js';
import {
  grantProblemRole,
  insertGradedSubmission,
  insertUser,
  seedProblemAndLanguage,
  seedProblemWithSourceAccess,
} from './submissions.fixtures.js';

const MINUTE = 60_000;
const SOURCE = 'int main(){ /* alice */ }';

function actorFor(userId: number, globalRole: Actor['globalRole'] = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

interface Seeded {
  aliceId: number;
  rivalId: number;
  organizerId: number;
  contestSubmissionId: number;
  practiceSubmissionId: number;
}

/**
 * A running-or-finished contest on a problem open to solvers, with alice's
 * contest submission and the rival's own practice AC (which is what buys the
 * rival `source_access = 'solved'` in the first place).
 *
 * `frozenLastMinutes` is 0 throughout: this rule is not the freeze.
 */
async function seedContestSource(
  db: Db,
  opts: { key: string; contestEndInMs: number },
): Promise<Seeded> {
  await seedProblemAndLanguage(db);
  const endMs = Date.now() + opts.contestEndInMs;
  const startMs = endMs - 60 * MINUTE;

  const organizer = await insertUser(db, `${opts.key}-org`);
  const alice = await insertUser(db, `${opts.key}-alice`);
  const rival = await insertUser(db, `${opts.key}-rival`);
  const problem = await seedProblemWithSourceAccess(db, {
    code: `${opts.key}-p`,
    sourceAccess: 'solved',
  });

  const [contest] = await db
    .insert(contests)
    .values({
      key: opts.key,
      name: opts.key,
      startTime: new Date(startMs),
      endTime: new Date(endMs),
      format: 'default',
      frozenLastMinutes: 0,
      visibility: 'public',
      createdBy: organizer.id,
    })
    .returning({ id: contests.id });
  const [contestProblem] = await db
    .insert(contestProblems)
    .values({
      contestId: contest!.id,
      problemId: problem.id,
      label: 'A',
      points: 100,
      partial: false,
      order: 0,
    })
    .returning({ id: contestProblems.id });
  // The contest's creator is not, by itself, anybody on the PROBLEM, so
  // `canViewSubmission` would 404 them out before D27's escape is ever
  // reached. Curator is the smallest grant that puts them in front of the
  // rule this file is about.
  await grantProblemRole(db, problem.id, organizer.id, 'curator');

  const [participation] = await db
    .insert(contestParticipations)
    .values({ contestId: contest!.id, userId: alice.id, startTime: new Date(startMs), virtual: 0 })
    .returning({ id: contestParticipations.id });

  const [language] = await db
    .select({ id: schema.languages.id })
    .from(schema.languages)
    .where(eq(schema.languages.key, 'cpp17'));
  const at = new Date(startMs + MINUTE);
  const [row] = await db
    .insert(submissions)
    .values({
      userId: alice.id,
      problemId: problem.id,
      revisionId: problem.revisionId,
      languageId: language!.id,
      source: SOURCE,
      state: 'done',
      verdict: 'AC',
      points: 100,
      maxPoints: 100,
      createdAt: at,
      judgedAt: at,
    })
    .returning({ id: submissions.id });
  await db.insert(contestSubmissions).values({
    participationId: participation!.id,
    contestProblemId: contestProblem!.id,
    submissionId: row!.id,
  });

  // The rival's own AC, made in practice — never routed into the contest, so
  // it is the control case for "a submission outside a contest is untouched".
  const practiceSubmissionId = await insertGradedSubmission(db, {
    userId: rival.id,
    problemId: problem.id,
    verdict: 'AC',
    points: 100,
    maxPoints: 100,
  });

  return {
    aliceId: alice.id,
    rivalId: rival.id,
    organizerId: organizer.id,
    contestSubmissionId: row!.id,
    practiceSubmissionId,
  };
}

describe("a contest submission's source, while the window is open", () => {
  it('is withheld from a rival who holds an AC, even though source_access is solved', async () => {
    await withTestDb(async (db) => {
      const seeded = await seedContestSource(db, { key: 'scs1', contestEndInMs: 30 * MINUTE });
      const submissionsSvc = new SubmissionAccessService(db);

      const seen = await submissionsSvc.getVisible(
        actorFor(seeded.rivalId),
        seeded.contestSubmissionId,
      );
      // Still a 200 with the whole submission — only the source is withheld,
      // and a flag says so rather than leaving `null` to read as "empty".
      expect(seen.source).toBeNull();
      expect(seen.sourceHidden).toBe(true);
      // The contest has no freeze, so nothing else is masked.
      expect(seen.verdict).toBe('AC');
      expect(seen.frozen).toBe(false);
      expect(SubmissionDetail.safeParse(seen).success).toBe(true);
    });
  }, 120_000);

  it('is shown to the submitter, the contest creator and an admin throughout', async () => {
    await withTestDb(async (db) => {
      const seeded = await seedContestSource(db, { key: 'scs2', contestEndInMs: 30 * MINUTE });
      const submissionsSvc = new SubmissionAccessService(db);

      for (const actor of [
        actorFor(seeded.aliceId),
        actorFor(seeded.organizerId),
        actorFor(seeded.rivalId, 'admin'),
      ]) {
        const seen = await submissionsSvc.getVisible(actor, seeded.contestSubmissionId);
        expect(seen.source).toBe(SOURCE);
        expect(seen.sourceHidden).toBe(false);
      }
    });
  }, 120_000);

  it('is released once the participation window has closed', async () => {
    await withTestDb(async (db) => {
      const seeded = await seedContestSource(db, { key: 'scs3', contestEndInMs: -MINUTE });
      const submissionsSvc = new SubmissionAccessService(db);

      const seen = await submissionsSvc.getVisible(
        actorFor(seeded.rivalId),
        seeded.contestSubmissionId,
      );
      expect(seen.source).toBe(SOURCE);
      expect(seen.sourceHidden).toBe(false);
    });
  }, 120_000);

  it('leaves a practice submission on the same problem untouched', async () => {
    await withTestDb(async (db) => {
      const seeded = await seedContestSource(db, { key: 'scs4', contestEndInMs: 30 * MINUTE });
      const submissionsSvc = new SubmissionAccessService(db);

      // Alice holds an AC on the problem too, so she reaches the rival's
      // practice submission by the same `solved` clause the rival used.
      const seen = await submissionsSvc.getVisible(
        actorFor(seeded.aliceId),
        seeded.practiceSubmissionId,
      );
      expect(seen.sourceHidden).toBe(false);
      expect(seen.source).not.toBeNull();
    });
  }, 120_000);
});
