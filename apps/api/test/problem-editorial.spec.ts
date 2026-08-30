import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '@duckoj/db';
import { schema } from '@duckoj/db';
import {
  contestParticipations,
  contestProblems,
  contests,
  problemMembers,
  problemRevisions,
  problems,
  submissions,
} from '@duckoj/db/guarded';
import type { Actor } from '../src/authz/actor.js';
import { ProblemAccessService } from '../src/authz/problem.access.js';
import { AppError } from '../src/common/app.error.js';
import type { PackageStore } from '../src/packages/package.store.js';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { bypassCache } from './cache.harness.js';
import { insertUser } from './submissions.fixtures.js';

/**
 * D43 — who may read an editorial. Every branch of the ruling has a case
 * here, because the ruling is entirely made of branches: published or not,
 * editor or not, solved or not, sitting a running contest or not.
 *
 * The two response fields are asserted TOGETHER everywhere. For a
 * non-editor they must agree (`editorial !== null` iff `editorialAvailable`),
 * and the whole point of the design is that "absent", "unpublished" and
 * "withheld" are one indistinguishable answer — a test that only looked at
 * `editorialAvailable` would pass while `editorial` leaked the text.
 */

function actorFor(userId: number, globalRole: 'user' | 'admin' = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

const UNUSED_STORE: PackageStore = {
  has: () => Promise.reject(new Error('unexpected package store access in this test')),
  put: () => Promise.reject(new Error('unexpected package store access in this test')),
  get: () => Promise.reject(new Error('unexpected package store access in this test')),
  delete: () => Promise.reject(new Error('unexpected package store access in this test')),
};

const EDITORIAL = '## Lời giải\n\nCộng hai số.\n\n## Editorial\n\nAdd two numbers.';

async function seedProblem(
  db: Db,
  opts: {
    code: string;
    createdBy: number;
    editorial?: string | null;
    published?: boolean;
    memberIds?: number[];
  },
): Promise<{ id: number }> {
  const [problem] = await db
    .insert(problems)
    .values({
      code: opts.code,
      name: opts.code,
      statement: 'statement',
      visibility: 'public',
      editorial: opts.editorial ?? null,
      editorialPublishedAt: opts.published ? new Date() : null,
      createdBy: opts.createdBy,
    })
    .returning();
  await db.insert(problemMembers).values({ problemId: problem!.id, userId: opts.createdBy, role: 'author' });
  for (const userId of opts.memberIds ?? []) {
    await db.insert(problemMembers).values({ problemId: problem!.id, userId, role: 'curator' });
  }
  return { id: problem!.id };
}

/** A contest with `problemId` in it, running now unless `running: false`. */
async function seedContest(
  db: Db,
  opts: { key: string; createdBy: number; problemId: number; participantIds: number[]; running?: boolean },
): Promise<number> {
  const now = Date.now();
  const [start, end] = opts.running === false ? [now - 7_200_000, now - 3_600_000] : [now - 3_600_000, now + 3_600_000];
  const [contest] = await db
    .insert(contests)
    .values({
      key: opts.key,
      name: opts.key,
      startTime: new Date(start),
      endTime: new Date(end),
      format: 'icpc',
      visibility: 'public',
      createdBy: opts.createdBy,
    })
    .returning({ id: contests.id });
  await db
    .insert(contestProblems)
    .values({ contestId: contest!.id, problemId: opts.problemId, label: 'A', points: 100, order: 0 });
  for (const userId of opts.participantIds) {
    await db.insert(contestParticipations).values({ contestId: contest!.id, userId, startTime: new Date(start) });
  }
  return contest!.id;
}

/** An accepted, graded submission — what D43's "has solved it" branch keys on. */
async function seedSubmission(
  db: Db,
  opts: { problemId: number; userId: number; verdict: 'AC' | 'WA' },
): Promise<void> {
  const key = `cpp-${String(opts.problemId)}-${String(opts.userId)}`;
  const [language] = await db
    .insert(schema.languages)
    .values({ key, name: key, extension: 'cpp' })
    .returning({ id: schema.languages.id });
  const hash = `ed-${key}`;
  await db.insert(schema.packages).values({ hash, sizeBytes: 1, fileCount: 1 });
  // A version per call: two submissions to the same problem would otherwise
  // collide on `problem_revisions_version_idx`.
  const existing = await db
    .select({ id: problemRevisions.id })
    .from(problemRevisions)
    .where(eq(problemRevisions.problemId, opts.problemId));
  const [revision] = await db
    .insert(problemRevisions)
    .values({
      problemId: opts.problemId,
      version: existing.length + 1,
      packageHash: hash,
      // `draft`: `problem_revisions_one_published_idx` allows exactly one
      // published revision per problem, and this fixture is called twice on
      // the same problem. Nothing here reads the state — a submission just
      // needs a revision to point at.
      state: 'draft',
      createdBy: opts.userId,
      timeMs: 1000,
      memoryKb: 256_000,
      testCount: 1,
      totalPoints: 100,
      checkerKind: 'wcmp',
    })
    .returning({ id: problemRevisions.id });
  await db.insert(submissions).values({
    userId: opts.userId,
    problemId: opts.problemId,
    revisionId: revision!.id,
    languageId: language!.id,
    source: 'int main(){}',
    state: 'done',
    verdict: opts.verdict,
    points: opts.verdict === 'AC' ? 100 : 0,
    maxPoints: 100,
  });
}

describe('editorial visibility (D43)', () => {
  it('reports no editorial at all as null and unavailable, for everyone', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'ed-none-owner');
      await seedProblem(db, { code: 'ed-none', createdBy: owner.id });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      for (const actor of [null, actorFor(owner.id)]) {
        const detail = await service.getVisible(actor, 'ed-none');
        expect(detail.editorial).toBeNull();
        expect(detail.editorialAvailable).toBe(false);
      }
      await expect(service.getEditorial(null, 'ed-none')).rejects.toBeInstanceOf(AppError);
    });
  }, 120_000);

  it('hides an unpublished draft from a reader but hands it to its author', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'ed-draft-owner');
      const reader = await insertUser(db, 'ed-draft-reader');
      await seedProblem(db, { code: 'ed-draft', createdBy: owner.id, editorial: EDITORIAL });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      // A reader cannot tell this apart from "there is no editorial".
      const asReader = await service.getVisible(actorFor(reader.id), 'ed-draft');
      expect(asReader.editorial).toBeNull();
      expect(asReader.editorialAvailable).toBe(false);
      await expect(service.getEditorial(actorFor(reader.id), 'ed-draft')).rejects.toMatchObject({ status: 404 });

      // The author gets the draft — the edit form seeds from this field —
      // and `editorialAvailable` still reports the publish state, which is
      // what the publish toggle seeds from.
      const asAuthor = await service.getVisible(actorFor(owner.id), 'ed-draft');
      expect(asAuthor.editorial).toBe(EDITORIAL);
      expect(asAuthor.editorialAvailable).toBe(false);
      await expect(service.getEditorial(actorFor(owner.id), 'ed-draft')).resolves.toEqual({ markdown: EDITORIAL });
    });
  }, 120_000);

  it('serves a published editorial to an anonymous reader and over the dedicated route', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'ed-pub-owner');
      await seedProblem(db, { code: 'ed-pub', createdBy: owner.id, editorial: EDITORIAL, published: true });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const detail = await service.getVisible(null, 'ed-pub');
      expect(detail.editorial).toBe(EDITORIAL);
      expect(detail.editorialAvailable).toBe(true);
      await expect(service.getEditorial(null, 'ed-pub')).resolves.toEqual({ markdown: EDITORIAL });
    });
  }, 120_000);

  it('404s the editorial route for a problem the caller may not see at all', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'ed-priv-owner');
      const stranger = await insertUser(db, 'ed-priv-stranger');
      const { id } = await seedProblem(db, {
        code: 'ed-priv',
        createdBy: owner.id,
        editorial: EDITORIAL,
        published: true,
      });
      await db.update(problems).set({ visibility: 'private' }).where(eq(problems.id, id));
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      // `problem_not_found`, not an editorial-level code: the problem's own
      // invisibility is decided first, and the editorial never gets a say.
      await expect(service.getEditorial(actorFor(stranger.id), 'ed-priv')).rejects.toMatchObject({
        status: 404,
        code: 'problem_not_found',
      });
    });
  }, 120_000);

  it('withholds it from a participant sitting a contest that uses the problem', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'ed-contest-owner');
      const sitter = await insertUser(db, 'ed-contest-sitter');
      const { id } = await seedProblem(db, {
        code: 'ed-contest',
        createdBy: owner.id,
        editorial: EDITORIAL,
        published: true,
      });
      await seedContest(db, { key: 'live', createdBy: owner.id, problemId: id, participantIds: [sitter.id] });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const detail = await service.getVisible(actorFor(sitter.id), 'ed-contest');
      expect(detail.editorial).toBeNull();
      expect(detail.editorialAvailable).toBe(false);
      await expect(service.getEditorial(actorFor(sitter.id), 'ed-contest')).rejects.toMatchObject({ status: 404 });

      // Someone not in the room reads it as normal — the mask is about the
      // contest, not about the problem.
      const bystander = await insertUser(db, 'ed-contest-bystander');
      const other = await service.getVisible(actorFor(bystander.id), 'ed-contest');
      expect(other.editorial).toBe(EDITORIAL);
      expect(other.editorialAvailable).toBe(true);
    });
  }, 120_000);

  it('gives it back to a participant who has already solved the problem', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'ed-ac-owner');
      const solver = await insertUser(db, 'ed-ac-solver');
      const struggler = await insertUser(db, 'ed-ac-struggler');
      const { id } = await seedProblem(db, {
        code: 'ed-ac',
        createdBy: owner.id,
        editorial: EDITORIAL,
        published: true,
      });
      await seedContest(db, {
        key: 'live-ac',
        createdBy: owner.id,
        problemId: id,
        participantIds: [solver.id, struggler.id],
      });
      await seedSubmission(db, { problemId: id, userId: solver.id, verdict: 'AC' });
      await seedSubmission(db, { problemId: id, userId: struggler.id, verdict: 'WA' });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const solved = await service.getVisible(actorFor(solver.id), 'ed-ac');
      expect(solved.editorial).toBe(EDITORIAL);
      expect(solved.editorialAvailable).toBe(true);

      // A wrong answer is not a solve: the branch keys on an AC existing,
      // not on having submitted.
      const unsolved = await service.getVisible(actorFor(struggler.id), 'ed-ac');
      expect(unsolved.editorial).toBeNull();
      expect(unsolved.editorialAvailable).toBe(false);
    });
  }, 120_000);

  it('gives it back to everyone once the contest has ended', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'ed-past-owner');
      const sitter = await insertUser(db, 'ed-past-sitter');
      const { id } = await seedProblem(db, {
        code: 'ed-past',
        createdBy: owner.id,
        editorial: EDITORIAL,
        published: true,
      });
      await seedContest(db, {
        key: 'over',
        createdBy: owner.id,
        problemId: id,
        participantIds: [sitter.id],
        running: false,
      });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      // Nothing was stored and nothing was scheduled — this is a clock
      // question, exactly as D35 is.
      const detail = await service.getVisible(actorFor(sitter.id), 'ed-past');
      expect(detail.editorial).toBe(EDITORIAL);
      expect(detail.editorialAvailable).toBe(true);
    });
  }, 120_000);

  it("exempts the contest's own organiser and any global admin", async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'ed-exempt-owner');
      const organiser = await insertUser(db, 'ed-exempt-organiser');
      const admin = await insertUser(db, 'ed-exempt-admin');
      const { id } = await seedProblem(db, {
        code: 'ed-exempt',
        createdBy: owner.id,
        editorial: EDITORIAL,
        published: true,
      });
      // The organiser is NOT a member of the problem — this exemption comes
      // from the contest's `created_by`, not from `canEditProblem`, and the
      // two must be tested apart or a mutation dropping one still passes.
      await seedContest(db, {
        key: 'organised',
        createdBy: organiser.id,
        problemId: id,
        participantIds: [organiser.id, admin.id],
      });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const asOrganiser = await service.getVisible(actorFor(organiser.id), 'ed-exempt');
      expect(asOrganiser.editorialAvailable).toBe(true);
      expect(asOrganiser.editorial).toBe(EDITORIAL);

      const asAdmin = await service.getVisible(actorFor(admin.id, 'admin'), 'ed-exempt');
      expect(asAdmin.editorialAvailable).toBe(true);
      expect(asAdmin.editorial).toBe(EDITORIAL);
    });
  }, 120_000);

  it("hands a problem editor the editorial even while they sit the contest", async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'ed-editor-owner');
      const curator = await insertUser(db, 'ed-editor-curator');
      const { id } = await seedProblem(db, {
        code: 'ed-editor',
        createdBy: owner.id,
        editorial: EDITORIAL,
        published: true,
        memberIds: [curator.id],
      });
      // Organised by someone else, so only `canEditProblem` can exempt them.
      const organiser = await insertUser(db, 'ed-editor-organiser');
      await seedContest(db, {
        key: 'editor-sits',
        createdBy: organiser.id,
        problemId: id,
        participantIds: [curator.id],
      });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const detail = await service.getVisible(actorFor(curator.id), 'ed-editor');
      expect(detail.editorial).toBe(EDITORIAL);
      expect(detail.editorialAvailable).toBe(true);
    });
  }, 120_000);
});

