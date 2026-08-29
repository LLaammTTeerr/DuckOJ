import { describe, expect, it } from 'vitest';
import { asc, eq, inArray } from 'drizzle-orm';
import { schema } from '@duckoj/db';
import type { Db } from '@duckoj/db';
import {
  contestParticipations,
  contestProblems,
  contests,
  problemMembers,
  problemTags,
  problems,
} from '@duckoj/db/guarded';
import type { Actor } from '../src/authz/actor.js';
import { ProblemAccessService } from '../src/authz/problem.access.js';
import { AppError } from '../src/common/app.error.js';
import type { PackageStore } from '../src/packages/package.store.js';
import { withTestDb } from './db.harness.js';
import { insertUser } from './submissions.fixtures.js';

function actorFor(userId: number, globalRole: 'user' | 'admin' = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

const UNUSED_STORE: PackageStore = {
  has: () => Promise.reject(new Error('unexpected package store access in this test')),
  put: () => Promise.reject(new Error('unexpected package store access in this test')),
  get: () => Promise.reject(new Error('unexpected package store access in this test')),
  delete: () => Promise.reject(new Error('unexpected package store access in this test')),
};

async function seedProblem(
  db: Db,
  opts: { code: string; createdBy: number; difficulty?: number | null; tagSlugs?: string[] },
): Promise<{ id: number }> {
  const [problem] = await db
    .insert(problems)
    .values({
      code: opts.code,
      name: opts.code,
      statement: 'statement',
      visibility: 'public',
      difficulty: opts.difficulty ?? null,
      createdBy: opts.createdBy,
    })
    .returning();
  await db.insert(problemMembers).values({ problemId: problem!.id, userId: opts.createdBy, role: 'author' });
  if (opts.tagSlugs && opts.tagSlugs.length > 0) {
    const tagRows = await db
      .select({ id: schema.tags.id })
      .from(schema.tags)
      .where(inArray(schema.tags.slug, opts.tagSlugs));
    expect(tagRows).toHaveLength(opts.tagSlugs.length);
    await db.insert(problemTags).values(tagRows.map((t) => ({ problemId: problem!.id, tagId: t.id })));
  }
  return { id: problem!.id };
}

/** A contest running right now, with `problemId` in it, `createdBy` running it. */
async function seedRunningContest(
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
    await db
      .insert(contestParticipations)
      .values({ contestId: contest!.id, userId, startTime: new Date(start) });
  }
  return contest!.id;
}

describe('tags and difficulty on reads', () => {
  it('carries the tags of a problem, ordered by slug, on both the list and the detail', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'tag-owner');
      await seedProblem(db, { code: 'graphs', createdBy: owner.id, difficulty: 6, tagSlugs: ['do-thi', 'cay'] });
      const service = new ProblemAccessService(db, UNUSED_STORE);

      const page = await service.listVisible(null, { limit: 25 });
      expect(page.items).toHaveLength(1);
      // Ordered by slug — `cay` before `do-thi` — so a chip row is stable
      // between two renders and a test can assert on it at all.
      expect(page.items[0]!.tags.map((t) => t.slug)).toEqual(['cay', 'do-thi']);
      expect(page.items[0]!.tags[1]).toEqual({ slug: 'do-thi', nameVi: 'Đồ thị', nameEn: 'Graphs' });
      expect(page.items[0]!.difficulty).toBe(6);

      const detail = await service.getVisible(null, 'graphs');
      expect(detail.tags.map((t) => t.slug)).toEqual(['cay', 'do-thi']);
      expect(detail.difficulty).toBe(6);
    });
  }, 120_000);

  it('reports an untagged problem as an empty list and a null difficulty', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'bare-owner');
      await seedProblem(db, { code: 'bare', createdBy: owner.id });
      const service = new ProblemAccessService(db, UNUSED_STORE);

      const page = await service.listVisible(null, { limit: 25 });
      expect(page.items[0]!.tags).toEqual([]);
      expect(page.items[0]!.difficulty).toBeNull();
    });
  }, 120_000);
});

