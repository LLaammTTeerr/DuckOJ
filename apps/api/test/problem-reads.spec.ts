import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@duckoj/db';
import type { Db } from '@duckoj/db';
import { organizations, orgMembers, problemMembers, problemOrgs, problemRevisions, problems } from '@duckoj/db/guarded';
import type { Actor } from '../src/authz/actor.js';
import { likeEscape, ProblemAccessService } from '../src/authz/problem.access.js';
import type { PackageStore } from '../src/packages/package.store.js';
import { withTestDb } from './db.harness.js';
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
      const service = new ProblemAccessService(db, UNUSED_STORE);

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
      const service = new ProblemAccessService(db, UNUSED_STORE);

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
      const service = new ProblemAccessService(db, UNUSED_STORE);

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
      const service = new ProblemAccessService(db, UNUSED_STORE);

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
      const service = new ProblemAccessService(db, UNUSED_STORE);

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
      const service = new ProblemAccessService(db, UNUSED_STORE);

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
      const service = new ProblemAccessService(db, UNUSED_STORE);

      const byName = await service.listVisible(null, { limit: 25 }, 'PLUS');
      expect(byName.items.map((p) => p.code)).toEqual(['aplusb']);

      const byCode = await service.listVisible(null, { limit: 25 }, 'apl');
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
      const service = new ProblemAccessService(db, UNUSED_STORE);

      const page = await service.listVisible(null, { limit: 25 }, '100%');
      expect(page.items.map((p) => p.code)).toEqual(['haspct']);
    });
  }, 120_000);

  it('reports hasPublishedRevision false and null limits for a draft-only problem', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'owner-draft');
      await seedProblem(db, { code: 'draft1', name: 'Draft One', createdBy: owner.id, publish: false });
      const service = new ProblemAccessService(db, UNUSED_STORE);

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
