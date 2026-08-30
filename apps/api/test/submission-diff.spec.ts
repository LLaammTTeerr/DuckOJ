/**
 * D111 — `GET /submissions/{id}/previous` and `GET /submissions/{id}/diff`.
 *
 * The diff is server-computed and both sides are visibility-gated by the SAME
 * predicate the `source` field uses (`getVisible`): it must never become a way
 * to read a rival's live contest source that D27 withholds. These integration
 * tests pin the four cases the brief names — own previous found, cross-user
 * refused, masked-during-freeze refused, and identical vs changed — against a
 * real database.
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
import { SubmissionDiff } from '@duckoj/contracts';
import { SubmissionAccessService } from '../src/authz/submission.access.js';
import type { Actor } from '../src/authz/actor.js';
import { withTestDb } from './db.harness.js';
import {
  insertGradedSubmission,
  insertUser,
  seedProblemAndLanguage,
  seedProblemWithSourceAccess,
} from './submissions.fixtures.js';

const MINUTE = 60_000;

function actorFor(userId: number, globalRole: Actor['globalRole'] = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

async function languageId(db: Db, key: string): Promise<number> {
  const [row] = await db.select({ id: schema.languages.id }).from(schema.languages).where(eq(schema.languages.key, key));
  return row!.id;
}

/** Inserts a submission with an explicit source (and optional language/time). */
async function insertSource(
  db: Db,
  opts: { userId: number; problemId: number; revisionId: number; source: string; languageId: number; at?: Date },
): Promise<number> {
  const [row] = await db
    .insert(submissions)
    .values({
      userId: opts.userId,
      problemId: opts.problemId,
      revisionId: opts.revisionId,
      languageId: opts.languageId,
      source: opts.source,
      state: 'done',
      verdict: 'AC',
      points: 100,
      maxPoints: 100,
      ...(opts.at ? { createdAt: opts.at, judgedAt: opts.at } : {}),
    })
    .returning({ id: submissions.id });
  return row!.id;
}

describe('GET /submissions/{id}/previous', () => {
  it("finds the caller's most recent earlier submission to the same problem", async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const p = await seedProblemWithSourceAccess(db, { code: 'prev1' });
      const alice = await insertUser(db, 'prev1-alice');
      const cpp = await languageId(db, 'cpp17');

      const first = await insertSource(db, { userId: alice.id, problemId: p.id, revisionId: p.revisionId, source: 'v1', languageId: cpp });
      const second = await insertSource(db, { userId: alice.id, problemId: p.id, revisionId: p.revisionId, source: 'v2', languageId: cpp });
      const third = await insertSource(db, { userId: alice.id, problemId: p.id, revisionId: p.revisionId, source: 'v3', languageId: cpp });

      const svc = new SubmissionAccessService(db);
      expect((await svc.getPrevious(actorFor(alice.id), third)).previousId).toBe(second);
      expect((await svc.getPrevious(actorFor(alice.id), second)).previousId).toBe(first);
      // No earlier attempt.
      expect((await svc.getPrevious(actorFor(alice.id), first)).previousId).toBeNull();
    });
  }, 120_000);

  it('prefers the same language, falling back to any', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const p = await seedProblemWithSourceAccess(db, { code: 'prev2' });
      const alice = await insertUser(db, 'prev2-alice');
      const cpp = await languageId(db, 'cpp17');
      const [py] = await db
        .insert(schema.languages)
        .values({ key: 'py3', name: 'Python 3', extension: 'py' })
        .returning();

      const oldCpp = await insertSource(db, { userId: alice.id, problemId: p.id, revisionId: p.revisionId, source: 'c1', languageId: cpp });
      // A more recent python attempt sits between the cpp attempts.
      await insertSource(db, { userId: alice.id, problemId: p.id, revisionId: p.revisionId, source: 'p1', languageId: py!.id });
      const newCpp = await insertSource(db, { userId: alice.id, problemId: p.id, revisionId: p.revisionId, source: 'c2', languageId: cpp });

      const svc = new SubmissionAccessService(db);
      // Diffing the newest cpp attempt prefers the earlier cpp one, skipping
      // the more-recent-but-different-language python attempt.
      expect((await svc.getPrevious(actorFor(alice.id), newCpp)).previousId).toBe(oldCpp);
    });
  }, 120_000);

  it("404s when {id} itself is not visible to the caller", async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const p = await seedProblemWithSourceAccess(db, { code: 'prev3', sourceAccess: 'private', visibility: 'private' });
      const owner = await insertUser(db, 'prev3-writer');
      const stranger = await insertUser(db, 'prev3-stranger');
      const id = await insertGradedSubmission(db, { userId: owner.id, problemId: p.id, verdict: 'AC', points: 100, maxPoints: 100 });

      const svc = new SubmissionAccessService(db);
      await expect(svc.getPrevious(actorFor(stranger.id), id)).rejects.toMatchObject({ status: 404 });
    });
  }, 120_000);
});