describe('filtering by tag', () => {
  it('ANDs repeated tags rather than ORing them', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'and-owner');
      await seedProblem(db, { code: 'both', createdBy: owner.id, tagSlugs: ['do-thi', 'quy-hoach-dong'] });
      await seedProblem(db, { code: 'graph-only', createdBy: owner.id, tagSlugs: ['do-thi'] });
      await seedProblem(db, { code: 'dp-only', createdBy: owner.id, tagSlugs: ['quy-hoach-dong'] });
      await seedProblem(db, { code: 'neither', createdBy: owner.id });
      const service = new ProblemAccessService(db, UNUSED_STORE);

      const both = await service.listVisible(null, { limit: 25 }, { tags: ['do-thi', 'quy-hoach-dong'] });
      expect(both.items.map((p) => p.code)).toEqual(['both']);

      const one = await service.listVisible(null, { limit: 25 }, { tags: ['do-thi'] });
      expect(one.items.map((p) => p.code).sort()).toEqual(['both', 'graph-only']);
    });
  }, 120_000);

  it('answers an unknown tag slug with an empty page, never a widened one', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'unknown-owner');
      await seedProblem(db, { code: 'tagged', createdBy: owner.id, tagSlugs: ['do-thi'] });
      const service = new ProblemAccessService(db, UNUSED_STORE);

      // The AND counts against the number of slugs REQUESTED, not the number
      // resolved — otherwise an unrecognised slug would silently drop out of
      // the conjunction and widen the result to whatever the rest matched.
      expect((await service.listVisible(null, { limit: 25 }, { tags: ['no-such-tag'] })).items).toEqual([]);
      expect(
        (await service.listVisible(null, { limit: 25 }, { tags: ['do-thi', 'no-such-tag'] })).items,
      ).toEqual([]);
    });
  }, 120_000);

  it('never counts one tag twice toward the AND', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'dupe-owner');
      await seedProblem(db, { code: 'graph', createdBy: owner.id, tagSlugs: ['do-thi'] });
      const service = new ProblemAccessService(db, UNUSED_STORE);

      const page = await service.listVisible(null, { limit: 25 }, { tags: ['do-thi', 'do-thi'] });
      expect(page.items.map((p) => p.code)).toEqual(['graph']);
    });
  }, 120_000);

  it('filters a difficulty range, and never matches an unset difficulty', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'range-owner');
      await seedProblem(db, { code: 'easy', createdBy: owner.id, difficulty: 2 });
      await seedProblem(db, { code: 'medium', createdBy: owner.id, difficulty: 5 });
      await seedProblem(db, { code: 'hard', createdBy: owner.id, difficulty: 9 });
      await seedProblem(db, { code: 'unrated', createdBy: owner.id });
      const service = new ProblemAccessService(db, UNUSED_STORE);

      expect(
        (await service.listVisible(null, { limit: 25 }, { difficultyMin: 3, difficultyMax: 7 })).items.map(
          (p) => p.code,
        ),
      ).toEqual(['medium']);
      expect(
        (await service.listVisible(null, { limit: 25 }, { difficultyMin: 5 })).items.map((p) => p.code),
      ).toEqual(['medium', 'hard']);
      expect(
        (await service.listVisible(null, { limit: 25 }, { difficultyMax: 5 })).items.map((p) => p.code),
      ).toEqual(['easy', 'medium']);
    });
  }, 120_000);

  it('combines a tag filter with the search text', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'combo-owner');
      await seedProblem(db, { code: 'graph-walk', createdBy: owner.id, tagSlugs: ['do-thi'] });
      await seedProblem(db, { code: 'graph-flow', createdBy: owner.id, tagSlugs: ['luong'] });
      const service = new ProblemAccessService(db, UNUSED_STORE);

      const page = await service.listVisible(null, { limit: 25 }, { q: 'graph', tags: ['do-thi'] });
      expect(page.items.map((p) => p.code)).toEqual(['graph-walk']);
    });
  }, 120_000);
});

