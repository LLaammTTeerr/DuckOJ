import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@duckoj/db';
import { schema } from '@duckoj/db';
import {
  contestOrgs,
  contestParticipations,
  contestProblems,
  contests,
  organizations,
  problems,
  teamMembers,
  teams,
} from '@duckoj/db/guarded';
import type { Actor } from '../src/authz/actor.js';
import { ProblemCommentsService } from '../src/authz/problem.comments.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { RateLimiter } from '../src/common/rate-limiter.js';
import { AppError } from '../src/common/app.error.js';
import { withTestDb } from './db.harness.js';
import { insertUser } from './submissions.fixtures.js';

/**
 * D109 — comments on problems (thảo luận). Every branch of the ruling has a
 * case here: visibility follows the problem's own 404, a reply is one level
 * deep, the whole thread is withheld from a viewer sitting a running contest
 * that uses the problem, a deleted comment is a tombstone only while it
 * anchors a reply, the write is metered, and a reply notifies the parent's
 * author but never on a self-reply.
 */

function actorFor(userId: number, globalRole: 'user' | 'admin' = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

function svc(db: Db): ProblemCommentsService {
  return new ProblemCommentsService(db, new RateLimiter(db), new NotificationsService(db));
}

async function seedProblem(
  db: Db,
  opts: { code: string; createdBy: number; visibility?: 'public' | 'private' },
): Promise<{ id: number }> {
  const [problem] = await db
    .insert(problems)
    .values({
      code: opts.code,
      name: opts.code,
      statement: 'statement',
      visibility: opts.visibility ?? 'public',
      createdBy: opts.createdBy,
    })
    .returning({ id: problems.id });
  return { id: problem!.id };
}

/** A contest with `problemId` in it, running now unless `running: false`. */
async function seedContest(
  db: Db,
  opts: { key: string; createdBy: number; problemId: number; participantIds: number[]; running?: boolean },
): Promise<void> {
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
}

describe('problem comments (D109)', () => {
  it('serves a thread with one level of replies, oldest first', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'c-owner');
      const a = await insertUser(db, 'c-a');
      const b = await insertUser(db, 'c-b');
      await seedProblem(db, { code: 'c-thread', createdBy: owner.id });
      const service = svc(db);

      const top = await service.create(actorFor(a.id), 'c-thread', { body: 'top-level' });
      await service.create(actorFor(b.id), 'c-thread', { body: 'a reply', parentId: top.id });

      const page = await service.list(actorFor(a.id), 'c-thread', {});
      expect(page.hiddenDuringContest).toBe(false);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]!.author).toEqual({ username: 'c-a' });
      expect(page.items[0]!.body).toBe('top-level');
      expect(page.items[0]!.replies).toHaveLength(1);
      expect(page.items[0]!.replies[0]!.body).toBe('a reply');
      expect(page.items[0]!.replies[0]!.parentId).toBe(top.id);
    });
  });

  // The endpoint advertises `?limit=` (PaginationQuery, 1..100), and it was
  // parsed and then dropped — every page was a fixed 25 regardless. A client
  // asking for a smaller page (a hot thread on a phone) got 25 anyway.
  it('honours the page limit the caller asks for', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'c-lim-owner');
      const a = await insertUser(db, 'c-lim-a');
      await seedProblem(db, { code: 'c-lim', createdBy: owner.id });
      const service = svc(db);
      const ids: number[] = [];
      for (const body of ['one', 'two', 'three']) {
        ids.push((await service.create(actorFor(a.id), 'c-lim', { body })).id);
      }

      const first = await service.list(actorFor(a.id), 'c-lim', { limit: 2 });
      expect(first.items.map((i) => i.id)).toEqual([ids[0], ids[1]]);
      expect(first.nextCursor).not.toBeNull();

      const second = await service.list(actorFor(a.id), 'c-lim', { cursor: first.nextCursor!, limit: 2 });
      expect(second.items.map((i) => i.id)).toEqual([ids[2]]);
      expect(second.nextCursor).toBeNull();
    });
  });

  it('is invisible on a problem the viewer may not see (404, not 403)', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'c-priv-owner');
      const stranger = await insertUser(db, 'c-priv-stranger');
      await seedProblem(db, { code: 'c-priv', createdBy: owner.id, visibility: 'private' });
      const service = svc(db);

      await expect(service.list(actorFor(stranger.id), 'c-priv', {})).rejects.toMatchObject({
        status: 404,
        code: 'problem_not_found',
      });
      await expect(service.create(actorFor(stranger.id), 'c-priv', { body: 'hi' })).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  it('refuses a reply to a reply, to another problem, or to a deleted parent (422)', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'c-lvl-owner');
      const a = await insertUser(db, 'c-lvl-a');
      await seedProblem(db, { code: 'c-lvl-1', createdBy: owner.id });
      await seedProblem(db, { code: 'c-lvl-2', createdBy: owner.id });
      const service = svc(db);

      const top = await service.create(actorFor(a.id), 'c-lvl-1', { body: 'top' });
      const reply = await service.create(actorFor(a.id), 'c-lvl-1', { body: 'reply', parentId: top.id });

      // reply-to-a-reply
      await expect(
        service.create(actorFor(a.id), 'c-lvl-1', { body: 'nope', parentId: reply.id }),
      ).rejects.toMatchObject({ status: 422, code: 'comment_bad_parent' });

      // parent belongs to a different problem
      await expect(
        service.create(actorFor(a.id), 'c-lvl-2', { body: 'nope', parentId: top.id }),
      ).rejects.toMatchObject({ status: 422, code: 'comment_bad_parent' });

      // parent has been deleted
      await service.remove(actorFor(a.id), 'c-lvl-1', top.id);
      await expect(
        service.create(actorFor(a.id), 'c-lvl-1', { body: 'nope', parentId: top.id }),
      ).rejects.toMatchObject({ status: 422, code: 'comment_bad_parent' });
    });
  });

  it('hides the whole thread from a viewer sitting a running contest (D109)', async () => {
    await withTestDb(async (db) => {
      const organiser = await insertUser(db, 'c-hide-org');
      const author = await insertUser(db, 'c-hide-author');
      const sitter = await insertUser(db, 'c-hide-sitter');
      const bystander = await insertUser(db, 'c-hide-bystander');
      const admin = await insertUser(db, 'c-hide-admin', 'admin');
      const { id } = await seedProblem(db, { code: 'c-hide', createdBy: organiser.id });
      const service = svc(db);
      await service.create(actorFor(author.id), 'c-hide', { body: 'discussion' });
      await seedContest(db, {
        key: 'c-hide-ct',
        createdBy: organiser.id,
        problemId: id,
        participantIds: [sitter.id],
      });

      // The sitter: empty, flagged.
      const sitterPage = await service.list(actorFor(sitter.id), 'c-hide', {});
      expect(sitterPage.hiddenDuringContest).toBe(true);
      expect(sitterPage.items).toHaveLength(0);
      // And they may not post into it.
      await expect(service.create(actorFor(sitter.id), 'c-hide', { body: 'leak' })).rejects.toMatchObject({
        status: 403,
        code: 'comment_hidden_contest',
      });

      // Everyone else sees it.
      for (const actor of [actorFor(organiser.id), actorFor(admin.id, 'admin'), actorFor(bystander.id), null]) {
        const page = await service.list(actor, 'c-hide', {});
        expect(page.hiddenDuringContest).toBe(false);
        expect(page.items).toHaveLength(1);
      }
    });
  });

  it('reveals the thread to the participant once the contest is over', async () => {
    await withTestDb(async (db) => {
      const organiser = await insertUser(db, 'c-over-org');
      const author = await insertUser(db, 'c-over-author');
      const sitter = await insertUser(db, 'c-over-sitter');
      const { id } = await seedProblem(db, { code: 'c-over', createdBy: organiser.id });
      const service = svc(db);
      await service.create(actorFor(author.id), 'c-over', { body: 'discussion' });
      await seedContest(db, {
        key: 'c-over-ct',
        createdBy: organiser.id,
        problemId: id,
        participantIds: [sitter.id],
        running: false,
      });

      const page = await service.list(actorFor(sitter.id), 'c-over', {});
      expect(page.hiddenDuringContest).toBe(false);
      expect(page.items).toHaveLength(1);
    });
  });

  it('shows a deleted comment as a tombstone only while it anchors a reply', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'c-tomb-owner');
      const a = await insertUser(db, 'c-tomb-a');
      const b = await insertUser(db, 'c-tomb-b');
      await seedProblem(db, { code: 'c-tomb', createdBy: owner.id });
      const service = svc(db);

      const withReply = await service.create(actorFor(a.id), 'c-tomb', { body: 'has a reply' });
      await service.create(actorFor(b.id), 'c-tomb', { body: 'the reply', parentId: withReply.id });
      const lonely = await service.create(actorFor(a.id), 'c-tomb', { body: 'no replies' });

      await service.remove(actorFor(a.id), 'c-tomb', withReply.id);
      await service.remove(actorFor(a.id), 'c-tomb', lonely.id);

      const page = await service.list(actorFor(a.id), 'c-tomb', {});
      // The lonely deleted comment is gone; the one with a reply stays as a
      // tombstone that still carries its reply.
      expect(page.items).toHaveLength(1);
      const tombstone = page.items[0]!;
      expect(tombstone.id).toBe(withReply.id);
      expect(tombstone.author).toBeNull();
      expect(tombstone.body).toBeNull();
      expect(tombstone.deletedAt).not.toBeNull();
      expect(tombstone.replies).toHaveLength(1);
      expect(tombstone.replies[0]!.body).toBe('the reply');
    });
  });

  it('meters comments at 10 per user per hour', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'c-rate-owner');
      const a = await insertUser(db, 'c-rate-a');
      await seedProblem(db, { code: 'c-rate', createdBy: owner.id });
      const service = svc(db);

      for (let i = 0; i < 10; i++) {
        await service.create(actorFor(a.id), 'c-rate', { body: `comment ${String(i)}` });
      }
      await expect(service.create(actorFor(a.id), 'c-rate', { body: 'one too many' })).rejects.toMatchObject({
        status: 429,
        code: 'comment_rate_limited',
      });
    });
  });

  it('notifies the parent author of a reply, but never on a self-reply', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'c-notif-owner');
      const a = await insertUser(db, 'c-notif-a');
      const b = await insertUser(db, 'c-notif-b');
      await seedProblem(db, { code: 'c-notif', createdBy: owner.id });
      const service = svc(db);

      const top = await service.create(actorFor(a.id), 'c-notif', { body: 'top' });
      // Someone else replies → the top-level author is notified.
      await service.create(actorFor(b.id), 'c-notif', { body: 'reply from b', parentId: top.id });
      // The author replies to their own comment → no notification.
      await service.create(actorFor(a.id), 'c-notif', { body: 'self reply', parentId: top.id });

      const toA = await db
        .select()
        .from(schema.notifications)
        .where(and(eq(schema.notifications.userId, a.id), eq(schema.notifications.kind, 'problem_comment_reply')));
      expect(toA).toHaveLength(1);
      expect((toA[0]!.payload as Record<string, unknown>).problemCode).toBe('c-notif');
    });
  });

  it('lets only the author edit, and only the author or an admin delete', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'c-auth-owner');
      const a = await insertUser(db, 'c-auth-a');
      const b = await insertUser(db, 'c-auth-b');
      const admin = await insertUser(db, 'c-auth-admin', 'admin');
      await seedProblem(db, { code: 'c-auth', createdBy: owner.id });
      const service = svc(db);

      const mine = await service.create(actorFor(a.id), 'c-auth', { body: 'mine' });
      // A stranger cannot edit.
      await expect(service.edit(actorFor(b.id), 'c-auth', mine.id, { body: 'hacked' })).rejects.toMatchObject({
        status: 403,
        code: 'comment_forbidden',
      });
      // The author can, and it stamps editedAt.
      const edited = await service.edit(actorFor(a.id), 'c-auth', mine.id, { body: 'mine, revised' });
      expect(edited.body).toBe('mine, revised');
      expect(edited.editedAt).not.toBeNull();

      // A stranger cannot delete.
      await expect(service.remove(actorFor(b.id), 'c-auth', mine.id)).rejects.toMatchObject({
        status: 403,
        code: 'comment_forbidden',
      });
      // An admin can.
      await expect(service.remove(actorFor(admin.id, 'admin'), 'c-auth', mine.id)).resolves.toBeUndefined();
    });
  });

  it('rejects a malformed cursor', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'c-cur-owner');
      await seedProblem(db, { code: 'c-cur', createdBy: owner.id });
      await expect(svc(db).list(null, 'c-cur', { cursor: 'not-a-number' })).rejects.toBeInstanceOf(AppError);
    });
  });

  // D109 × D99. The spoiler rule keys on "who is sitting this running
  // contest", and a team is ONE participation held by whichever member
  // pressed Join. Every OTHER member competes on that same row (D101) — they
  // read the problem and submit for the team — so the discussion must be
  // withheld from them too. Keyed on `contest_participations.user_id` alone,
  // it was hidden only from the captain, and two of three teammates could
  // read the whole solution thread mid-round and post into it.
  it('hides the thread from a NON-CAPTAIN team member sitting a running contest (D109 × D99)', async () => {
    await withTestDb(async (db) => {
      const organiser = await insertUser(db, 'c-team-org');
      const author = await insertUser(db, 'c-team-author');
      const captain = await insertUser(db, 'c-team-cap');
      const member = await insertUser(db, 'c-team-mem');
      const { id } = await seedProblem(db, { code: 'c-team', createdBy: organiser.id });
      const service = svc(db);
      await service.create(actorFor(author.id), 'c-team', { body: 'the whole solution' });

      const [org] = await db
        .insert(organizations)
        .values({ slug: 'c-team-school', name: 'Trường' })
        .returning({ id: organizations.id });
      const now = Date.now();
      const [contest] = await db
        .insert(contests)
        .values({
          key: 'c-team-ct',
          name: 'c-team-ct',
          startTime: new Date(now - 3_600_000),
          endTime: new Date(now + 3_600_000),
          format: 'icpc',
          visibility: 'public',
          participationMode: 'team',
          maxTeamSize: 3,
          createdBy: organiser.id,
        })
        .returning({ id: contests.id });
      await db.insert(contestOrgs).values({ contestId: contest!.id, orgId: org!.id });
      await db
        .insert(contestProblems)
        .values({ contestId: contest!.id, problemId: id, label: 'A', points: 100, order: 0 });
      const [team] = await db
        .insert(teams)
        .values({ orgId: org!.id, slug: 'doi-1', name: 'Đội 1', createdBy: organiser.id })
        .returning({ id: teams.id });
      await db.insert(teamMembers).values([captain, member].map((u) => ({ teamId: team!.id, userId: u.id })));
      // ONE participation, on the captain's account (D99).
      await db
        .insert(contestParticipations)
        .values({ contestId: contest!.id, userId: captain.id, teamId: team!.id, startTime: new Date(now - 3_600_000) });

      // The captain has always been hidden — the row is on their account.
      const capPage = await service.list(actorFor(captain.id), 'c-team', {});
      expect(capPage.hiddenDuringContest).toBe(true);

      // The non-captain member must be too: they compete on the same row.
      const memPage = await service.list(actorFor(member.id), 'c-team', {});
      expect(memPage.hiddenDuringContest).toBe(true);
      expect(memPage.items).toHaveLength(0);
      await expect(service.create(actorFor(member.id), 'c-team', { body: 'leak' })).rejects.toMatchObject({
        status: 403,
        code: 'comment_hidden_contest',
      });
    });
  });
});
