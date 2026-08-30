import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createDb } from '@duckoj/db';
import { organizations, orgMembers } from '@duckoj/db/guarded';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { ORG_OWNER_LOCK, OrgAccessService } from '../src/authz/org.access.js';
import { AppError } from '../src/common/app.error.js';
import type { Actor } from '../src/authz/actor.js';
import { testDbUrl } from './db.harness.js';
import { insertUser } from './submissions.fixtures.js';

function actorFor(userId: number): Actor {
  return { userId, globalRole: 'user', via: 'session', scopes: [] };
}

/**
 * Races are probabilistic, so each scenario runs several times against real
 * committed data (`testDbUrl`, not `withTestDb`'s single rolled-back
 * transaction — concurrency inside one transaction would be savepoints of
 * one session, not a race). `createDb`'s pool (max 10) gives each in-flight
 * statement its own connection, so two `Promise.allSettled`'d service calls
 * genuinely interleave at the database.
 */
const ITERATIONS = 5;

describe('OrgAccessService.join — concurrency', () => {
  it('two concurrent joins of an open org: exactly one joins, the loser gets the contracted 409, never a raw unique violation', async () => {
    const url = await testDbUrl();
    const { db, close } = createDb(url);
    try {
      const service = new OrgAccessService(db, new NotificationsService(db));
      const [org] = await db
        .insert(organizations)
        .values({ slug: 'race-open', name: 'Race Open', visibility: 'public', joinPolicy: 'open' })
        .returning({ id: organizations.id });

      for (let i = 0; i < ITERATIONS; i++) {
        const user = await insertUser(db, `race-join-${i}`);
        const results = await Promise.allSettled([
          service.join(actorFor(user.id), 'race-open'),
          service.join(actorFor(user.id), 'race-open'),
        ]);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(fulfilled, `iteration ${i}: exactly one join must succeed`).toHaveLength(1);
        expect(rejected, `iteration ${i}: exactly one join must be refused`).toHaveLength(1);
        // The contracted error — an unwrapped PostgresError (23505) here is
        // exactly the 500 this test exists to forbid.
        expect(rejected[0]!.reason, `iteration ${i}: loser must reject with AppError, got: ${String(rejected[0]!.reason)}`).toBeInstanceOf(AppError);
        expect(rejected[0]!.reason).toMatchObject({ status: 409, code: 'organization_member_exists' });

        const rows = await db
          .select()
          .from(orgMembers)
          .where(and(eq(orgMembers.orgId, org!.id), eq(orgMembers.userId, user.id)));
        expect(rows, `iteration ${i}: exactly one membership row`).toHaveLength(1);
      }
    } finally {
      await close();
    }
  }, 180_000);
});

describe('OrgAccessService.removeMember — concurrency', () => {
  it('concurrent self-removals of the last two owners never strand the org ownerless; exactly one gets org_last_owner', async () => {
    const url = await testDbUrl();
    const { db, close } = createDb(url);
    try {
      const service = new OrgAccessService(db, new NotificationsService(db));
      const a = await insertUser(db, 'race-owner-a');
      const b = await insertUser(db, 'race-owner-b');
      const [org] = await db
        .insert(organizations)
        .values({ slug: 'race-owners', name: 'Race Owners', visibility: 'public', joinPolicy: 'request' })
        .returning({ id: organizations.id });

      for (let i = 0; i < ITERATIONS; i++) {
        // Full reset each iteration: both users owners, nothing else.
        await db.delete(orgMembers).where(eq(orgMembers.orgId, org!.id));
        await db.insert(orgMembers).values([
          { orgId: org!.id, userId: a.id, role: 'owner' },
          { orgId: org!.id, userId: b.id, role: 'owner' },
        ]);

        const results = await Promise.allSettled([
          service.removeMember(actorFor(a.id), 'race-owners', 'race-owner-a'),
          service.removeMember(actorFor(b.id), 'race-owners', 'race-owner-b'),
        ]);

        const owners = await db
          .select()
          .from(orgMembers)
          .where(and(eq(orgMembers.orgId, org!.id), eq(orgMembers.role, 'owner')));
        expect(owners.length, `iteration ${i}: org stranded with zero owners`).toBeGreaterThanOrEqual(1);

        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(rejected, `iteration ${i}: exactly one removal must be refused`).toHaveLength(1);
        expect(rejected[0]!.reason, `iteration ${i}: refusal must be the contracted AppError, got: ${String(rejected[0]!.reason)}`).toBeInstanceOf(AppError);
        expect(rejected[0]!.reason).toMatchObject({ status: 409, code: 'org_last_owner' });
      }
    } finally {
      await close();
    }
  }, 180_000);
});