describe('editorial writes', () => {
  it('stores a draft, publishes it, and echoes both back to the author', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'ed-write-owner');
      await seedProblem(db, { code: 'ed-write', createdBy: owner.id });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
      const actor = actorFor(owner.id);

      const drafted = await service.update(actor, 'ed-write', { editorial: EDITORIAL });
      // The PATCH echoes what it wrote — the mask lives on the read paths.
      expect(drafted.editorial).toBe(EDITORIAL);
      expect(drafted.editorialAvailable).toBe(false);

      const published = await service.update(actor, 'ed-write', { editorialPublished: true });
      expect(published.editorial).toBe(EDITORIAL);
      expect(published.editorialAvailable).toBe(true);

      const unpublished = await service.update(actor, 'ed-write', { editorialPublished: false });
      expect(unpublished.editorial).toBe(EDITORIAL);
      expect(unpublished.editorialAvailable).toBe(false);
    });
  }, 120_000);

  it('does not move the publish date when an already-published editorial is republished', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'ed-idem-owner');
      const { id } = await seedProblem(db, {
        code: 'ed-idem',
        createdBy: owner.id,
        editorial: EDITORIAL,
        published: true,
      });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
      const [before] = await db
        .select({ at: problems.editorialPublishedAt })
        .from(problems)
        .where(eq(problems.id, id));

      await service.update(actorFor(owner.id), 'ed-idem', { editorialPublished: true, name: 'renamed' });

      const [after] = await db
        .select({ at: problems.editorialPublishedAt })
        .from(problems)
        .where(eq(problems.id, id));
      expect(after!.at!.getTime()).toBe(before!.at!.getTime());
    });
  }, 120_000);

  it('unpublishes when the text is cleared, in the same write', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'ed-clear-owner');
      const { id } = await seedProblem(db, {
        code: 'ed-clear',
        createdBy: owner.id,
        editorial: EDITORIAL,
        published: true,
      });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const cleared = await service.update(actorFor(owner.id), 'ed-clear', { editorial: null });
      expect(cleared.editorial).toBeNull();
      expect(cleared.editorialAvailable).toBe(false);
      const [row] = await db
        .select({ at: problems.editorialPublishedAt })
        .from(problems)
        .where(eq(problems.id, id));
      expect(row!.at).toBeNull();
    });
  }, 120_000);

  it('refuses to publish an editorial there is no text for', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'ed-empty-owner');
      await seedProblem(db, { code: 'ed-empty', createdBy: owner.id });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());
      const actor = actorFor(owner.id);

      await expect(service.update(actor, 'ed-empty', { editorialPublished: true })).rejects.toMatchObject({
        status: 422,
        code: 'problem_editorial_empty',
      });
      // Whitespace is not text either.
      await expect(
        service.update(actor, 'ed-empty', { editorial: '   \n ', editorialPublished: true }),
      ).rejects.toMatchObject({ status: 422, code: 'problem_editorial_empty' });
      // Nor is clearing and publishing in one request.
      await expect(
        service.update(actor, 'ed-empty', { editorial: null, editorialPublished: true }),
      ).rejects.toMatchObject({ status: 422, code: 'problem_editorial_empty' });

      // And the refused PATCH left nothing behind — it is one transaction.
      const detail = await service.getVisible(actor, 'ed-empty');
      expect(detail.editorial).toBeNull();
    });
  }, 120_000);

  it('leaves the editorial alone when the patch mentions neither key', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'ed-untouched-owner');
      await seedProblem(db, {
        code: 'ed-untouched',
        createdBy: owner.id,
        editorial: EDITORIAL,
        published: true,
      });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      const detail = await service.update(actorFor(owner.id), 'ed-untouched', { name: 'still here' });
      expect(detail.editorial).toBe(EDITORIAL);
      expect(detail.editorialAvailable).toBe(true);
    });
  }, 120_000);

  it('refuses a non-editor outright, before any editorial state is consulted', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'ed-forbid-owner');
      const stranger = await insertUser(db, 'ed-forbid-stranger');
      await seedProblem(db, { code: 'ed-forbid', createdBy: owner.id });
      const service = new ProblemAccessService(db, UNUSED_STORE, bypassCache());

      await expect(
        service.update(actorFor(stranger.id), 'ed-forbid', { editorial: EDITORIAL }),
      ).rejects.toMatchObject({ status: 403 });
    });
  }, 120_000);
});

