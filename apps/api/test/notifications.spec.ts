/**
 * D14 — who gets told what, and who never is.
 *
 * The negative space carries this suite: a plain member is NOT notified of a
 * join request, the idempotent re-ask does NOT notify again, a self-regrant
 * does NOT notify, and one user's feed never shows another's rows. Every
 * positive case is cheap; the product decision was the negatives.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import { orgJoinRequests, orgMembers, organizations } from '@duckoj/db/guarded';
import { withTestDb } from './db.harness.js';
import { buildApp, TEST_CONFIG } from './app.harness.js';
import { insertUser, registerAndLogin } from './submissions.fixtures.js';
import { OrgAccessService } from '../src/authz/org.access.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { AdminUsersService } from '../src/admin/admin-users.service.js';
import { TotpService } from '../src/authn/totp.service.js';
import { PasswordService } from '../src/authn/password.service.js';
import { TotpRecoveryService } from '../src/authn/totp-recovery.service.js';
import { NOTIFY_CAP } from '../src/authz/contest.clarifications.js';
import { RateLimiter } from '../src/common/rate-limiter.js';
import type { Actor } from '../src/authz/actor.js';

function actorFor(userId: number, globalRole: 'user' | 'setter' | 'admin' = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

async function seedOrg(db: Db, slug: string): Promise<{ id: number }> {
  const [org] = await db
    .insert(organizations)
    .values({ slug, name: slug, visibility: 'public', joinPolicy: 'request' })
    .returning({ id: organizations.id });
  return org!;
}

async function feedOf(db: Db, userId: number) {
  return new NotificationsService(db).listFor(actorFor(userId));
}

describe('org join request notifications', () => {
  it('notifies the owner and the org admin — never the plain member', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'n-owner');
      const orgAdmin = await insertUser(db, 'n-admin');
      const plain = await insertUser(db, 'n-plain');
      const hopeful = await insertUser(db, 'n-hopeful');
      const org = await seedOrg(db, 'n-club');
      await db.insert(orgMembers).values([
        { orgId: org.id, userId: owner.id, role: 'owner' },
        { orgId: org.id, userId: orgAdmin.id, role: 'admin' },
        { orgId: org.id, userId: plain.id, role: 'member' },
      ]);

      const service = new OrgAccessService(db, new NotificationsService(db));
      await service.join(actorFor(hopeful.id), 'n-club');

      const ownerFeed = await feedOf(db, owner.id);
      expect(ownerFeed.items).toHaveLength(1);
      expect(ownerFeed.items[0]).toMatchObject({
        kind: 'org_join_requested',
        payload: { orgSlug: 'n-club', username: 'n-hopeful' },
        readAt: null,
      });
      expect(ownerFeed.unreadCount).toBe(1);
      expect((await feedOf(db, orgAdmin.id)).items).toHaveLength(1);
      expect((await feedOf(db, plain.id)).items).toHaveLength(0);
    });
  }, 120_000);

  it('the idempotent re-ask does not notify a second time', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'r-owner');
      const hopeful = await insertUser(db, 'r-hopeful');
      const org = await seedOrg(db, 'r-club');
      await db.insert(orgMembers).values({ orgId: org.id, userId: owner.id, role: 'owner' });

      const service = new OrgAccessService(db, new NotificationsService(db));
      await service.join(actorFor(hopeful.id), 'r-club');
      await service.join(actorFor(hopeful.id), 'r-club');

      expect((await feedOf(db, owner.id)).items).toHaveLength(1);
    });
  }, 120_000);

  /**
   * The request row and the notification about it are ONE fact.
   *
   * `decideRequest` already writes both in one transaction — "a decided
   * request whose notification failed to write rolls back together with it".
   * `join` did not, and its failure mode is worse than a merely inconsistent
   * pair: the request is idempotent by a partial unique index, so once a row
   * exists a re-ask returns `requested` and notifies NOBODY. A notification
   * that fails once therefore leaves a request that no owner was told about
   * and that the asker can never raise again — a dead end reachable by a
   * single transient database error.
   */
  it('leaves no request behind when the notification cannot be written, so the asker can ask again', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'n-tx-owner');
      const hopeful = await insertUser(db, 'n-tx-hopeful');
      const org = await seedOrg(db, 'n-tx-club');
      await db.insert(orgMembers).values({ orgId: org.id, userId: owner.id, role: 'owner' });

      const broken = {
        notify: () => Promise.reject(new Error('notification store is down')),
        notifyMany: () => Promise.reject(new Error('notification store is down')),
      } as unknown as NotificationsService;
      await expect(
        new OrgAccessService(db, broken).join(actorFor(hopeful.id), 'n-tx-club'),
      ).rejects.toThrow(/notification store is down/);

      const stranded = await db
        .select({ id: orgJoinRequests.id })
        .from(orgJoinRequests)
        .where(eq(orgJoinRequests.orgId, org.id));
      expect(stranded).toEqual([]);

      // And the ask still works — the point of rolling back. With the row
      // left behind, this second call takes the idempotent path, answers
      // `requested`, and tells the owner nothing at all.
      const retry = await new OrgAccessService(db, new NotificationsService(db)).join(
        actorFor(hopeful.id),
        'n-tx-club',
      );
      expect(retry.result.outcome).toBe('requested');
      expect((await feedOf(db, owner.id)).items).toHaveLength(1);
    });
  }, 120_000);

  it('the requester hears the decision, approved and rejected alike', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'd-owner');
      const yes = await insertUser(db, 'd-yes');
      const no = await insertUser(db, 'd-no');
      const org = await seedOrg(db, 'd-club');
      await db.insert(orgMembers).values({ orgId: org.id, userId: owner.id, role: 'owner' });

      const service = new OrgAccessService(db, new NotificationsService(db));
      await service.join(actorFor(yes.id), 'd-club');
      await service.join(actorFor(no.id), 'd-club');
      const requests = await db.select().from(orgJoinRequests);
      const of = (userId: number) => requests.find((r) => r.userId === userId)!.id;

      await service.decideRequest(actorFor(owner.id), 'd-club', of(yes.id), true);
      await service.decideRequest(actorFor(owner.id), 'd-club', of(no.id), false);

      expect((await feedOf(db, yes.id)).items[0]).toMatchObject({
        kind: 'org_join_decided',
        payload: { orgSlug: 'd-club', approved: true },
      });
      expect((await feedOf(db, no.id)).items[0]).toMatchObject({
        kind: 'org_join_decided',
        payload: { orgSlug: 'd-club', approved: false },
      });
    });
  }, 120_000);
});

