/**
 * `contest_participations.ends_at` is `participationEndsAtSql()`, and stays it
 * (D194, migration 0048).
 *
 * The column is a MATERIALISATION, not a second rule, and the whole of D194
 * rests on that sentence being true: the D49 window exclusion reads the column
 * instead of the `CASE` because the planner needs a histogram, and the instant
 * it decides is the same instant D22 unfreezes a board and D27 releases a
 * source. A column that has drifted from the `CASE` is D36's failure class —
 * a faster predicate answering a slightly different question — with a
 * scoreboard on the end of it.
 *
 * Migration 0048 writes a transcription of that `CASE` into a trigger, because
 * a generated column may not reach another table and every fixture in this
 * suite raw-inserts a participation. This file is what pins the transcription,
 * and it pins it against the FUNCTION'S OWN EMITTED SQL rather than against a
 * copy of it — `participationEndsAtSql()` is called here, embedded in a query,
 * and compared to the stored column in the database, so a change to that
 * function that the trigger did not follow reds this file.
 *
 * Three forms are compared, not two: the stored column, the SQL `CASE`, and
 * `participationWindow`'s `endMs` — the TypeScript derivation
 * `@duckoj/contest-formats` owns and the scoreboard folds with. The freeze's
 * own agreement test (`submission-freeze.spec.ts`) pins the second against the
 * third for `frozenSubmissionsWhere`; this one closes the triangle.
 *
 * **The maintenance half is the risky half.** A formula transcribed once and
 * checked once cannot drift; a trigger that does not fire can. D38 leaves a
 * contest's `end_time` editable after it has started, and
 * `time_limit_seconds` and a not-yet-started `start_time` with it, so each of
 * the three is moved here and the windows are re-checked.
 */
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { contestParticipations, contests } from '@duckoj/db/guarded';
import type { Db } from '@duckoj/db';
import { participationEndsAtSql } from '../src/authz/submission.freeze.js';
import { participationWindow } from '../src/authz/participation.js';
import { withTestDb } from './db.harness.js';
import { insertUser } from './submissions.fixtures.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface Shape {
  readonly key: string;
  readonly virtual: number;
  /** The contest's `start_time`, relative to now. */
  readonly contestStartInMs: number;
  /** `end_time - start_time`. */
  readonly durationMs: number;
  readonly timeLimitSeconds: number | null;
  /** The participation's `start_time`, relative to now. */
  readonly participationStartInMs: number;
}

/**
 * Every shape the `CASE` has a branch for, plus the two boundary cases the
 * branches hide: a live entrant whose time limit runs PAST the contest (where
 * `least` must pick the contest's end) and one whose limit stops first.
 */
const SHAPES: readonly Shape[] = [
  { key: 'pe-spectate', virtual: -1, contestStartInMs: -HOUR, durationMs: 3 * HOUR, timeLimitSeconds: null, participationStartInMs: -30 * MINUTE },
  { key: 'pe-spectate-tl', virtual: -1, contestStartInMs: -HOUR, durationMs: 3 * HOUR, timeLimitSeconds: 600, participationStartInMs: -30 * MINUTE },
  { key: 'pe-live', virtual: 0, contestStartInMs: -HOUR, durationMs: 3 * HOUR, timeLimitSeconds: null, participationStartInMs: -HOUR },
  { key: 'pe-live-short-tl', virtual: 0, contestStartInMs: -HOUR, durationMs: 3 * HOUR, timeLimitSeconds: 30 * 60, participationStartInMs: -50 * MINUTE },
  { key: 'pe-live-long-tl', virtual: 0, contestStartInMs: -HOUR, durationMs: 2 * HOUR, timeLimitSeconds: 10 * 3600, participationStartInMs: -50 * MINUTE },
  { key: 'pe-virtual', virtual: 1, contestStartInMs: -40 * HOUR, durationMs: 3 * HOUR, timeLimitSeconds: null, participationStartInMs: -20 * MINUTE },
  { key: 'pe-virtual-tl', virtual: 2, contestStartInMs: -40 * HOUR, durationMs: 3 * HOUR, timeLimitSeconds: 45 * 60, participationStartInMs: -20 * MINUTE },
];

interface Seeded {
  readonly participationId: number;
  readonly contestId: number;
}

async function seedShapes(db: Db): Promise<Map<string, Seeded>> {
  const organizer = await insertUser(db, 'pe-org');
  const out = new Map<string, Seeded>();
  for (const shape of SHAPES) {
    const startMs = Date.now() + shape.contestStartInMs;
    const [contest] = await db
      .insert(contests)
      .values({
        key: shape.key,
        name: shape.key,
        startTime: new Date(startMs),
        endTime: new Date(startMs + shape.durationMs),
        format: 'default',
        frozenLastMinutes: 0,
        timeLimitSeconds: shape.timeLimitSeconds,
        visibility: 'public',
        createdBy: organizer.id,
      })
      .returning({ id: contests.id });
    const entrant = await insertUser(db, `${shape.key}-u`);
    const [participation] = await db
      .insert(contestParticipations)
      .values({
        contestId: contest!.id,
        userId: entrant.id,
        startTime: new Date(Date.now() + shape.participationStartInMs),
        virtual: shape.virtual,
      })
      .returning({ id: contestParticipations.id });
    out.set(shape.key, { participationId: participation!.id, contestId: contest!.id });
  }
  return out;
}