/**
 * The role the last-owner check reasons about was read on a different
 * connection, before the advisory lock was taken — so between the read and
 * the lock the whole world could change underneath it, and only the *stale*
 * role decided whether the invariant applied.
 *
 * Concretely: `removeMember` reads "they are a member" (members are not
 * owners, so `assertNotLastOwner` returns immediately), then blocks on the
 * lock; while it waits, that member is promoted to owner and the previous
 * owner leaves; the delete then lands on the organization's only owner and
 * the check that exists to prevent exactly that never ran. An ownerless
 * organization is the one state `org.access.ts` says only a database edit
 * repairs.
 *
 * Rather than gamble on scheduling, these tests OWN the window: a second
 * connection takes the same `pg_advisory_xact_lock` first, so the call under
 * test is provably parked at the lock, and the ownership changes are then
 * applied with plain SQL (which needs no lock) before the lock is released.
 * That is the same interleaving two ordinary HTTP requests can produce, made
 * deterministic.
 */
describe('the last-owner invariant against a role that changed under it', () => {
  interface Fixture {
    db: ReturnType<typeof createDb>['db'];
    service: OrgAccessService;
    orgId: number;
    owner: { id: number };
    member: { id: number };
    admin: Actor;
  }

  async function seed(db: ReturnType<typeof createDb>['db'], slug: string): Promise<Fixture> {
    const service = new OrgAccessService(db, new NotificationsService(db));
    const owner = await insertUser(db, `${slug}-owner`);
    const member = await insertUser(db, `${slug}-member`);
    const superuser = await insertUser(db, `${slug}-admin`, 'admin');
    const [org] = await db
      .insert(organizations)
      .values({ slug, name: slug, visibility: 'public', joinPolicy: 'request' })
      .returning({ id: organizations.id });
    await db.insert(orgMembers).values([
      { orgId: org!.id, userId: owner.id, role: 'owner' },
      { orgId: org!.id, userId: member.id, role: 'member' },
    ]);
    return {
      db,
      service,
      orgId: org!.id,
      owner,
      member,
      admin: { userId: superuser.id, globalRole: 'admin', via: 'session', scopes: [] },
    };
  }

  /**
   * Holds the per-org advisory lock, runs `whileHeld` (plain SQL, no lock of
   * its own), then commits — releasing the lock and letting the parked call
   * through.
   */
  async function underLock(
    db: ReturnType<typeof createDb>['db'],
    orgId: number,
    parked: Promise<unknown>,
    whileHeld: (tx: ReturnType<typeof createDb>['db']) => Promise<void>,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ORG_OWNER_LOCK}, ${orgId})`);
      // The parked call's own reads run on another connection and take
      // milliseconds; this waits long enough that it is demonstrably
      // blocked on the lock rather than still reading.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await whileHeld(tx as unknown as ReturnType<typeof createDb>['db']);
    });
    await parked.catch(() => undefined);
  }

  async function ownersOf(db: ReturnType<typeof createDb>['db'], orgId: number): Promise<number> {
    const rows = await db
      .select({ userId: orgMembers.userId })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, 'owner')));
    return rows.length;
  }

  it('removeMember never strands the org when its target became the last owner mid-call', async () => {
    const url = await testDbUrl();
    const { db, close } = createDb(url);
    try {
      const f = await seed(db, 'stale-remove');
      const parked = f.service.removeMember(f.admin, 'stale-remove', 'stale-remove-member');
      let outcome: unknown;
      const settled = parked.then(
        (value) => { outcome = value; },
        (error: unknown) => { outcome = error; },
      );
      await underLock(db, f.orgId, settled, async (tx) => {
        await tx
          .update(orgMembers)
          .set({ role: 'owner' })
          .where(and(eq(orgMembers.orgId, f.orgId), eq(orgMembers.userId, f.member.id)));
        await tx
          .delete(orgMembers)
          .where(and(eq(orgMembers.orgId, f.orgId), eq(orgMembers.userId, f.owner.id)));
      });
      await settled;

      expect(await ownersOf(db, f.orgId), 'the organization still has an owner').toBeGreaterThanOrEqual(1);
      expect(outcome, 'the removal is refused, not silently applied').toBeInstanceOf(AppError);
      expect(outcome).toMatchObject({ status: 409, code: 'org_last_owner' });
    } finally {
      await close();
    }
  }, 180_000);

  it('setMemberRole never strands the org when its target became the last owner mid-call', async () => {
    const url = await testDbUrl();
    const { db, close } = createDb(url);
    try {
      const f = await seed(db, 'stale-demote');
      const parked = f.service.setMemberRole(f.admin, 'stale-demote', 'stale-demote-member', 'member');
      let outcome: unknown;
      const settled = parked.then(
        (value) => { outcome = value; },
        (error: unknown) => { outcome = error; },
      );
      await underLock(db, f.orgId, settled, async (tx) => {
        await tx
          .update(orgMembers)
          .set({ role: 'owner' })
          .where(and(eq(orgMembers.orgId, f.orgId), eq(orgMembers.userId, f.member.id)));
        await tx
          .delete(orgMembers)
          .where(and(eq(orgMembers.orgId, f.orgId), eq(orgMembers.userId, f.owner.id)));
      });
      await settled;

      expect(await ownersOf(db, f.orgId), 'the organization still has an owner').toBeGreaterThanOrEqual(1);
      expect(outcome, 'the demotion is refused, not silently applied').toBeInstanceOf(AppError);
      expect(outcome).toMatchObject({ status: 409, code: 'org_last_owner' });
    } finally {
      await close();
    }
  }, 180_000);
});
