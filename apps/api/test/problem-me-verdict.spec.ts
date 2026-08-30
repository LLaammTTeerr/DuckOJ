import { describe, expect, it } from 'vitest';
import { createDb, type Db } from '@duckoj/db';
import { ProblemAccessService } from '../src/authz/problem.access.js';
import type { Actor } from '../src/authz/actor.js';
import type { PackageStore } from '../src/packages/package.store.js';
import { testDbUrl, withTestDb } from './db.harness.js';
import { bypassCache } from './cache.harness.js';
import {
  grantProblemRole,
  insertGradedSubmission,
  insertUser,
  publishNextRevision,
  seedProblemAndLanguage,
  seedProblemWithSourceAccess,
} from './submissions.fixtures.js';

/**
 * Spec: `docs/superpowers/specs/2026-08-21-best-verdict-design.md` — the
 * `me` column moves onto `ProblemSummary`/`ProblemDetail`, computed
 * server-side as the viewer's BEST submission to a problem (max `points`,
 * ties broken by the earliest), not their latest. §6 numbers the six cases
 * this file covers 1:1.
 */

function actorFor(userId: number): Actor {
  return { userId, globalRole: 'user', via: 'session', scopes: [] };
}

const UNUSED_STORE: PackageStore = {
  has: () => Promise.reject(new Error('unexpected package store access in this test')),
  put: () => Promise.reject(new Error('unexpected package store access in this test')),
  get: () => Promise.reject(new Error('unexpected package store access in this test')),
  delete: () => Promise.reject(new Error('unexpected package store access in this test')),
};

class RollbackSignal extends Error {}

/**
 * Like `withTestDb`, but the `Db` handed to `fn` is wired to a logger that
 * records every SQL statement text Postgres actually receives, and `log`
 * lets a test reset that record mid-way through (past fixture setup, right
 * before the one call under test) and inspect it afterward. This is the
 * only way to pin "one statement" and "the lateral is never attached for
 * an anonymous caller" — both are properties of what SQL gets SENT, which
 * no amount of asserting on the returned rows can observe.
 */
async function withQueryLog(
  fn: (db: Db, log: { queries: string[]; reset: () => void }) => Promise<void>,
): Promise<void> {
  const url = await testDbUrl();
  const queries: string[] = [];
  const log = {
    queries,
    reset(): void {
      queries.length = 0;
    },
  };
  const { db, close } = createDb(url, { logger: { logQuery: (query: string) => queries.push(query) } });
  try {
    await db
      .transaction(async (tx) => {
        await fn(tx as unknown as Db, log);
        throw new RollbackSignal();
      })
      .catch((error: unknown) => {
        if (!(error instanceof RollbackSignal)) throw error;
      });
  } finally {
    await close();
  }
}

