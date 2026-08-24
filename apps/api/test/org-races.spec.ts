import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb } from '@duckoj/db';
import { organizations, orgMembers } from '@duckoj/db/guarded';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { OrgAccessService } from '../src/authz/org.access.js';
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
