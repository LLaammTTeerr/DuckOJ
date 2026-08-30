import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@duckoj/db';
import type { Db } from '@duckoj/db';
import { organizations, orgMembers, problemMembers, problemOrgs, problemRevisions, problems } from '@duckoj/db/guarded';
import type { Actor } from '../src/authz/actor.js';
import { likeEscape, ProblemAccessService } from '../src/authz/problem.access.js';
import type { PackageStore } from '../src/packages/package.store.js';
import { withTestDb } from './db.harness.js';
import { bypassCache } from './cache.harness.js';
import { insertUser } from './submissions.fixtures.js';

function actorFor(userId: number, globalRole: 'user' | 'admin' = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

/**
 * None of `listVisible`/`getVisible` ever touch the package store — throwing
 * on every call turns an accidental future dependency into a loud test
 * failure instead of a silent no-op.
 */
const UNUSED_STORE: PackageStore = {
  has: () => Promise.reject(new Error('unexpected package store access in this test')),
  put: () => Promise.reject(new Error('unexpected package store access in this test')),
  get: () => Promise.reject(new Error('unexpected package store access in this test')),
  delete: () => Promise.reject(new Error('unexpected package store access in this test')),
};

type Visibility = 'private' | 'org' | 'public';

/**
 * Inserts a problem, and — unless `publish: false` — a published revision
 * set as its `currentRevisionId`. `publish: false` leaves `currentRevisionId`
 * null, standing in for a draft-only problem that has never shipped a
 * gradeable version.
 */
async function seedProblem(
  db: Db,
  opts: { code: string; name: string; visibility?: Visibility; createdBy: number; publish?: boolean },
): Promise<{ id: number }> {
  const [problem] = await db
    .insert(problems)
    .values({
      code: opts.code,
      name: opts.name,
      statement: 'statement',
      visibility: opts.visibility ?? 'public',
      createdBy: opts.createdBy,
    })
    .returning();
  if (opts.publish !== false) {
    const hash = `hash-${opts.code}`;
    await db.insert(schema.packages).values({ hash, sizeBytes: 1, fileCount: 1 });
    const [revision] = await db
      .insert(problemRevisions)
      .values({
        problemId: problem!.id,
        version: 1,
        packageHash: hash,
        state: 'published',
        createdBy: opts.createdBy,
        timeMs: 1000,
        memoryKb: 256_000,
        testCount: 5,
        totalPoints: 100,
        checkerKind: 'wcmp',
      })
      .returning();
    await db.update(problems).set({ currentRevisionId: revision!.id }).where(eq(problems.id, problem!.id));
  }
  return { id: problem!.id };
}

describe('ProblemAccessService.listVisible / getVisible — visibility matrix', () => {
  it('lists a public problem to an anonymous caller', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'owner-pub');
      await seedProblem(db, { code: 'pub1', name: 'Public One', createdBy: owner.id });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const page = await service.listVisible(null, { limit: 25 });
      expect(page.items.map((p) => p.code)).toContain('pub1');

      const detail = await service.getVisible(null, 'pub1');
      expect(detail.code).toBe('pub1');
    });
  }, 120_000);

  it('hides an org problem from a non-member', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'owner-org1');
      const stranger = await insertUser(db, 'stranger-org1');
      const [org] = await db
        .insert(organizations)
        .values({ slug: 'club-hide', name: 'Club Hide', visibility: 'private' })
        .returning();
      const { id } = await seedProblem(db, { code: 'org1', name: 'Org One', visibility: 'org', createdBy: owner.id });
      await db.insert(problemOrgs).values({ problemId: id, orgId: org!.id });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const page = await service.listVisible(actorFor(stranger.id), { limit: 25 });
      expect(page.items.map((p) => p.code)).not.toContain('org1');

      await expect(service.getVisible(actorFor(stranger.id), 'org1')).rejects.toMatchObject({
        status: 404,
        code: 'problem_not_found',
      });
    });
  }, 120_000);

  it('shows an org problem to a member of a shared org', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'owner-org2');
      const member = await insertUser(db, 'member-org2');
      const [org] = await db
        .insert(organizations)
        .values({ slug: 'club-show', name: 'Club Show', visibility: 'private' })
        .returning();
      await db.insert(orgMembers).values({ orgId: org!.id, userId: member.id, role: 'member' });
      const { id } = await seedProblem(db, { code: 'org2', name: 'Org Two', visibility: 'org', createdBy: owner.id });
      await db.insert(problemOrgs).values({ problemId: id, orgId: org!.id });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const page = await service.listVisible(actorFor(member.id), { limit: 25 });
      expect(page.items.map((p) => p.code)).toContain('org2');

      const detail = await service.getVisible(actorFor(member.id), 'org2');
      expect(detail.code).toBe('org2');
    });
  }, 120_000);

  it('shows a private problem to its tester', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'owner-priv1');
      const tester = await insertUser(db, 'tester-priv1');
      const { id } = await seedProblem(db, {
        code: 'priv1',
        name: 'Private One',
        visibility: 'private',
        createdBy: owner.id,
      });
      await db.insert(problemMembers).values({ problemId: id, userId: tester.id, role: 'tester' });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const page = await service.listVisible(actorFor(tester.id), { limit: 25 });
      expect(page.items.map((p) => p.code)).toContain('priv1');

      const detail = await service.getVisible(actorFor(tester.id), 'priv1');
      expect(detail.visibility).toBe('private');
    });
  }, 120_000);

  it('returns 404 problem_not_found for a private problem the actor cannot see', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'owner-priv2');
      const stranger = await insertUser(db, 'stranger-priv2');
      await seedProblem(db, { code: 'priv2', name: 'Private Two', visibility: 'private', createdBy: owner.id });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      await expect(service.getVisible(actorFor(stranger.id), 'priv2')).rejects.toMatchObject({
        status: 404,
        code: 'problem_not_found',
      });
      await expect(service.getVisible(null, 'priv2')).rejects.toMatchObject({
        status: 404,
        code: 'problem_not_found',
      });

      const page = await service.listVisible(actorFor(stranger.id), { limit: 25 });
      expect(page.items.map((p) => p.code)).not.toContain('priv2');
    });
  }, 120_000);

  it('paginates: 3 problems, limit 2, follow nextCursor, get the third', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'owner-page');
      await seedProblem(db, { code: 'page-a', name: 'Page A', createdBy: owner.id });
      await seedProblem(db, { code: 'page-b', name: 'Page B', createdBy: owner.id });
      await seedProblem(db, { code: 'page-c', name: 'Page C', createdBy: owner.id });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const first = await service.listVisible(null, { limit: 2 });
      expect(first.items.map((p) => p.code)).toEqual(['page-a', 'page-b']);
      expect(first.nextCursor).not.toBeNull();

      const second = await service.listVisible(null, { limit: 2, cursor: first.nextCursor! });
      expect(second.items.map((p) => p.code)).toEqual(['page-c']);
      expect(second.nextCursor).toBeNull();
    });
  }, 120_000);

  it('filters by q against both code and name, case-insensitively', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'owner-q');
      await seedProblem(db, { code: 'aplusb', name: 'A plus B', createdBy: owner.id });
      await seedProblem(db, { code: 'other', name: 'Something Else', createdBy: owner.id });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const byName = await service.listVisible(null, { limit: 25 }, { q: 'PLUS' });
      expect(byName.items.map((p) => p.code)).toEqual(['aplusb']);

      const byCode = await service.listVisible(null, { limit: 25 }, { q: 'apl' });
      expect(byCode.items.map((p) => p.code)).toEqual(['aplusb']);
    });
  }, 120_000);

  it('escapes % in q so a search for a literal percent does not match every problem', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'owner-esc');
      // Contains the digits "100" but not a literal "100%" — the unescaped
      // bug's failure mode is that this matches too, because `%` in the
      // pattern's middle is a wildcard rather than a literal character.
      await seedProblem(db, { code: 'nopct', name: 'Contains 100 but no percent', createdBy: owner.id });
      await seedProblem(db, { code: 'haspct', name: 'Get 100% off today', createdBy: owner.id });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const page = await service.listVisible(null, { limit: 25 }, { q: '100%' });
      expect(page.items.map((p) => p.code)).toEqual(['haspct']);
    });
  }, 120_000);

  it('carries testCount on the summary, and nulls it for a draft-only problem', async () => {
    // testCount lives on the SUMMARY so the problem list can show it without a
    // request per row — deriving it from ProblemDetail would be the N+1 the
    // list must not do.
    //
    // What this test does NOT pin, stated so nobody assumes otherwise: the
    // `row.revisionId === null ? null : ...` guard in `toSummary`. Verified by
    // mutation — removing that guard leaves all 15 tests green, because a
    // draft-only problem has no `currentRevisionId` at all, so the leftJoin
    // matches nothing and every revision column is already SQL NULL. The guard
    // is belt-and-braces behind the join, and the join's `state = 'published'`
    // term is what actually carries the weight (Phase 2b R17). Pinning the
    // guard needs a problem whose `currentRevisionId` points at a NON-published
    // revision, which no fixture here can currently build.
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'tc-owner');
      await seedProblem(db, { code: 'tcpub', name: 'Published', createdBy: owner.id });
      await seedProblem(db, { code: 'tcdraft', name: 'Draft only', createdBy: owner.id, publish: false });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const page = await service.listVisible(null, { limit: 50 });
      const byCode = new Map(page.items.map((p) => [p.code, p]));
      expect(byCode.get('tcpub')!.testCount).toBe(5);
      expect(byCode.get('tcdraft')!.testCount).toBeNull();
    });
  }, 120_000);

  it('reports hasPublishedRevision false and null limits for a draft-only problem', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'owner-draft');
      await seedProblem(db, { code: 'draft1', name: 'Draft One', createdBy: owner.id, publish: false });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const page = await service.listVisible(null, { limit: 25 });
      const item = page.items.find((p) => p.code === 'draft1');
      expect(item).toBeDefined();
      expect(item!.hasPublishedRevision).toBe(false);
      expect(item!.timeMs).toBeNull();
      expect(item!.memoryKb).toBeNull();

      const detail = await service.getVisible(null, 'draft1');
      expect(detail.hasPublishedRevision).toBe(false);
      expect(detail.timeMs).toBeNull();
      expect(detail.memoryKb).toBeNull();
      expect(detail.testCount).toBeNull();
      expect(detail.totalPoints).toBeNull();
      expect(detail.checkerKind).toBeNull();
    });
  }, 120_000);
});