describe('GET /submissions/{id}/diff', () => {
  it('reports no hunks for two identical own attempts and hunks for a change', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const p = await seedProblemWithSourceAccess(db, { code: 'diff1' });
      const alice = await insertUser(db, 'diff1-alice');
      const cpp = await languageId(db, 'cpp17');
      const same = 'int main(){\n  return 0;\n}\n';
      const a = await insertSource(db, { userId: alice.id, problemId: p.id, revisionId: p.revisionId, source: same, languageId: cpp });
      const b = await insertSource(db, { userId: alice.id, problemId: p.id, revisionId: p.revisionId, source: same, languageId: cpp });
      const changed = 'int main(){\n  return 1;\n}\n';
      const c = await insertSource(db, { userId: alice.id, problemId: p.id, revisionId: p.revisionId, source: changed, languageId: cpp });

      const svc = new SubmissionAccessService(db);
      const identical = await svc.diff(actorFor(alice.id), b, a);
      expect(identical.hunks).toEqual([]);
      expect(identical.base.source).toBe(same);
      expect(identical.against.source).toBe(same);
      expect(SubmissionDiff.safeParse(identical).success).toBe(true);

      const diff = await svc.diff(actorFor(alice.id), c, a);
      const ops = diff.hunks.flatMap((h) => h.lines.map((l) => `${l.op}:${l.text.trim()}`));
      // old=`a` (return 0) -> new=`c` (return 1): the changed line is one
      // removed and one added.
      expect(ops).toContain('removed:return 0;');
      expect(ops).toContain('added:return 1;');
    });
  }, 120_000);

  it("refuses a rival's submission whose source the caller cannot read (404)", async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      // A private problem the rival is not a member of: `getVisible` 404s the
      // whole submission, so the diff never reaches the source.
      const p = await seedProblemWithSourceAccess(db, { code: 'diff2', sourceAccess: 'private', visibility: 'private' });
      const owner = await insertUser(db, 'diff2-writer');
      const rival = await insertUser(db, 'diff2-rival');
      const cpp = await languageId(db, 'cpp17');
      const ownerSub = await insertSource(db, { userId: owner.id, problemId: p.id, revisionId: p.revisionId, source: 'secret', languageId: cpp });
      const rivalSub = await insertSource(db, { userId: rival.id, problemId: p.id, revisionId: p.revisionId, source: 'mine', languageId: cpp });

      const svc = new SubmissionAccessService(db);
      await expect(svc.diff(actorFor(rival.id), ownerSub, rivalSub)).rejects.toMatchObject({ status: 404 });
    });
  }, 120_000);

  it("refuses a contest submission whose source is masked during the freeze window (D27, 404)", async () => {
    await withTestDb(async (db) => {
      const seeded = await seedContestDiff(db, { key: 'diff3', endInMs: 30 * MINUTE, frozenLastMinutes: 10 });
      const svc = new SubmissionAccessService(db);
      // The rival holds an AC (source_access solved) and could read a practice
      // solution — but the contest window is open, so D27 masks alice's
      // source, and the diff must refuse rather than leak it.
      await expect(
        svc.diff(actorFor(seeded.rivalId), seeded.aliceContestSub, seeded.rivalPractice),
      ).rejects.toMatchObject({ status: 404 });
      // Sanity: the same predicate that masks it here shows it to alice.
      const own = await svc.diff(actorFor(seeded.aliceId), seeded.aliceContestSub, seeded.aliceEarlier);
      expect(own.base.source).not.toBeNull();
    });
  }, 120_000);

  it('refuses a diff across two different problems (422)', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const p1 = await seedProblemWithSourceAccess(db, { code: 'diff4a' });
      const p2 = await seedProblemWithSourceAccess(db, { code: 'diff4b' });
      const alice = await insertUser(db, 'diff4-alice');
      const cpp = await languageId(db, 'cpp17');
      const s1 = await insertSource(db, { userId: alice.id, problemId: p1.id, revisionId: p1.revisionId, source: 'a', languageId: cpp });
      const s2 = await insertSource(db, { userId: alice.id, problemId: p2.id, revisionId: p2.revisionId, source: 'b', languageId: cpp });

      const svc = new SubmissionAccessService(db);
      await expect(svc.diff(actorFor(alice.id), s1, s2)).rejects.toMatchObject({
        status: 422,
        code: 'diff_problem_mismatch',
      });
    });
  }, 120_000);
});