describe('D35 — tags and difficulty are hidden during a contest the viewer is sitting', () => {
  it('hides them from a participant while the contest runs', async () => {
    await withTestDb(async (db) => {
      const organiser = await insertUser(db, 'd35-organiser');
      const student = await insertUser(db, 'd35-student');
      const staff = await insertUser(db, 'd35-staff');
      const outsider = await insertUser(db, 'd35-outsider');
      const { id } = await seedProblem(db, {
        code: 'live',
        createdBy: organiser.id,
        difficulty: 7,
        tagSlugs: ['do-thi'],
      });
      // The organiser and the admin hold participations of their own, so the
      // two exemptions below are load-bearing rather than incidentally true:
      // without them, "is a participant in a running contest" would be
      // satisfied by all three of these actors, not just the student.
      await seedRunningContest(db, {
        key: 'live-cup',
        createdBy: organiser.id,
        problemId: id,
        participantIds: [student.id, organiser.id, staff.id],
      });
      const service = new ProblemAccessService(db, UNUSED_STORE);

      const hidden = await service.getVisible(actorFor(student.id), 'live');
      expect(hidden.tags).toEqual([]);
      expect(hidden.difficulty).toBeNull();
      const hiddenList = await service.listVisible(actorFor(student.id), { limit: 25 });
      expect(hiddenList.items[0]!.tags).toEqual([]);
      expect(hiddenList.items[0]!.difficulty).toBeNull();

      // Nobody else is affected: the organiser, an admin, an unrelated
      // signed-in viewer and an anonymous one all still see the hint.
      for (const viewer of [actorFor(organiser.id), actorFor(staff.id, 'admin'), actorFor(outsider.id), null]) {
        const shown = await service.getVisible(viewer, 'live');
        expect(shown.tags.map((t) => t.slug), `viewer ${String(viewer?.userId)}`).toEqual(['do-thi']);
        expect(shown.difficulty).toBe(7);
      }
    });
  }, 120_000);

  it('shows them again once the contest has finished', async () => {
    await withTestDb(async (db) => {
      const organiser = await insertUser(db, 'over-organiser');
      const student = await insertUser(db, 'over-student');
      const { id } = await seedProblem(db, {
        code: 'over',
        createdBy: organiser.id,
        difficulty: 4,
        tagSlugs: ['cay'],
      });
      await seedRunningContest(db, {
        key: 'over-cup',
        createdBy: organiser.id,
        problemId: id,
        participantIds: [student.id],
        running: false,
      });
      const service = new ProblemAccessService(db, UNUSED_STORE);

      const detail = await service.getVisible(actorFor(student.id), 'over');
      expect(detail.tags.map((t) => t.slug)).toEqual(['cay']);
      expect(detail.difficulty).toBe(4);
    });
  }, 120_000);

  it('keeps a hidden problem out of a tag- or difficulty-filtered page entirely', async () => {
    await withTestDb(async (db) => {
      const organiser = await insertUser(db, 'oracle-organiser');
      const student = await insertUser(db, 'oracle-student');
      const { id } = await seedProblem(db, {
        code: 'secret',
        createdBy: organiser.id,
        difficulty: 8,
        tagSlugs: ['do-thi'],
      });
      await seedProblem(db, { code: 'ordinary', createdBy: organiser.id, difficulty: 8, tagSlugs: ['do-thi'] });
      await seedRunningContest(db, {
        key: 'oracle-cup',
        createdBy: organiser.id,
        problemId: id,
        participantIds: [student.id],
      });
      const service = new ProblemAccessService(db, UNUSED_STORE);
      const student1 = actorFor(student.id);

      // Masking `tags` alone would leave the FILTER as an oracle: ask for
      // `?tag=do-thi` and the contest problem coming back would say exactly
      // what the empty chip row refused to. A filtered page therefore omits
      // it entirely — the filter runs over the masked view, not under it.
      expect(
        (await service.listVisible(student1, { limit: 25 }, { tags: ['do-thi'] })).items.map((p) => p.code),
      ).toEqual(['ordinary']);
      expect(
        (await service.listVisible(student1, { limit: 25 }, { difficultyMin: 8 })).items.map((p) => p.code),
      ).toEqual(['ordinary']);
      // ...but an unfiltered page still lists it, with the hint blanked —
      // hiding the tags must not hide the problem.
      const all = await service.listVisible(student1, { limit: 25 });
      expect(all.items.map((p) => p.code)).toEqual(['secret', 'ordinary']);
      expect(all.items[0]!.tags).toEqual([]);
    });
  }, 120_000);
});