describe('GET /problems/{code}/editorial over HTTP', () => {
  it('serves a published editorial to an anonymous caller and 404s an unpublished one', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'ed-http-owner');
      await seedProblem(db, { code: 'ed-http-pub', createdBy: owner.id, editorial: EDITORIAL, published: true });
      await seedProblem(db, { code: 'ed-http-draft', createdBy: owner.id, editorial: EDITORIAL });
      const app = await buildApp(db);
      try {
        // No credentials at all: the route is `@Public()`, and an editorial
        // outside any contest is published content.
        const published = await request(app.getHttpServer()).get('/api/v1/problems/ed-http-pub/editorial');
        expect(published.status).toBe(200);
        expect(published.body).toEqual({ markdown: EDITORIAL });

        const draft = await request(app.getHttpServer()).get('/api/v1/problems/ed-http-draft/editorial');
        expect(draft.status).toBe(404);
        expect(draft.body.code).toBe('editorial_not_found');
        // Not `problem_not_found` — the problem itself is plainly visible,
        // and pretending otherwise would be a different lie, not a smaller one.
        const missing = await request(app.getHttpServer()).get('/api/v1/problems/ed-http-absent/editorial');
        expect(missing.status).toBe(404);
        expect(missing.body.code).toBe('problem_not_found');

        // The detail route carries the same answer, both fields agreeing.
        const detail = await request(app.getHttpServer()).get('/api/v1/problems/ed-http-draft');
        expect(detail.body.editorial).toBeNull();
        expect(detail.body.editorialAvailable).toBe(false);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