interface SeededContest {
  aliceId: number;
  rivalId: number;
  aliceContestSub: number;
  aliceEarlier: number;
  rivalPractice: number;
}

/**
 * A running contest (source_access = solved, a freeze window) with alice's
 * contest submission, an earlier own attempt of hers, and the rival's own
 * practice AC (which buys the rival `solved` visibility). Mirrors
 * `submission-source-contest.spec.ts`'s seeder.
 */
async function seedContestDiff(
  db: Db,
  opts: { key: string; endInMs: number; frozenLastMinutes: number },
): Promise<SeededContest> {
  await seedProblemAndLanguage(db);
  const endMs = Date.now() + opts.endInMs;
  const startMs = endMs - 60 * MINUTE;
  const organizer = await insertUser(db, `${opts.key}-org`);
  const alice = await insertUser(db, `${opts.key}-alice`);
  const rival = await insertUser(db, `${opts.key}-rival`);
  const p = await seedProblemWithSourceAccess(db, { code: `${opts.key}-p`, sourceAccess: 'solved' });
  const cpp = await languageId(db, 'cpp17');

  const [contest] = await db
    .insert(contests)
    .values({
      key: opts.key,
      name: opts.key,
      startTime: new Date(startMs),
      endTime: new Date(endMs),
      format: 'default',
      frozenLastMinutes: opts.frozenLastMinutes,
      visibility: 'public',
      createdBy: organizer.id,
    })
    .returning({ id: contests.id });
  const [cp] = await db
    .insert(contestProblems)
    .values({ contestId: contest!.id, problemId: p.id, label: 'A', points: 100, partial: false, order: 0 })
    .returning({ id: contestProblems.id });
  const [participation] = await db
    .insert(contestParticipations)
    .values({ contestId: contest!.id, userId: alice.id, startTime: new Date(startMs), virtual: 0 })
    .returning({ id: contestParticipations.id });

  // An earlier own attempt, and the contest submission itself (inside the
  // freeze window: created in the contest's last ten minutes).
  const aliceEarlier = await insertSource(db, {
    userId: alice.id,
    problemId: p.id,
    revisionId: p.revisionId,
    source: 'int main(){ return 0; }',
    languageId: cpp,
    at: new Date(startMs + MINUTE),
  });
  const aliceContestSub = await insertSource(db, {
    userId: alice.id,
    problemId: p.id,
    revisionId: p.revisionId,
    source: 'int main(){ return 42; }',
    languageId: cpp,
    at: new Date(endMs - MINUTE),
  });
  await db.insert(contestSubmissions).values({
    participationId: participation!.id,
    contestProblemId: cp!.id,
    submissionId: aliceContestSub,
  });

  const rivalPractice = await insertGradedSubmission(db, {
    userId: rival.id,
    problemId: p.id,
    verdict: 'AC',
    points: 100,
    maxPoints: 100,
  });

  return { aliceId: alice.id, rivalId: rival.id, aliceContestSub, aliceEarlier, rivalPractice };
}
