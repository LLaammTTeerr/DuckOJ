/**
 * D31's "notifications fire on transitions, never on every PATCH" under
 * concurrency.
 *
 * `answer()` read the clarification row with `this.db` — outside the
 * transaction that then writes it — and computed `firstAnswer` /
 * `wasPublished` from that read. Two organisers clicking "publish" at the
 * same second (or one organiser and one double-submitting form) therefore
 * both saw a private, unanswered row, both decided this was the transition,
 * and both broadcast: every participant in the room got the same
 * announcement twice, which is exactly the outcome D31 says is unrecoverable
 * once it has happened. `decideRequest` in `org.access.ts` had already
 * solved this shape — `SELECT ... FOR UPDATE` inside the transaction — and
 * this is the same fix.
 *
 * Real committed data (`testDbUrl`, not `withTestDb`'s single rolled-back
 * transaction) because two calls inside one transaction are savepoints of
 * one session, not a race.
 */
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, schema } from '@duckoj/db';
import { contestClarifications, contestParticipations, contests } from '@duckoj/db/guarded';
import { ContestAccessService } from '../src/authz/contest.access.js';
import { ContestClarificationsService } from '../src/authz/contest.clarifications.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { RateLimiter } from '../src/common/rate-limiter.js';
import type { Actor } from '../src/authz/actor.js';
import { testDbUrl } from './db.harness.js';
import { insertUser } from './submissions.fixtures.js';
import { uncachedScoreboards } from './scoreboard.fixtures.js';

const START = '2026-03-01T09:00:00Z';
const END = '2026-03-01T14:00:00Z';
const ITERATIONS = 3;

function actorFor(userId: number): Actor {
  return { userId, globalRole: 'user', via: 'session', scopes: [] };
}

describe('ContestClarificationsService.answer — concurrency', () => {
  it('two simultaneous publishes of one question broadcast once, not twice', async () => {
    const url = await testDbUrl();
    const { db, close } = createDb(url);
    try {
      const service = new ContestClarificationsService(
        db,
        new ContestAccessService(db, uncachedScoreboards()),
        new NotificationsService(db),
        new RateLimiter(db),
      );

      const organiser = await insertUser(db, 'clar-race-org');
      const asker = await insertUser(db, 'clar-race-asker');
      const audience = await insertUser(db, 'clar-race-audience');
      const [contest] = await db
        .insert(contests)
        .values({
          key: 'clar-race',
          name: 'Clarification race',
          startTime: new Date(START),
          endTime: new Date(END),
          format: 'icpc',
          visibility: 'public',
          createdBy: organiser.id,
        })
        .returning({ id: contests.id });
      for (const userId of [asker.id, audience.id]) {
        await db
          .insert(contestParticipations)
          .values({ contestId: contest!.id, userId, virtual: 0, startTime: new Date(START) });
      }

      for (let i = 0; i < ITERATIONS; i++) {
        await db.delete(schema.notifications);
        await db
          .delete(contestClarifications)
          .where(eq(contestClarifications.contestId, contest!.id));
        const [row] = await db
          .insert(contestClarifications)
          .values({
            contestId: contest!.id,
            problemId: null,
            askedBy: asker.id,
            question: 'Is N at most 1e5?',
            visibility: 'private',
          })
          .returning({ id: contestClarifications.id });

        const publish = () =>
          service.answer(actorFor(organiser.id), 'clar-race', row!.id, {
            answer: 'Yes.',
            visibility: 'public' as const,
          });
        const results = await Promise.allSettled([publish(), publish()]);
        // Whether one of them loses on the row lock is not the point — no
        // caller may be handed an unexpected failure, and the room must hear
        // this once however the two interleave.
        for (const result of results) {
          if (result.status === 'rejected') throw result.reason;
        }

        const broadcast = await db
          .select({ id: schema.notifications.id })
          .from(schema.notifications)
          .where(
            and(
              eq(schema.notifications.userId, audience.id),
              eq(schema.notifications.kind, 'clarification_published'),
            ),
          );
        expect(broadcast, `iteration ${String(i)}: the room hears a publish exactly once`).toHaveLength(1);

        const answered = await db
          .select({ id: schema.notifications.id })
          .from(schema.notifications)
          .where(
            and(
              eq(schema.notifications.userId, asker.id),
              eq(schema.notifications.kind, 'clarification_answered'),
            ),
          );
        expect(answered, `iteration ${String(i)}: the asker hears the answer exactly once`).toHaveLength(1);
      }
    } finally {
      await close();
    }
  }, 180_000);
});