describe('getVisible — members and orgSlugs (spec §4.1)', () => {
  it('an author sees a private organization the problem is shared with, even one they do not personally belong to', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'credit-owner');
      const coauthor = await insertUser(db, 'credit-coauthor');
      const [org] = await db
        .insert(organizations)
        .values({ slug: 'hazard-org', name: 'Hazard Org', visibility: 'private' })
        .returning();
      const { id } = await seedProblem(db, {
        code: 'credit1',
        name: 'Credit One',
        visibility: 'public',
        createdBy: owner.id,
      });
      await db.insert(problemOrgs).values({ problemId: id, orgId: org!.id });
      // `coauthor` is added as an author directly (bypassing `update`, which
      // would itself require org membership to attach `hazard-org` — not
      // what this test is about) and is deliberately never made a member of
      // it. This is the case that actually distinguishes "editors get the
      // unfiltered set" from "just reuse `visibleOrgsWhere` for everyone":
      // `visibleOrgsWhere` alone would hide this org from `coauthor`, since
      // neither publicness nor personal membership applies to them — only
      // being an editor of the problem does.
      await db.insert(problemMembers).values([
        { problemId: id, userId: owner.id, role: 'author' },
        { problemId: id, userId: coauthor.id, role: 'author' },
      ]);
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const detail = await service.getVisible(actorFor(coauthor.id), 'credit1');
      expect(detail.orgSlugs).toEqual(['hazard-org']);
    });
  }, 120_000);

  it('a non-member viewer of the same public problem does not see the private organization', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'credit-owner2');
      const stranger = await insertUser(db, 'credit-stranger2');
      const [org] = await db
        .insert(organizations)
        .values({ slug: 'hazard-org2', name: 'Hazard Org 2', visibility: 'private' })
        .returning();
      const { id } = await seedProblem(db, {
        code: 'credit2',
        name: 'Credit Two',
        visibility: 'public',
        createdBy: owner.id,
      });
      await db.insert(problemOrgs).values({ problemId: id, orgId: org!.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      // The problem itself IS visible to the stranger (not a 404) — the
      // point is a viewable problem with an invisible org name, not a
      // hidden problem.
      const detail = await service.getVisible(actorFor(stranger.id), 'credit2');
      expect(detail.code).toBe('credit2');
      expect(detail.orgSlugs).toEqual([]);
    });
  }, 120_000);

  it('an author and a non-member viewer of the same problem see identical members', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'credit-owner3');
      const tester = await insertUser(db, 'credit-tester3');
      const stranger = await insertUser(db, 'credit-stranger3');
      const { id } = await seedProblem(db, {
        code: 'credit3',
        name: 'Credit Three',
        visibility: 'public',
        createdBy: owner.id,
      });
      await db.insert(problemMembers).values([
        { problemId: id, userId: owner.id, role: 'author' },
        { problemId: id, userId: tester.id, role: 'tester' },
      ]);
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const ownerView = await service.getVisible(actorFor(owner.id), 'credit3');
      const strangerView = await service.getVisible(actorFor(stranger.id), 'credit3');
      expect(strangerView.members).toEqual(ownerView.members);
      expect(strangerView.members).toEqual([
        { username: 'credit-owner3', role: 'author' },
        { username: 'credit-tester3', role: 'tester' },
      ]);
    });
  }, 120_000);

  it("an editor's orgSlugs round-trips through PATCH without dropping anything", async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'credit-owner4');
      const [orgA] = await db
        .insert(organizations)
        .values({ slug: 'hazard-org4a', name: 'Hazard 4a', visibility: 'private' })
        .returning();
      const [orgB] = await db
        .insert(organizations)
        .values({ slug: 'hazard-org4b', name: 'Hazard 4b', visibility: 'public' })
        .returning();
      // `resolveOrgIds` (used by both `create` and `update`) requires actor
      // membership in every org named in `orgSlugs` regardless of that
      // org's own visibility — see problem-writes.spec.ts's "a non-member
      // cannot share with a public org". So `owner` must belong to both, or
      // the round-trip PATCH below would fail on that unrelated constraint
      // rather than exercising the one this test is actually about.
      await db.insert(orgMembers).values([
        { orgId: orgA!.id, userId: owner.id, role: 'member' },
        { orgId: orgB!.id, userId: owner.id, role: 'member' },
      ]);
      const { id } = await seedProblem(db, {
        code: 'credit4',
        name: 'Credit Four',
        visibility: 'public',
        createdBy: owner.id,
      });
      await db.insert(problemOrgs).values([
        { problemId: id, orgId: orgA!.id },
        { problemId: id, orgId: orgB!.id },
      ]);
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
      const actor = actorFor(owner.id);

      const before = await service.getVisible(actor, 'credit4');
      expect(before.orgSlugs.slice().sort()).toEqual(['hazard-org4a', 'hazard-org4b']);

      // The whole-set-replacement hazard: PATCHing back exactly what GET
      // returned must not drop anything. If `getVisible` had given an
      // editor the same filtered view a plain viewer gets, `before.orgSlugs`
      // above would already have silently lost `hazard-org4a`'s counterpart
      // in some other case — the failure would show up here instead, as an
      // org present before the round trip going missing after it.
      await service.update(actor, 'credit4', { orgSlugs: before.orgSlugs });

      const after = await service.getVisible(actor, 'credit4');
      expect(after.orgSlugs.slice().sort()).toEqual(['hazard-org4a', 'hazard-org4b']);
    });
  }, 120_000);
});

describe('likeEscape', () => {
  it('escapes % and _ so they are matched literally', () => {
    expect(likeEscape('100%')).toBe('100\\%');
    expect(likeEscape('a_b')).toBe('a\\_b');
    expect(likeEscape('a%b_c')).toBe('a\\%b\\_c');
    expect(likeEscape('plain')).toBe('plain');
    // The backslash branch must run FIRST, or escaping `%` would then have
    // its own escape re-escaped. A term that is itself a backslash is the
    // only input that distinguishes correct ordering from reversed.
    expect(likeEscape('a\\b')).toBe('a\\\\b');
    expect(likeEscape('100\\%')).toBe('100\\\\\\%');
  });
});