/**
 * Every participation whose stored `ends_at` differs from what
 * `participationEndsAtSql()` says, compared IN Postgres so the comparison is
 * exact rather than through two round trips of `timestamptz` rendering.
 *
 * `IS DISTINCT FROM`, not `<>`: a NULL on either side must be a difference,
 * not an unknown that the `WHERE` quietly drops.
 */
async function drifted(db: Db): Promise<{ id: number; stored: string; expected: string }[]> {
  const endsAt = participationEndsAtSql();
  return db
    .select({
      id: contestParticipations.id,
      stored: sql<string>`${contestParticipations.endsAt}::text`,
      expected: sql<string>`(${endsAt})::text`,
    })
    .from(contestParticipations)
    .innerJoin(contests, eq(contests.id, contestParticipations.contestId))
    .where(sql`${contestParticipations.endsAt} is distinct from (${endsAt})`);
}

/** The third form: what `@duckoj/contest-formats` computes, in TypeScript. */
async function storedVersusTypescript(db: Db): Promise<{ id: number; stored: number; ts: number }[]> {
  const rows = await db
    .select({
      id: contestParticipations.id,
      endsAt: contestParticipations.endsAt,
      virtual: contestParticipations.virtual,
      participationStart: contestParticipations.startTime,
      contestId: contests.id,
      key: contests.key,
      contestStart: contests.startTime,
      contestEnd: contests.endTime,
      timeLimitSeconds: contests.timeLimitSeconds,
    })
    .from(contestParticipations)
    .innerJoin(contests, eq(contests.id, contestParticipations.contestId));
  return rows.map((row) => {
    const { endMs } = participationWindow(
      {
        id: row.contestId,
        key: row.key,
        startTime: row.contestStart,
        endTime: row.contestEnd,
        timeLimitSeconds: row.timeLimitSeconds,
      },
      { virtual: row.virtual, startTime: row.participationStart },
    );
    return { id: row.id, stored: row.endsAt.getTime(), ts: endMs };
  });
}

describe('contest_participations.ends_at is participationEndsAtSql(), materialised', () => {
  it('agrees with the CASE and with participationWindow over every participation shape', async () => {
    await withTestDb(async (db) => {
      const seeded = await seedShapes(db);
      expect(seeded.size).toBe(SHAPES.length);

      expect(await drifted(db)).toEqual([]);

      const pairs = await storedVersusTypescript(db);
      expect(pairs).toHaveLength(SHAPES.length);
      for (const pair of pairs) expect([pair.id, pair.stored]).toEqual([pair.id, pair.ts]);

      // Not merely "they agree": a `CASE` stuck on one branch would agree with
      // itself perfectly. Every shape must produce a DIFFERENT instant from
      // the plain contest end for at least the three that are supposed to.
      const ends = new Set(pairs.map((p) => p.stored));
      expect(ends.size).toBeGreaterThan(3);
    });
  }, 180_000);

  it('follows a contest whose end_time, time_limit_seconds or start_time is moved (D38)', async () => {
    await withTestDb(async (db) => {
      const seeded = await seedShapes(db);

      const before = new Map(
        (await db
          .select({ id: contestParticipations.id, endsAt: contestParticipations.endsAt })
          .from(contestParticipations)).map((row) => [row.id, row.endsAt.getTime()]),
      );

      // D38 leaves `end_time` editable after a contest has started, so every
      // spectator's and every live entrant's window moves with it.
      const spectate = seeded.get('pe-spectate')!;
      await db
        .update(contests)
        .set({ endTime: new Date(Date.now() + 5 * HOUR) })
        .where(eq(contests.id, spectate.contestId));

      // A per-participant time limit is what caps a live entrant, and adding
      // one to a contest that had none moves a window that `end_time` did not.
      const live = seeded.get('pe-live')!;
      await db
        .update(contests)
        .set({ timeLimitSeconds: 15 * 60 })
        .where(eq(contests.id, live.contestId));

      // A virtual entrant measures the contest's DURATION from their own
      // start, so moving a not-yet-started contest's `start_time` moves every
      // virtual window on it even though `end_time` did not move.
      const virt = seeded.get('pe-virtual')!;
      await db
        .update(contests)
        .set({ startTime: new Date(Date.now() - 41 * HOUR) })
        .where(eq(contests.id, virt.contestId));

      expect(await drifted(db)).toEqual([]);
      for (const pair of await storedVersusTypescript(db)) {
        expect([pair.id, pair.stored]).toEqual([pair.id, pair.ts]);
      }

      // And the three really did move — otherwise this test would pass on a
      // database where nothing was updated at all.
      const after = new Map(
        (await db
          .select({ id: contestParticipations.id, endsAt: contestParticipations.endsAt })
          .from(contestParticipations)).map((row) => [row.id, row.endsAt.getTime()]),
      );
      for (const seat of [spectate, live, virt]) {
        expect([seat.participationId, after.get(seat.participationId)]).not.toEqual([
          seat.participationId,
          before.get(seat.participationId),
        ]);
      }
    });
  }, 180_000);

  it('never stores the epoch default, even when a writer does not mention the column', async () => {
    await withTestDb(async (db) => {
      await seedShapes(db);
      // Every insert above went through drizzle without naming `ends_at`, so
      // the column's DEFAULT was what the statement carried. The trigger is
      // what makes that unobservable, and this is the assertion that says so.
      const epochs = await db
        .select({ id: contestParticipations.id })
        .from(contestParticipations)
        .where(eq(contestParticipations.endsAt, new Date(0)));
      expect(epochs).toEqual([]);
    });
  }, 180_000);
});
