import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@duckoj/db';
import type { Db } from '@duckoj/db';
import { organizations, orgMembers, problemMembers, problemOrgs, problemRevisions, problems } from '@duckoj/db/guarded';
import type { Actor } from '../src/authz/actor.js';
import { ProblemAccessService } from '../src/authz/problem.access.js';
import type { PackageStore } from '../src/packages/package.store.js';
import { withTestDb } from './db.harness.js';
import { bypassCache } from './cache.harness.js';
import { insertUser } from './submissions.fixtures.js';

function actorFor(userId: number, globalRole: 'user' | 'setter' | 'admin' = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

/**
 * None of `create`/`update` ever touch the package store (that's
 * `attachRevision`'s job, tested separately in `problem-revisions.spec.ts`)
 * — throwing on every call turns an accidental future dependency into a
 * loud test failure instead of a silent no-op.
 */
const UNUSED_STORE: PackageStore = {
  has: () => Promise.reject(new Error('unexpected package store access in this test')),
  put: () => Promise.reject(new Error('unexpected package store access in this test')),
  get: () => Promise.reject(new Error('unexpected package store access in this test')),
  delete: () => Promise.reject(new Error('unexpected package store access in this test')),
};

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

  // Guards the two-defaults trap: `CreateProblemRequest` defaults visibility
  // to 'private' in zod, and the service keeps its own fallback for callers
  // that bypass the pipe. They disagreed once — zod said 'private', the
  // service said 'public' — and over HTTP that was invisible, because the zod
  // default always fills the field before the service sees it. A direct
  // caller (a seed script, an import tool, this very test) got a
  // world-readable problem instead.
  it('defaults a visibility-less direct call to private, not public', async () => {
    await withTestDb(async (db) => {
      const setter = await insertUser(db, 'defaults-setter');
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const detail = await service.create(actorFor(setter.id, 'setter'), {
        code: 'defaultvis',
        name: 'Default visibility',
        statement: 'A statement.',
      });

      expect(detail.visibility).toBe('private');
    });
  }, 120_000);
  it('a setter creates a problem and is inserted as its author', async () => {
    await withTestDb(async (db) => {
      const setter = await insertUser(db, 'setter-create');
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

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
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

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
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

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
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

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

  it('a non-member cannot share with a private org', async () => {
    await withTestDb(async (db) => {
      const setter = await insertUser(db, 'private-share-setter');
      await db.insert(organizations).values({ slug: 'private-club', name: 'Private Club', visibility: 'private' });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      await expect(
        service.create(actorFor(setter.id, 'setter'), {
          code: 'privateshare',
          name: 'X',
          statement: 'statement',
          visibility: 'org',
          orgSlugs: ['private-club'],
        }),
      ).rejects.toMatchObject({ status: 400, code: 'problem_org_unknown' });
    });
  }, 120_000);

  it('a non-member cannot share with a public org', async () => {
    await withTestDb(async (db) => {
      const setter = await insertUser(db, 'public-share-setter');
      await db.insert(organizations).values({ slug: 'public-club', name: 'Public Club', visibility: 'public' });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      // Being nameable and browsable via GET /orgs does not make an org a
      // valid share target — sharing still requires membership.
      await expect(
        service.create(actorFor(setter.id, 'setter'), {
          code: 'publicshare',
          name: 'X',
          statement: 'statement',
          visibility: 'org',
          orgSlugs: ['public-club'],
        }),
      ).rejects.toMatchObject({ status: 400, code: 'problem_org_unknown' });
    });
  }, 120_000);

  // Regression guard for the "retain without re-proving membership" fix
  // below (`ProblemAccessService.update`'s `alreadyAttachedIds` parameter):
  // `create` passes no third argument to `resolveOrgIds`, so it defaults to
  // an empty set and every org named is necessarily treated as a new
  // addition. This must keep failing exactly like the two tests above.
  it('create still requires membership for every org — there is no "already attached" set to exempt', async () => {
    await withTestDb(async (db) => {
      const setter = await insertUser(db, 'create-membership-setter');
      await db
        .insert(organizations)
        .values({ slug: 'create-membership-org', name: 'Create Membership Org', visibility: 'private' });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      await expect(
        service.create(actorFor(setter.id, 'setter'), {
          code: 'creatememship',
          name: 'X',
          statement: 'statement',
          visibility: 'org',
          orgSlugs: ['create-membership-org'],
        }),
      ).rejects.toMatchObject({ status: 400, code: 'problem_org_unknown' });
    });
  }, 120_000);

  it('a member can share with an organization they belong to, resolved case-insensitively', async () => {
    await withTestDb(async (db) => {
      const setter = await insertUser(db, 'member-share-setter');
      const [org] = await db
        .insert(organizations)
        .values({ slug: 'Secret-Org', name: 'Secret Org', visibility: 'private' })
        .returning();
      await db.insert(orgMembers).values({ orgId: org!.id, userId: setter.id, role: 'member' });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const detail = await service.create(actorFor(setter.id, 'setter'), {
        code: 'membershare',
        name: 'X',
        statement: 'statement',
        visibility: 'org',
        // Deliberately different case than the stored slug.
        orgSlugs: ['secret-org'],
      });

      const orgs = await db.select().from(problemOrgs).where(eq(problemOrgs.problemId, detail.id));
      expect(orgs).toEqual([{ problemId: detail.id, orgId: org!.id }]);
    });
  }, 120_000);

  it('the private-org and nonexistent-org errors are identical', async () => {
    await withTestDb(async (db) => {
      const setter = await insertUser(db, 'org-oracle-setter');
      await db.insert(organizations).values({ slug: 'oracle-private', name: 'Oracle Private', visibility: 'private' });
      // `setter` is never made a member of `oracle-private`.
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const privateOrgError = await service
        .create(actorFor(setter.id, 'setter'), {
          code: 'oracle-private-share',
          name: 'X',
          statement: 'statement',
          visibility: 'org',
          orgSlugs: ['oracle-private'],
        })
        .catch((e: unknown) => e);

      const nonexistentOrgError = await service
        .create(actorFor(setter.id, 'setter'), {
          code: 'oracle-nonexistent-share',
          name: 'X',
          statement: 'statement',
          visibility: 'org',
          orgSlugs: ['no-such-org-at-all'],
        })
        .catch((e: unknown) => e);

      // Compared against each other, not each against a hardcoded literal:
      // two separate literal assertions can drift apart from each other
      // without either one failing on its own.
      const shapeOf = (e: unknown) => {
        const err = e as { status?: unknown; code?: unknown; message?: unknown };
        return { status: err.status, code: err.code, message: err.message };
      };
      expect(privateOrgError).toBeInstanceOf(Error);
      expect(nonexistentOrgError).toBeInstanceOf(Error);
      expect(shapeOf(privateOrgError)).toEqual(shapeOf(nonexistentOrgError));
    });
  }, 120_000);
});

describe('ProblemAccessService.update', () => {
  it('an author patches the name', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'author-patch');
      const { id } = await seedProblem(db, { code: 'patchme', name: 'Old Name', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

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
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

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
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

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
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

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
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

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
      // The owner must belong to any org they attach the problem to.
      await db.insert(orgMembers).values({ orgId: orgA!.id, userId: owner.id, role: 'member' });
      await db.insert(orgMembers).values({ orgId: orgB!.id, userId: owner.id, role: 'member' });
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

      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
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

  it('an editor who is not a member of an already-attached private org can PATCH while retaining it', async () => {
    await withTestDb(async (db) => {
      const admin = await insertUser(db, 'retain-admin', 'admin');
      const author = await insertUser(db, 'retain-author');
      const [org] = await db
        .insert(organizations)
        .values({ slug: 'retain-org', name: 'Retain Org', visibility: 'private' })
        .returning();
      const { id } = await seedProblem(db, {
        code: 'retainorg',
        name: 'Retain Org Problem',
        visibility: 'org',
        createdBy: admin.id,
      });
      await db.insert(problemOrgs).values({ problemId: id, orgId: org!.id });
      // `author` is an editor of this problem (an admin added them, or
      // another author did) but was never made a member of `retain-org` —
      // exactly the setter this fix protects.
      await db.insert(problemMembers).values({ problemId: id, userId: author.id, role: 'author' });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      // Pre-fix, this rejected with 400 problem_org_unknown: resolveOrgIds
      // required membership even for an org merely being RETAINED, not
      // added, so the full set the read path now returns (spec §4.1)
      // could never be resubmitted unchanged.
      const detail = await service.update(actorFor(author.id), 'retainorg', {
        name: 'Retain Org Problem (renamed)',
        orgSlugs: ['retain-org'],
      });
      expect(detail.name).toBe('Retain Org Problem (renamed)');

      const orgs = await db.select().from(problemOrgs).where(eq(problemOrgs.problemId, id));
      expect(orgs).toHaveLength(1);
      expect(orgs[0]).toMatchObject({ orgId: org!.id });
    });
  }, 120_000);

  it('the same non-member editor still cannot ADD an org they do not belong to', async () => {
    await withTestDb(async (db) => {
      const admin = await insertUser(db, 'addcheck-admin', 'admin');
      const author = await insertUser(db, 'addcheck-author');
      const [retained] = await db
        .insert(organizations)
        .values({ slug: 'addcheck-retained', name: 'Retained', visibility: 'private' })
        .returning();
      // `author` is never made a member of this one — it's the org the
      // patch below tries (and must fail) to ADD.
      await db.insert(organizations).values({ slug: 'addcheck-target', name: 'Target', visibility: 'private' });
      const { id } = await seedProblem(db, {
        code: 'addcheck',
        name: 'Add Check',
        visibility: 'org',
        createdBy: admin.id,
      });
      await db.insert(problemOrgs).values({ problemId: id, orgId: retained!.id });
      await db.insert(problemMembers).values({ problemId: id, userId: author.id, role: 'author' });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      // Retaining `addcheck-retained` alongside a genuinely new org
      // (`addcheck-target`, which `author` does not belong to) must still be
      // rejected — the fix exempts only orgs already attached to THIS
      // problem, not every org named in a patch that happens to also
      // include one.
      await expect(
        service.update(actorFor(author.id), 'addcheck', {
          orgSlugs: ['addcheck-retained', 'addcheck-target'],
        }),
      ).rejects.toMatchObject({ status: 400, code: 'problem_org_unknown' });

      // And the rejected request must not have half-applied.
      const orgs = await db.select().from(problemOrgs).where(eq(problemOrgs.problemId, id));
      expect(orgs.map((o) => o.orgId)).toEqual([retained!.id]);
    });
  }, 120_000);

  it('removing an org you are not a member of is allowed — a removal is not an addition', async () => {
    await withTestDb(async (db) => {
      const admin = await insertUser(db, 'removecheck-admin', 'admin');
      const author = await insertUser(db, 'removecheck-author');
      const [org] = await db
        .insert(organizations)
        .values({ slug: 'removecheck-org', name: 'Remove Check', visibility: 'private' })
        .returning();
      const { id } = await seedProblem(db, {
        code: 'removecheck',
        name: 'Remove Check',
        visibility: 'private',
        createdBy: admin.id,
      });
      await db.insert(problemOrgs).values({ problemId: id, orgId: org!.id });
      await db.insert(problemMembers).values({ problemId: id, userId: author.id, role: 'author' });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      await service.update(actorFor(author.id), 'removecheck', { orgSlugs: [] });

      const orgs = await db.select().from(problemOrgs).where(eq(problemOrgs.problemId, id));
      expect(orgs).toHaveLength(0);
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
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      // The stranger can neither view nor edit this problem. The patch is
      // malformed (`code` is immutable) — if patch validation ran before the
      // visibility check, this would surface 400 problem_code_immutable
      // instead of 404, which would leak that a problem exists at this code.
      await expect(
        service.update(actorFor(stranger.id), 'oracle', { code: 'stolen' }),
      ).rejects.toMatchObject({ status: 404, code: 'problem_not_found' });
    });
  }, 120_000);

  it('resolves a member username case-insensitively', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'MixedCaseOwner');
      const { id } = await seedProblem(db, { code: 'casetest', name: 'Name', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      await service.update(actorFor(owner.id), 'casetest', {
        // Deliberately different case than the stored username.
        members: [{ username: 'mixedcaseowner', role: 'author' }],
      });

      const members = await db.select().from(problemMembers).where(eq(problemMembers.problemId, id));
      expect(members).toEqual([{ problemId: id, userId: owner.id, role: 'author' }]);
    });
  }, 120_000);

  it('a duplicate members entry does not crash, and a user with two roles keeps both', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'dedupe-owner');
      const other = await insertUser(db, 'dedupe-other');
      const { id } = await seedProblem(db, { code: 'dedupe', name: 'Name', createdBy: owner.id });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      await service.update(actorFor(owner.id), 'dedupe', {
        members: [
          { username: 'dedupe-owner', role: 'author' },
          // Exact duplicate of the row above: must be deduped before the
          // INSERT, or `problemMembers`'s (problemId, userId, role) primary
          // key rejects it as a 500.
          { username: 'dedupe-owner', role: 'author' },
          // Same duplicate again, but case-varied: resolution is
          // case-insensitive, so this resolves to the identical row and
          // must be caught by the SAME dedupe — not skipped because the
          // input strings themselves differ.
          { username: 'DEDUPE-OWNER', role: 'author' },
          { username: 'dedupe-other', role: 'author' },
          // Same user, a different role: legitimately two rows, not a duplicate.
          { username: 'dedupe-other', role: 'curator' },
        ],
      });

      const members = await db.select().from(problemMembers).where(eq(problemMembers.problemId, id));
      expect(members).toHaveLength(3);
      expect(members).toEqual(
        expect.arrayContaining([
          { problemId: id, userId: owner.id, role: 'author' },
          { problemId: id, userId: other.id, role: 'author' },
          { problemId: id, userId: other.id, role: 'curator' },
        ]),
      );
    });
  }, 120_000);

  it('falls back to counting already-attached orgs when orgSlugs is absent from the patch', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'org-fallback-owner');
      const [org] = await db
        .insert(organizations)
        .values({ slug: 'fallback-org', name: 'Fallback Org', visibility: 'private' })
        .returning();
      const { id } = await seedProblem(db, {
        code: 'orgfallback',
        name: 'Name',
        visibility: 'org',
        createdBy: owner.id,
      });
      await db.insert(problemMembers).values({ problemId: id, userId: owner.id, role: 'author' });
      await db.insert(problemOrgs).values({ problemId: id, orgId: org!.id });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      // No `orgSlugs` key in the patch at all — the `problem_org_required`
      // check must fall back to counting the org already attached in the
      // database, rather than treating the key's absence as zero orgs.
      const detail = await service.update(actorFor(owner.id), 'orgfallback', { visibility: 'org' });
      expect(detail.visibility).toBe('org');

      const orgs = await db.select().from(problemOrgs).where(eq(problemOrgs.problemId, id));
      expect(orgs).toHaveLength(1);
    });
  }, 120_000);
});