describe('role-grant notifications', () => {
  it('the target is told; a self-regrant tells nobody', async () => {
    await withTestDb(async (db) => {
      const root = await insertUser(db, 'g-root', 'admin');
      const target = await insertUser(db, 'g-target');
      // `AdminUsersService` also takes `TotpService` since M9 (the admin
      // TOTP reset); this suite exercises neither, so a real one over the
      // harness config is the cheapest honest construction.
      const service = new AdminUsersService(
        db,
        new NotificationsService(db),
        new TotpService(
          db,
          TEST_CONFIG,
          new RateLimiter(db),
          new TotpRecoveryService(db, new NotificationsService(db)),
          new PasswordService(),
        ),
      );

      await service.grantRole(actorFor(root.id, 'admin'), 'g-target', { globalRole: 'setter' });
      expect((await feedOf(db, target.id)).items[0]).toMatchObject({
        kind: 'role_granted',
        payload: { globalRole: 'setter' },
      });

      await service.grantRole(actorFor(root.id, 'admin'), 'g-root', { globalRole: 'admin' });
      expect((await feedOf(db, root.id)).items).toHaveLength(0);
    });
  }, 120_000);
});

/**
 * `notifyMany` writes one INSERT however many recipients there are, and D59
 * caps that at `NOTIFY_CAP` — ten thousand, four times the largest provincial
 * room. Postgres binds at most 65 535 parameters per statement, and this row
 * carries three of them, so the cap sits at 30 000 against a ceiling of
 * 65 535. That margin is arithmetic nobody re-does when a column is added:
 * one more bound value per row and the statement that fans an announcement
 * out to a full room starts failing — mid-transaction, on contest day, in the
 * one code path whose whole job is to reach everybody at once.
 */
