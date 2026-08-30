/**
 * D80 — `POST /submissions` is metered.
 *
 * D79 ruled it should be and deliberately did not build it, recording the
 * measurement a threshold should be set from: one judge grades ~35 submissions
 * a minute, and a single unmetered client can enqueue faster than that from one
 * connection. This is that limit — one every ten seconds and twenty every ten
 * minutes, per user.
 *
 * The window is exercised by backdating `rate_events` directly, which is the
 * only deterministic clock a fixed-window limiter has (`login-rate-limit.spec.ts`
 * and `rate-limit.spec.ts` use the same trick).
 */
import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { submissions } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import {
  SUBMISSION_BURST_WINDOW_MS,
  SUBMISSION_PURPOSE,
  SUBMISSION_SUSTAINED_LIMIT,
  SubmissionAccessService,
} from '../src/authz/submission.access.js';
import { REFUSAL_PREFIX } from '../src/common/rate-limiter.js';
import { AppError } from '../src/common/app.error.js';
import type { Actor } from '../src/authz/actor.js';
import { withTestDb } from './db.harness.js';
import { insertUser, seedProblemAndLanguage } from './submissions.fixtures.js';

function actorFor(userId: number, globalRole: Actor['globalRole'] = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

const SOLUTION = { problemCode: 'aplusb', languageKey: 'cpp17', source: 'int main(){}' };

/** Every metered event this user has, oldest first. */
async function meterRows(db: Db, userId: number) {
  return db
    .select({ id: schema.rateEvents.id, createdAt: schema.rateEvents.createdAt })
    .from(schema.rateEvents)
    .where(
      and(
        eq(schema.rateEvents.purpose, SUBMISSION_PURPOSE),
        eq(schema.rateEvents.key, `user:${String(userId)}`),
      ),
    )
    .orderBy(schema.rateEvents.createdAt);
}

/** Ages every one of this user's metered events by `ms`, moving the window on. */
async function backdate(db: Db, userId: number, ms: number): Promise<void> {
  await db
    .update(schema.rateEvents)
    .set({ createdAt: sql`${schema.rateEvents.createdAt} - ${`${String(ms)} milliseconds`}::interval` })
    .where(
      and(
        eq(schema.rateEvents.purpose, SUBMISSION_PURPOSE),
        eq(schema.rateEvents.key, `user:${String(userId)}`),
      ),
    );
}

async function submit(service: SubmissionAccessService, actor: Actor): Promise<unknown> {
  return service.create(actor, SOLUTION).catch((error: unknown) => error);
}

describe('POST /submissions is metered per user (D80)', () => {
  it('refuses a second submission inside ten seconds, with a Retry-After', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const user = await insertUser(db, 'thisinh');
      const service = new SubmissionAccessService(db);

      const first = await submit(service, actorFor(user.id));
      expect(first).toMatchObject({ id: expect.any(Number) as number });

      // The double-clicked button, and the script in a loop: each press is a
      // grading container and a compile.
      const refused = (await submit(service, actorFor(user.id))) as AppError;
      expect(refused.status).toBe(429);
      expect(refused.code).toBe('submission_rate_limited');
      const retryAfter = Number(refused.headers?.['Retry-After']);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(SUBMISSION_BURST_WINDOW_MS / 1000);

      // Nothing was created, and nothing was queued to grade.
      const rows = await db.select().from(submissions).where(eq(submissions.userId, user.id));
      expect(rows).toHaveLength(1);
      const jobs = await db.select().from(schema.gradingJobs);
      expect(jobs).toHaveLength(1);
    });
  }, 120_000);

  it('lets the same person submit again once the ten seconds have passed', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const user = await insertUser(db, 'thisinh');
      const service = new SubmissionAccessService(db);

      expect(await submit(service, actorFor(user.id))).toMatchObject({ id: expect.any(Number) as number });
      await backdate(db, user.id, SUBMISSION_BURST_WINDOW_MS + 1_000);

      // The burst bound must not read as a ban: a contestant fixing a failed
      // test and resubmitting is the case that must never break.
      expect(await submit(service, actorFor(user.id))).toMatchObject({ id: expect.any(Number) as number });
    });
  }, 120_000);

  it('refuses the twenty-first submission in ten minutes, and says the longer wait', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const user = await insertUser(db, 'thisinh');
      const service = new SubmissionAccessService(db);

      // Twenty accepted, each one stepping past the burst window rather than
      // waiting ten real seconds twenty times.
      for (let i = 0; i < SUBMISSION_SUSTAINED_LIMIT; i++) {
        const outcome = await submit(service, actorFor(user.id));
        expect(outcome).toMatchObject({ id: expect.any(Number) as number });
        await backdate(db, user.id, SUBMISSION_BURST_WINDOW_MS + 1_000);
      }
      expect(await meterRows(db, user.id)).toHaveLength(SUBMISSION_SUSTAINED_LIMIT);

      const refused = (await submit(service, actorFor(user.id))) as AppError;
      expect(refused.status).toBe(429);
      expect(refused.code).toBe('submission_rate_limited');
      // The honest wait, not the burst window's ten seconds: a caller told to
      // come back in ten seconds would come back fifty times to be refused.
      expect(Number(refused.headers?.['Retry-After'])).toBeGreaterThan(
        SUBMISSION_BURST_WINDOW_MS / 1000,
      );

      const rows = await db.select().from(submissions).where(eq(submissions.userId, user.id));
      expect(rows).toHaveLength(SUBMISSION_SUSTAINED_LIMIT);
    });
  }, 300_000);

  it('records the sustained window intact — a burst-length sweep would erase it', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const user = await insertUser(db, 'thisinh');
      const service = new SubmissionAccessService(db);

      // `RateLimiter.record` deletes this key's rows older than the window it
      // is handed. Handed the ten-second window it would sweep away the rows
      // the twenty-in-ten-minutes count is made of on every single submission,
      // and the sustained bound would silently never fire — a limiter that
      // passes every test about its short window and enforces nothing.
      for (let i = 0; i < 4; i++) {
        await submit(service, actorFor(user.id));
        await backdate(db, user.id, SUBMISSION_BURST_WINDOW_MS + 1_000);
      }

      expect(await meterRows(db, user.id)).toHaveLength(4);
    });
  }, 180_000);

  it('meters an ADMIN exactly as it meters a contestant (D80)', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const admin = await insertUser(db, 'quantri', 'admin');
      const service = new SubmissionAccessService(db);

      expect(await submit(service, actorFor(admin.id, 'admin'))).toMatchObject({
        id: expect.any(Number) as number,
      });
      // The cost is a grading container, and a container costs the same
      // whoever enqueued it.
      const refused = (await submit(service, actorFor(admin.id, 'admin'))) as AppError;
      expect(refused.status).toBe(429);
      expect(refused.code).toBe('submission_rate_limited');
    });
  }, 120_000);

  it('meters each person separately — one contestant cannot lock out a room', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const one = await insertUser(db, 'hocsinha');
      const two = await insertUser(db, 'hocsinhb');
      const service = new SubmissionAccessService(db);

      expect(await submit(service, actorFor(one.id))).toMatchObject({ id: expect.any(Number) as number });
      // Same second, same computer room, different person. Metering the
      // address instead would refuse thirty pupils for the actions of one.
      expect(await submit(service, actorFor(two.id))).toMatchObject({ id: expect.any(Number) as number });
      expect((await submit(service, actorFor(one.id))) as AppError).toMatchObject({ status: 429 });
    });
  }, 120_000);

  it('costs nothing when it refuses, and nothing when the submission is refused for another reason', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const user = await insertUser(db, 'thisinh');
      const service = new SubmissionAccessService(db);

      // A mistyped problem code must not cost a contestant ten seconds of
      // cooldown for a submission the judge never saw.
      const missing = (await service
        .create(actorFor(user.id), { ...SOLUTION, problemCode: 'khong-co' })
        .catch((error: unknown) => error)) as AppError;
      expect(missing.status).toBe(404);
      expect(await meterRows(db, user.id)).toHaveLength(0);

      await submit(service, actorFor(user.id));
      // A refusal records nothing either, so leaning on the button does not
      // extend its own cooldown for as long as somebody keeps pressing.
      for (let i = 0; i < 3; i++) await submit(service, actorFor(user.id));
      expect(await meterRows(db, user.id)).toHaveLength(1);
    });
  }, 300_000);

  it('records ONE refusal marker per refused submission, even when both windows refuse', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const user = await insertUser(db, 'thisinh');
      const service = new SubmissionAccessService(db);

      // Both windows spent at once: nineteen aged past the burst window, one
      // just now. That is the state a contestant leaning on the key is in,
      // and it is the only state in which both `retryAfterSeconds` calls
      // answer non-null.
      for (let i = 0; i < SUBMISSION_SUSTAINED_LIMIT - 1; i++) {
        await submit(service, actorFor(user.id));
        await backdate(db, user.id, SUBMISSION_BURST_WINDOW_MS + 1_000);
      }
      expect(await submit(service, actorFor(user.id))).toMatchObject({
        id: expect.any(Number) as number,
      });

      const refused = (await submit(service, actorFor(user.id))) as AppError;
      expect(refused.status).toBe(429);
      // The honest wait still comes from the LONGER window — asking both is
      // the point, and this test must not make asking twice the fix.
      expect(Number(refused.headers?.['Retry-After'])).toBeGreaterThan(
        SUBMISSION_BURST_WINDOW_MS / 1000,
      );

      // One submission was refused, so one refusal happened. `refused:*` is
      // what D95's monitor counts into `submitRefusalsLast10Min` — the panel
      // an organiser reads to spot a script during their own contest — and a
      // marker per WINDOW rather than per REQUEST doubled that number exactly
      // when the room is busiest.
      const markers = await db
        .select({ id: schema.rateEvents.id })
        .from(schema.rateEvents)
        .where(
          and(
            eq(schema.rateEvents.purpose, `${REFUSAL_PREFIX}${SUBMISSION_PURPOSE}`),
            eq(schema.rateEvents.key, `user:${String(user.id)}`),
          ),
        );
      expect(markers).toHaveLength(1);
    });
  }, 300_000);
});
