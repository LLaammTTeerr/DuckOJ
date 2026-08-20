import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@duckoj/db';
import type { Db } from '@duckoj/db';
import { organizations, problemMembers, problemOrgs, problemRevisions, problems } from '@duckoj/db/guarded';
import type { Actor } from '../src/authz/actor.js';
import { ProblemAccessService } from '../src/authz/problem.access.js';
import { withTestDb } from './db.harness.js';
import { insertUser } from './submissions.fixtures.js';

function actorFor(userId: number, globalRole: 'user' | 'setter' | 'admin' = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

type Visibility = 'private' | 'org' | 'public';

/**
 * Inserts a problem with a published revision (mirroring
 * `problem-reads.spec.ts`'s `seedProblem`, duplicated locally because that
 * one is not exported), but does NOT add any `problemMembers` rows — callers
 * that need membership add it explicitly, which keeps each test's access
 * setup visible at the call site instead of buried in a shared helper.
 */
async function seedProblem(
  db: Db,
  opts: { code: string; name: string; visibility?: Visibility; createdBy: number },
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
  return { id: problem!.id };
}

describe('ProblemAccessService.create', () => {
  it('a setter creates a problem and is inserted as its author', async () => {
    await withTestDb(async (db) => {
      const setter = await insertUser(db, 'setter-create');
      const service = new ProblemAccessService(db);

      const detail = await service.create(actorFor(setter.id, 'setter'), {
        code: 'newprob',
        name: 'New Problem',
        statement: 'A statement.',
      });

      expect(detail.code).toBe('newprob');
      expect(detail.name).toBe('New Problem');

      const [row] = await db.select().from(problems).where(eq(problems.id, detail.id));
      expect(row!.createdBy).toBe(setter.id);

      const members = await db.select().from(problemMembers).where(eq(problemMembers.problemId, detail.id));
      expect(members).toEqual([{ problemId: detail.id, userId: setter.id, role: 'author' }]);
    });
  }, 120_000);

  it('a plain user creating a problem gets 403 problem_forbidden', async () => {
    await withTestDb(async (db) => {
      const plain = await insertUser(db, 'plain-create');
      const service = new ProblemAccessService(db);

      await expect(
        service.create(actorFor(plain.id, 'user'), {
          code: 'blocked',
          name: 'Blocked',
          statement: 'statement',
        }),
      ).rejects.toMatchObject({ status: 403, code: 'problem_forbidden' });
    });
  }, 120_000);

  it('a duplicate code (differing only in case) gets 409 problem_code_taken', async () => {
    await withTestDb(async (db) => {
      const setter = await insertUser(db, 'setter-dup');
      const service = new ProblemAccessService(db);

      await service.create(actorFor(setter.id, 'setter'), {
        code: 'DupCode',
        name: 'First',
        statement: 'statement',
      });

      await expect(
        service.create(actorFor(setter.id, 'setter'), {
          code: 'dupcode',
          name: 'Second',
          statement: 'statement',
        }),
      ).rejects.toMatchObject({ status: 409, code: 'problem_code_taken' });
    });
  }, 120_000);

  it("visibility 'org' with empty orgSlugs gets 400 problem_org_required", async () => {
    await withTestDb(async (db) => {
      const setter = await insertUser(db, 'setter-org-required');
      const service = new ProblemAccessService(db);

      await expect(
        service.create(actorFor(setter.id, 'setter'), {
          code: 'orgreq',
          name: 'Org Required',
          statement: 'statement',
          visibility: 'org',
          orgSlugs: [],
        }),
      ).rejects.toMatchObject({ status: 400, code: 'problem_org_required' });
    });
  }, 120_000);
});

describe('ProblemAccessService.update', () => {
  it('an author patches the name', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'author-patch');
      const { id } = await seedProblem(db, { code: 'patchme', name: 'Old Name', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const service = new ProblemAccessService(db);

      const detail = await service.update(actorFor(owner.id), 'patchme', { name: 'New Name' });
      expect(detail.name).toBe('New Name');

      const [row] = await db.select().from(problems).where(eq(problems.id, id));
      expect(row!.name).toBe('New Name');
    });
  }, 120_000);

  it('a tester patching gets 403 problem_forbidden', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'tester-owner');
      const tester = await insertUser(db, 'tester-patch');
      const { id } = await seedProblem(db, { code: 'testerpatch', name: 'Name', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      await db.insert(problemMembers).values({ problemId: id, userId: tester.id, role: 'tester' });
      const service = new ProblemAccessService(db);

      await expect(
        service.update(actorFor(tester.id), 'testerpatch', { name: 'New Name' }),
      ).rejects.toMatchObject({ status: 403, code: 'problem_forbidden' });
    });
  }, 120_000);

  it('a members replacement removing the last author gets 400 problem_last_author', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'last-author-owner');
      await insertUser(db, 'last-author-other');
      const { id } = await seedProblem(db, { code: 'lastauthor', name: 'Name', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const service = new ProblemAccessService(db);

      await expect(
        service.update(actorFor(owner.id), 'lastauthor', {
          members: [{ username: 'last-author-other', role: 'tester' }],
        }),
      ).rejects.toMatchObject({ status: 400, code: 'problem_last_author' });
    });
  }, 120_000);

  it('a members entry naming no user gets 400 problem_member_unknown', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'unknown-member-owner');
      const { id } = await seedProblem(db, { code: 'unknownmember', name: 'Name', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const service = new ProblemAccessService(db);

      await expect(
        service.update(actorFor(owner.id), 'unknownmember', {
          members: [
            { username: 'unknown-member-owner', role: 'author' },
            { username: 'no-such-user-at-all', role: 'tester' },
          ],
        }),
      ).rejects.toMatchObject({ status: 400, code: 'problem_member_unknown' });
    });
  }, 120_000);

  it('a patch containing `code` gets 400 problem_code_immutable', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'code-immutable-owner');
      const { id } = await seedProblem(db, { code: 'immutable', name: 'Name', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const service = new ProblemAccessService(db);

      await expect(
        service.update(actorFor(owner.id), 'immutable', { code: 'newcode' }),
      ).rejects.toMatchObject({ status: 400, code: 'problem_code_immutable' });
    });
  }, 120_000);

  it('members and orgSlugs replace the whole set, not merge', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'replace-owner');
      const tester = await insertUser(db, 'replace-tester');
      const [orgA] = await db.insert(organizations).values({ slug: 'org-a', name: 'Org A', visibility: 'private' }).returning();
      const [orgB] = await db.insert(organizations).values({ slug: 'org-b', name: 'Org B', visibility: 'private' }).returning();
      const { id } = await seedProblem(db, {
        code: 'replaceall',
        name: 'Name',
        visibility: 'org',
        createdBy: owner.id,
      });
      // Seed two members and two orgs.
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      await db.insert(problemMembers).values({ problemId: id, userId: tester.id, role: 'tester' });
      await db.insert(problemOrgs).values({ problemId: id, orgId: orgA!.id });
      await db.insert(problemOrgs).values({ problemId: id, orgId: orgB!.id });

      const service = new ProblemAccessService(db);
      await service.update(actorFor(owner.id), 'replaceall', {
        members: [{ username: 'replace-owner', role: 'author' }],
        orgSlugs: ['org-a'],
      });

      const members = await db.select().from(problemMembers).where(eq(problemMembers.problemId, id));
      expect(members).toHaveLength(1);
      expect(members[0]).toMatchObject({ userId: owner.id, role: 'author' });

      const orgs = await db.select().from(problemOrgs).where(eq(problemOrgs.problemId, id));
      expect(orgs).toHaveLength(1);
      expect(orgs[0]).toMatchObject({ orgId: orgA!.id });
    });
  }, 120_000);

  it('an invisible problem returns 404 even with a malformed patch (visibility check precedes patch validation)', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'oracle-owner');
      const stranger = await insertUser(db, 'oracle-stranger');
      const { id } = await seedProblem(db, {
        code: 'oracle',
        name: 'Name',
        visibility: 'private',
        createdBy: owner.id,
      });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const service = new ProblemAccessService(db);

      // The stranger can neither view nor edit this problem. The patch is
      // malformed (`code` is immutable) — if patch validation ran before the
      // visibility check, this would surface 400 problem_code_immutable
      // instead of 404, which would leak that a problem exists at this code.
      await expect(
        service.update(actorFor(stranger.id), 'oracle', { code: 'stolen' }),
      ).rejects.toMatchObject({ status: 404, code: 'problem_not_found' });
    });
  }, 120_000);
});