describe('writing tags and difficulty', () => {
  it('replaces the whole tag set and stores the difficulty', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'write-owner');
      const { id } = await seedProblem(db, { code: 'writable', createdBy: owner.id, tagSlugs: ['do-thi'] });
      const service = new ProblemAccessService(db, UNUSED_STORE);

      const patched = await service.update(actorFor(owner.id), 'writable', {
        tags: ['cay', 'so-hoc'],
        difficulty: 3,
      });
      expect(patched.tags.map((t) => t.slug)).toEqual(['cay', 'so-hoc']);
      expect(patched.difficulty).toBe(3);

      // A replacement, not a merge: `do-thi` is gone from the table itself.
      const rows = await db
        .select({ slug: schema.tags.slug })
        .from(problemTags)
        .innerJoin(schema.tags, eq(schema.tags.id, problemTags.tagId))
        .where(eq(problemTags.problemId, id))
        .orderBy(asc(schema.tags.slug));
      expect(rows.map((r) => r.slug)).toEqual(['cay', 'so-hoc']);
    });
  }, 120_000);

  it('clears the difficulty on an explicit null and leaves it on an omitted key', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'null-owner');
      await seedProblem(db, { code: 'clearable', createdBy: owner.id, difficulty: 5 });
      const service = new ProblemAccessService(db, UNUSED_STORE);

      const untouched = await service.update(actorFor(owner.id), 'clearable', { name: 'Renamed' });
      expect(untouched.difficulty).toBe(5);

      const cleared = await service.update(actorFor(owner.id), 'clearable', { difficulty: null });
      expect(cleared.difficulty).toBeNull();
    });
  }, 120_000);

  it('empties the tag set on an empty array', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'empty-owner');
      await seedProblem(db, { code: 'emptyable', createdBy: owner.id, tagSlugs: ['do-thi', 'cay'] });
      const service = new ProblemAccessService(db, UNUSED_STORE);

      const patched = await service.update(actorFor(owner.id), 'emptyable', { tags: [] });
      expect(patched.tags).toEqual([]);
    });
  }, 120_000);

  it('refuses an unknown tag slug with 422 problem_tag_unknown, applying nothing', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'bad-tag-owner');
      await seedProblem(db, { code: 'unchanged', createdBy: owner.id, tagSlugs: ['do-thi'] });
      const service = new ProblemAccessService(db, UNUSED_STORE);

      await expect(
        service.update(actorFor(owner.id), 'unchanged', { name: 'New name', tags: ['do-thi', 'nope'] }),
      ).rejects.toMatchObject({ status: 422, code: 'problem_tag_unknown' });

      // Resolution happens BEFORE the transaction opens, so a bad slug
      // leaves the name — and the old tag set — exactly as they were.
      const after = await service.getVisible(actorFor(owner.id), 'unchanged');
      expect(after.name).toBe('unchanged');
      expect(after.tags.map((t) => t.slug)).toEqual(['do-thi']);
    });
  }, 120_000);

  it('refuses to tag a problem the actor may not edit, before it validates the slugs', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'guarded-owner');
      const stranger = await insertUser(db, 'guarded-stranger');
      await seedProblem(db, { code: 'guarded', createdBy: owner.id });
      const service = new ProblemAccessService(db, UNUSED_STORE);

      await expect(
        service.update(actorFor(stranger.id), 'guarded', { tags: ['do-thi'] }),
      ).rejects.toBeInstanceOf(AppError);
    });
  }, 120_000);
});
