import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { schema } from '../src/index.js';
import { touchJudgeLastSeen } from '../src/judge-auth.js';
import { withTestDb } from './harness.js';

describe('touchJudgeLastSeen', () => {
  it('bumps last_seen from null to a recent timestamp', async () => {
    await withTestDb(async (db) => {
      await db.insert(schema.judgeNodes).values({ name: 'judge-1', tokenHash: 'a'.repeat(64), driver: 'dmoj' });

      const before = Date.now();
      await touchJudgeLastSeen(db, 'judge-1');
      const after = Date.now();

      const [row] = await db.select().from(schema.judgeNodes).where(eq(schema.judgeNodes.name, 'judge-1'));
      expect(row?.lastSeen).not.toBeNull();
      const seenAt = row!.lastSeen!.getTime();
      // Give a second of slack either side for clock skew between this
      // process and Postgres's own `now()` — the point under test is "did
      // it get written at all and to roughly the right time", not exact
      // clock alignment.
      expect(seenAt).toBeGreaterThanOrEqual(before - 1000);
      expect(seenAt).toBeLessThanOrEqual(after + 1000);
    });
  }, 120_000);

  it('advances last_seen on a second call', async () => {
    await withTestDb(async (db) => {
      await db.insert(schema.judgeNodes).values({ name: 'judge-1', tokenHash: 'a'.repeat(64), driver: 'dmoj' });

      await touchJudgeLastSeen(db, 'judge-1');
      const [first] = await db.select().from(schema.judgeNodes).where(eq(schema.judgeNodes.name, 'judge-1'));
      const firstSeen = first!.lastSeen!.getTime();

      await new Promise((resolve) => setTimeout(resolve, 20));
      await touchJudgeLastSeen(db, 'judge-1');
      const [second] = await db.select().from(schema.judgeNodes).where(eq(schema.judgeNodes.name, 'judge-1'));
      const secondSeen = second!.lastSeen!.getTime();

      expect(secondSeen).toBeGreaterThanOrEqual(firstSeen);
    });
  }, 120_000);

  it('is a silent no-op for a name matching no row, rather than throwing', async () => {
    await withTestDb(async (db) => {
      // No caller today invokes this for an unverified name (every current
      // caller runs it only after `verifyJudgeCredential` already
      // succeeded), but the contract itself — never throw, regardless of
      // *why* the write affected nothing — is what makes it safe to
      // fire-and-forget from a handshake or heartbeat path.
      await expect(touchJudgeLastSeen(db, 'no-such-judge')).resolves.toBeUndefined();
    });
  }, 120_000);
});