describe('one broadcast is one statement, at the cap', () => {
  it('writes NOTIFY_CAP notifications in a single insert', async () => {
    await withTestDb(async (db) => {
      const rows = await db.execute<{ id: number }>(sql`
        insert into users (username, email, password_hash, display_name)
        select 'bulk' || i, 'bulk' || i || '@t.local', 'x', 'Bulk ' || i
          from generate_series(1, ${NOTIFY_CAP}) as i
        returning id
      `);
      const userIds = rows.map((row) => Number(row.id));
      expect(userIds).toHaveLength(NOTIFY_CAP);

      await new NotificationsService(db).notifyMany(db, userIds, 'contest_announcement', {
        contestKey: 'bulk',
        contestName: 'Bulk',
        clarificationId: 1,
      });

      const [counted] = await db.execute<{ n: string }>(
        sql`select count(*) as n from notifications where kind = 'contest_announcement'`,
      );
      expect(Number(counted!.n)).toBe(NOTIFY_CAP);
    });
  }, 300_000);
});

describe('the feed itself', () => {
  it('shows only your own rows, and markAllRead reads exactly yours', async () => {
    await withTestDb(async (db) => {
      const a = await insertUser(db, 'f-a');
      const b = await insertUser(db, 'f-b');
      const service = new NotificationsService(db);
      await service.notify(db, a.id, 'role_granted', { globalRole: 'setter' });
      await service.notify(db, b.id, 'role_granted', { globalRole: 'admin' });

      const afterRead = await service.markAllRead(actorFor(a.id));
      expect(afterRead.unreadCount).toBe(0);
      expect(afterRead.items).toHaveLength(1);
      expect(afterRead.items[0]!.readAt).not.toBeNull();

      const other = await service.listFor(actorFor(b.id));
      expect(other.unreadCount).toBe(1);
      expect(other.items[0]!.payload).toEqual({ globalRole: 'admin' });
    });
  }, 120_000);

  it('is served over HTTP to a session, and refused to no session', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await request(app.getHttpServer()).get('/api/v1/notifications').expect(401);

        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'f-http');
        const { body } = await agent.get('/api/v1/notifications').expect(200);
        expect(body).toEqual({ items: [], unreadCount: 0, truncated: false });
        // Seed one directly, then mark-all-read over the wire.
        const [me] = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.username, 'f-http'));
        await new NotificationsService(db).notify(db, me!.id, 'role_granted', { globalRole: 'setter' });
        const read = await agent.post('/api/v1/notifications/read').expect(200);
        expect(read.body.unreadCount).toBe(0);
        expect(read.body.items).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('the feed says it is a window (D187)', () => {
  it('serves fifty of sixty, flags the truncation, and still counts all sixty unread', async () => {
    await withTestDb(async (db) => {
      const reader = await insertUser(db, 'f-many');
      const service = new NotificationsService(db);
      // Sixty rows, which is the shape a busy contest morning produces: a
      // clarification answered, a round announced, a roster changed, over and
      // over. Fifty is the cap; the other ten were previously gone with no
      // signal of any kind.
      await service.notifyMany(
        db,
        Array.from({ length: 60 }, () => reader.id),
        'role_granted',
        { globalRole: 'setter' },
      );

      const feed = await service.listFor(actorFor(reader.id));
      expect(feed.items).toHaveLength(50);
      // The flag is the whole point: `unreadCount` counts every row, so
      // WITHOUT it a reader is shown "60" over fifty rows and left to
      // reconcile two numbers with nothing to reconcile them by.
      expect(feed.truncated).toBe(true);
      expect(feed.unreadCount).toBe(60);

      // And a feed that fits says so, rather than warning about nothing.
      const quiet = await insertUser(db, 'f-few');
      await service.notify(db, quiet.id, 'role_granted', { globalRole: 'setter' });
      const small = await service.listFor(actorFor(quiet.id));
      expect(small.truncated).toBe(false);
      expect(small.items).toHaveLength(1);
    });
  }, 120_000);
});