describe('ProblemAccessService — the `me` column (best verdict, spec §6)', () => {
  it('1. is the BEST verdict, not the latest: AC then WA on the same problem still shows AC', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const { id: problemId } = await seedProblemWithSourceAccess(db, { code: 'bestnotlatest' });
      const solver = await insertUser(db, 'bnl-solver');
      // Solve it first, then submit junk afterwards — exactly the sequence
      // spec §1 calls out as the bug: a "latest verdict" reading would show
      // WA here, which is backwards.
      await insertGradedSubmission(db, { userId: solver.id, problemId, verdict: 'AC', points: 100, maxPoints: 100 });
      await insertGradedSubmission(db, { userId: solver.id, problemId, verdict: 'WA', points: 0, maxPoints: 100 });

      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
      const page = await service.listVisible(actorFor(solver.id), { limit: 25 });
      const item = page.items.find((p) => p.code === 'bestnotlatest');
      expect(item?.me).toEqual({ verdict: 'AC', points: 100, maxPoints: 100 });

      // Same reading on the detail route.
      const detail = await service.getVisible(actorFor(solver.id), 'bestnotlatest');
      expect(detail.me).toEqual({ verdict: 'AC', points: 100, maxPoints: 100 });
    });
  }, 120_000);

  it('2. is not limited to the most recent 100 submissions: an old solve stays visible behind 100+ newer ones', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const { id: solvedId } = await seedProblemWithSourceAccess(db, { code: 'oldsolved' });
      const { id: noiseId } = await seedProblemWithSourceAccess(db, { code: 'noiseproblem' });
      const solver = await insertUser(db, 'window-solver');

      // The AC is the FIRST submission this user ever makes — every one of
      // the 105 that follow buries it further behind a recency window the
      // old client-side "last 100 submissions" derivation could never see
      // past, at any page size.
      await insertGradedSubmission(db, { userId: solver.id, problemId: solvedId, verdict: 'AC', points: 100, maxPoints: 100 });
      for (let i = 0; i < 105; i++) {
        await insertGradedSubmission(db, { userId: solver.id, problemId: noiseId, verdict: 'WA', points: 0, maxPoints: 100 });
      }

      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
      const page = await service.listVisible(actorFor(solver.id), { limit: 25 });
      const item = page.items.find((p) => p.code === 'oldsolved');
      expect(item?.me).toEqual({ verdict: 'AC', points: 100, maxPoints: 100 });
    });
  }, 120_000);

  it('3. ties are broken by the earliest submission', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const { id: problemId, revisionId: rev1 } = await seedProblemWithSourceAccess(db, { code: 'tiebreak' });
      const solver = await insertUser(db, 'tie-solver');

      // Earlier submission: WA, 50/100 against revision 1.
      const earlier = await insertGradedSubmission(db, {
        userId: solver.id,
        problemId,
        revisionId: rev1,
        verdict: 'WA',
        points: 50,
        maxPoints: 100,
      });
      // Publish revision 2 with a different total, then a LATER submission
      // that ties on points (50 == 50) but scores full marks against the
      // new, smaller total — AC, 50/50. If the tie went to the latest
      // submission instead of the earliest, `me` would read AC/50 here
      // instead of WA/100.
      const rev2 = await publishNextRevision(db, problemId, 'tiebreak', 50);
      const later = await insertGradedSubmission(db, {
        userId: solver.id,
        problemId,
        revisionId: rev2,
        verdict: 'AC',
        points: 50,
        maxPoints: 50,
      });
      expect(earlier).toBeLessThan(later);

      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
      const page = await service.listVisible(actorFor(solver.id), { limit: 25 });
      const item = page.items.find((p) => p.code === 'tiebreak');
      expect(item?.me).toEqual({ verdict: 'WA', points: 50, maxPoints: 100 });
    });
  }, 120_000);

  it("4. maxPoints follows the SUBMITTING revision's total, not the problem's current one", async () => {
    // Spec §7's named risk: every OTHER fixture in this file has a problem
    // whose submission's maxPoints happens to equal the current revision's
    // total, which a wrong implementation (joining `me.maxPoints` onto the
    // CURRENT revision instead of reading `submissions.maxPoints`) would
    // also pass. Only a fixture with two revisions of DIFFERING totals
    // tells the two readings apart.
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const { id: problemId, revisionId: rev1 } = await seedProblemWithSourceAccess(db, { code: 'maxpointsfollow' });
      const solver = await insertUser(db, 'mpf-solver');

      // Solve it fully against revision 1, whose total is 100.
      await insertGradedSubmission(db, {
        userId: solver.id,
        problemId,
        revisionId: rev1,
        verdict: 'AC',
        points: 100,
        maxPoints: 100,
      });
      // Publish revision 2 with a DIFFERENT total (50). The submission
      // above was graded against revision 1 and is never regraded.
      await publishNextRevision(db, problemId, 'maxpointsfollow', 50);

      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      // Confirm the fixture actually separates the two readings: the
      // problem's OWN current total is now 50, not 100.
      const detail = await service.getVisible(actorFor(solver.id), 'maxpointsfollow');
      expect(detail.totalPoints).toBe(50);
      // But `me.maxPoints` must still be 100 — the submission's own total,
      // not the problem's current one.
      expect(detail.me).toEqual({ verdict: 'AC', points: 100, maxPoints: 100 });

      const page = await service.listVisible(actorFor(solver.id), { limit: 25 });
      const item = page.items.find((p) => p.code === 'maxpointsfollow');
      expect(item?.me).toEqual({ verdict: 'AC', points: 100, maxPoints: 100 });
    });
  }, 120_000);

  it('5. is null for an anonymous caller, whose query never attaches the lateral join', async () => {
    await withQueryLog(async (db, log) => {
      await seedProblemAndLanguage(db);
      const { id: problemId } = await seedProblemWithSourceAccess(db, { code: 'anonme' });
      const solver = await insertUser(db, 'anon-solver');
      await insertGradedSubmission(db, { userId: solver.id, problemId, verdict: 'AC', points: 100, maxPoints: 100 });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      log.reset();
      const anonPage = await service.listVisible(null, { limit: 25 });
      const anonItem = anonPage.items.find((p) => p.code === 'anonme');
      expect(anonItem?.me).toBeNull();
      // Not just "no me in the response" — the SQL itself never joins a
      // lateral subquery in when there is no viewer to correlate it to. A
      // query that filtered `user_id = NULL` would still return null `me`
      // but would cost the join on every row regardless.
      expect(log.queries.some((q) => /lateral/i.test(q))).toBe(false);

      log.reset();
      const signedPage = await service.listVisible(actorFor(solver.id), { limit: 25 });
      const signedItem = signedPage.items.find((p) => p.code === 'anonme');
      expect(signedItem?.me).toEqual({ verdict: 'AC', points: 100, maxPoints: 100 });
      expect(log.queries.some((q) => /lateral/i.test(q))).toBe(true);
    });
  }, 120_000);

  it('is also null for a signed-in viewer who has never (successfully graded a) submission to the problem', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      await seedProblemWithSourceAccess(db, { code: 'untouched' });
      const viewer = await insertUser(db, 'untouched-viewer');
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const page = await service.listVisible(actorFor(viewer.id), { limit: 25 });
      const item = page.items.find((p) => p.code === 'untouched');
      expect(item?.me).toBeNull();
    });
  }, 120_000);

  it('6. issues a fixed number of statements for a page, regardless of how many rows are on it', async () => {
    await withQueryLog(async (db, log) => {
      await seedProblemAndLanguage(db);
      const solver = await insertUser(db, 'onestmt-solver');
      for (let i = 0; i < 8; i++) {
        const { id } = await seedProblemWithSourceAccess(db, { code: `onestmt-${i}` });
        // Alternate: half the rows have a submission to join, half don't —
        // a per-row lookup (the regression this test exists to catch) would
        // scale with row count either way, but mixing both cases here rules
        // out a fix that only avoids the extra round trip when `me` is null.
        if (i % 2 === 0) {
          await insertGradedSubmission(db, { userId: solver.id, problemId: id, verdict: 'AC', points: 100, maxPoints: 100 });
        }
      }

      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      // Four statements, not one: the D35 hidden-id scan, the page itself,
      // the whole page's tags in one `IN` (D35), and the whole page's
      // solved/attempted counters in one aggregate (D49). What this test
      // pins is not the number but its INDEPENDENCE from the row count — a
      // per-row lookup for `me` (the original regression), for `tags`, or
      // for the counters would make the two measurements below differ.
      log.reset();
      const wide = await service.listVisible(actorFor(solver.id), { limit: 50 });
      expect(wide.items.filter((p) => p.code.startsWith('onestmt-'))).toHaveLength(8);
      const wideCount = log.queries.length;

      log.reset();
      const narrow = await service.listVisible(actorFor(solver.id), { limit: 2 });
      expect(narrow.items).toHaveLength(2);
      expect(log.queries).toHaveLength(wideCount);
      expect(wideCount).toBe(4);
    });
  }, 120_000);

  it("carries `me` on POST /problems and PATCH /problems/:code responses too, not just GET (loadDetailById)", async () => {
    // `create`/`update` answer with a `ProblemDetail` via a THIRD query
    // (`loadDetailById`), separate from `getVisible`'s — easy to miss when
    // wiring `me` in, and easy for it to silently stay `me: null` forever if
    // missed, which would be a real drift: the very next `GET
    // /problems/:code` for the same actor would disagree with what
    // `PATCH /problems/:code` just answered.
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const { id: problemId } = await seedProblemWithSourceAccess(db, { code: 'detailme' });
      const author = await insertUser(db, 'detailme-author');
      await grantProblemRole(db, problemId, author.id, 'author');
      await insertGradedSubmission(db, { userId: author.id, problemId, verdict: 'AC', points: 100, maxPoints: 100 });

      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
      const updated = await service.update(actorFor(author.id), 'detailme', { name: 'Detail Me Renamed' });
      expect(updated.me).toEqual({ verdict: 'AC', points: 100, maxPoints: 100 });
    });
  }, 120_000);

  // Coordinator review (2026-08-21), the 19th spec defect: `event-writer.ts`
  // never writes `maxPoints` for a compile error, and writes neither
  // `points` nor `maxPoints` for an internal error — so a viewer whose
  // submissions to a problem are ALL unscored outcomes was, in the first
  // cut of this feature, indistinguishable from a viewer who never
  // attempted it at all. That is actively wrong for CE, which beginners hit
  // constantly. `me` must represent CE/IE, with the fields those verdicts
  // actually recorded — null included — rather than being excluded from
  // "best" candidacy.
  it('carries a CE-only submission as `me`, with maxPoints null, instead of reading as never-attempted', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const { id: problemId } = await seedProblemWithSourceAccess(db, { code: 'ceonly' });
      const solver = await insertUser(db, 'ce-only-solver');
      // Mirrors `event-writer.ts`'s `compileError` branch exactly: `points:
      // 0`, `maxPoints` never set (omitted here, so it lands NULL in the DB
      // the same way).
      await insertGradedSubmission(db, { userId: solver.id, problemId, verdict: 'CE', points: 0 });

      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
      const page = await service.listVisible(actorFor(solver.id), { limit: 25 });
      const item = page.items.find((p) => p.code === 'ceonly');
      // NOT null — a CE is a real, graded attempt, distinct from never
      // having submitted at all.
      expect(item?.me).toEqual({ verdict: 'CE', points: 0, maxPoints: null });

      const detail = await service.getVisible(actorFor(solver.id), 'ceonly');
      expect(detail.me).toEqual({ verdict: 'CE', points: 0, maxPoints: null });
    });
  }, 120_000);

  it('a scoring WA outranks a LATER CE: a real score beats an unscored-at-zero one, by points, not recency', async () => {
    // The WA is submitted FIRST, the unscored CE comes AFTER it — the
    // ordering that would trip up a "latest" regression (§6 test 1's
    // failure mode, resurfacing here specifically for CE/IE now that
    // they're candidates too): a buggy "most recent graded submission"
    // implementation would report the later CE. Only "max points" gets
    // this right regardless of which came first.
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const { id: problemId } = await seedProblemWithSourceAccess(db, { code: 'cevswa' });
      const solver = await insertUser(db, 'ce-vs-wa-solver');
      await insertGradedSubmission(db, { userId: solver.id, problemId, verdict: 'WA', points: 40, maxPoints: 100 });
      await insertGradedSubmission(db, { userId: solver.id, problemId, verdict: 'CE', points: 0 });

      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
      const page = await service.listVisible(actorFor(solver.id), { limit: 25 });
      const item = page.items.find((p) => p.code === 'cevswa');
      expect(item?.me).toEqual({ verdict: 'WA', points: 40, maxPoints: 100 });
    });
  }, 120_000);

  it('a LATER IE (no points recorded at all) never masks an earlier CE scored at zero', async () => {
    // CE first, IE second — again the ordering that would trip up a
    // "latest" regression. The mechanism this actually relies on:
    // `bestSubmissionLateral`'s `points desc nulls last` sorts an IE's null
    // points behind EVERY row with a real number, including a CE's 0 — so
    // an IE only ever wins the "best" slot when it is the viewer's only
    // graded submission to the problem, never merely the most recent one.
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const { id: problemId } = await seedProblemWithSourceAccess(db, { code: 'ievsce' });
      const solver = await insertUser(db, 'ie-vs-ce-solver');
      await insertGradedSubmission(db, { userId: solver.id, problemId, verdict: 'CE', points: 0 });
      await insertGradedSubmission(db, { userId: solver.id, problemId, verdict: 'IE' });

      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
      const page = await service.listVisible(actorFor(solver.id), { limit: 25 });
      const item = page.items.find((p) => p.code === 'ievsce');
      expect(item?.me).toEqual({ verdict: 'CE', points: 0, maxPoints: null });
    });
  }, 120_000);

  it('an IE is still representable as `me` when it is the only graded submission', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const { id: problemId } = await seedProblemWithSourceAccess(db, { code: 'ieonly' });
      const solver = await insertUser(db, 'ie-only-solver');
      await insertGradedSubmission(db, { userId: solver.id, problemId, verdict: 'IE' });

      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
      const page = await service.listVisible(actorFor(solver.id), { limit: 25 });
      const item = page.items.find((p) => p.code === 'ieonly');
      expect(item?.me).toEqual({ verdict: 'IE', points: null, maxPoints: null });
    });
  }, 120_000);
});
