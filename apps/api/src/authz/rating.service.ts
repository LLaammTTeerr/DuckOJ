/**
 * The rating fold: contests in, `rating_event` rows and cached user ratings out.
 *
 * Lives in `authz/` for the same reason `user.access.ts` does — it reads
 * guarded tables, which the repo confines to this directory.
 *
 * **`rating_event` is a result, never an input.** Dropping every row and
 * replaying must reproduce them exactly (4f design §2), which is what makes a
 * corrected scoreboard propagate forward into every rating that followed it.
 */
import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { contestParticipations, contests, ratingEvents } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { DEFAULT_PLAYER, rateContest } from '@duckoj/glicko2';
import type { Player, RankedPlayer } from '@duckoj/glicko2';
import type { RatingEventDto } from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import { isAdmin, type Actor } from './actor.js';
import { ContestAccessService } from './contest.access.js';

/**
 * Advisory-lock key serialising every replay (and the `isRated` flip that
 * triggers it). Replays are full rewrites of `rating_events`; two overlapping
 * ones would let a stale fold commit last, leaving a contest flagged rated
 * but absent from the record — permanently, since nothing reconciles outside
 * the next replay.
 */
const RATING_REPLAY_LOCK = 0x72617465; // 'rate'

interface PendingEvent {
  contestId: number;
  userId: number;
  rank: number;
  before: Player;
  after: Player;
}

@Injectable()
export class RatingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ContestAccessService) private readonly contests: ContestAccessService,
  ) {}

  /** Marks a contest rated or unrated, then replays. Admin only. */
  async setRated(actor: Actor, key: string, isRated: boolean): Promise<{ contestsRated: number }> {
    if (!isAdmin(actor)) {
      throw new AppError(403, 'rating_forbidden', 'Only an administrator may rate a contest.');
    }
    const contest = (
      await this.db
        .select({ id: contests.id })
        .from(contests)
        .where(eq(contests.key, key.toLowerCase()))
        .limit(1)
    )[0];
    if (!contest) throw new AppError(404, 'contest_not_found', 'No such contest.');

    // Flag flip and replay share ONE transaction, behind the replay lock:
    // if the replay throws (an ioi16 contest whose problem lost its dataset,
    // say), the flag flip rolls back with it — otherwise the poisoned flag
    // makes every future setRated on ANY contest fail at this one, wedging
    // the whole pipeline until someone divines which contest to unrate.
    return await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${RATING_REPLAY_LOCK})`);
      await tx.update(contests).set({ isRated }).where(eq(contests.id, contest.id));
      return { contestsRated: await this.replayInto(tx) };
    });
  }

  /**
   * Recomputes the entire rating history from scratch.
   *
   * The full fold rather than 4f §5's replay-*forward*, which is the same
   * function applied from the earliest contest. Forward replay is an
   * optimisation that needs a per-user "state as of this instant" query;
   * at a season's worth of contests the full fold costs less than the
   * opportunity to get that query subtly wrong, and it is trivially the
   * definition of the thing §2 requires to be reproducible.
   */
  async replayAll(): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${RATING_REPLAY_LOCK})`);
      return this.replayInto(tx);
    });
  }

  /**
   * The fold itself, inside the caller's already-locked transaction. The
   * rated set is read through `tx` so a serialised replay sees the flag
   * state as of ITS turn, not a stale snapshot. Scoreboards are still
   * computed through `this.db`: replays modify only `rating_events` and the
   * cached user ratings, never contest data, so those outside-transaction
   * reads cannot see replay-torn state.
   */
  private async replayInto(tx: Db): Promise<number> {
    // Ordered by `(end_time, id)`, never `end_time` alone: two contests ending
    // in the same second must fold in a defined order, or the result depends
    // on Postgres' row order and the determinism claim collapses on a tie
    // nobody would think to test.
    const rated = await tx
      .select({ id: contests.id })
      .from(contests)
      .where(eq(contests.isRated, true))
      .orderBy(asc(contests.endTime), asc(contests.id));

    // Scoreboards are computed before the transaction opens: the fold is pure
    // once it has them, and the write is then a single short transaction.
    const players = new Map<number, Player>();
    const pending: PendingEvent[] = [];
    let contestsRated = 0;

    for (const contest of rated) {
      const entries = await this.rankedFieldFor(contest.id, players);
      const changes = rateContest(entries);
      // `null` is "the field was too small", an ordinary outcome — the contest
      // stays flagged rated and simply produces no events.
      if (!changes) continue;
      contestsRated += 1;
      for (const change of changes) {
        players.set(change.userId, change.after);
        pending.push({
          contestId: contest.id,
          userId: change.userId,
          rank: change.rank,
          before: change.before,
          after: change.after,
        });
      }
    }

    {
      await tx.delete(ratingEvents);
      if (pending.length > 0) {
        await tx.insert(ratingEvents).values(
          pending.map((event) => ({
            contestId: event.contestId,
            userId: event.userId,
            rank: event.rank,
            ratingBefore: Math.round(event.before.rating),
            rdBefore: event.before.rd,
            volatilityBefore: event.before.volatility,
            ratingAfter: Math.round(event.after.rating),
            rdAfter: event.after.rd,
            volatilityAfter: event.after.volatility,
          })),
        );
      }

      // Rewritten wholesale, never incrementally. `max_rating` is recomputed
      // over the replayed history rather than kept as a running maximum
      // against the old value — otherwise unrating a contest could leave a
      // peak that no longer happened anywhere in the record.
      await tx.update(schema.users).set({ rating: null, maxRating: null });
      const latest = new Map<number, number>();
      const peak = new Map<number, number>();
      for (const event of pending) {
        const after = Math.round(event.after.rating);
        latest.set(event.userId, after);
        peak.set(event.userId, Math.max(peak.get(event.userId) ?? after, after));
      }
      for (const [userId, rating] of latest) {
        await tx
          .update(schema.users)
          .set({ rating, maxRating: peak.get(userId)! })
          .where(eq(schema.users.id, userId));
      }
    }

    return contestsRated;
  }

  /**
   * The contest's rated field, in scoreboard order.
   *
   * §3's exclusions, then the threshold — which `rateContest` applies. The
   * ordering matters: a contest with thirty registrants of whom five submitted
   * has a five-person field, and testing the threshold first would rate it.
   *
   * Ranks come from the scoreboard unchanged, gaps included. Glicko-2 compares
   * ranks pairwise, so only their order and equality matter.
   */
  private async rankedFieldFor(
    contestId: number,
    players: Map<number, Player>,
  ): Promise<RankedPlayer[]> {
    const [board, participants] = await Promise.all([
      this.contests.scoreboardForSystem(contestId),
      this.db
        .select({ userId: contestParticipations.userId, username: schema.users.username })
        .from(contestParticipations)
        .innerJoin(schema.users, eq(schema.users.id, contestParticipations.userId))
        .where(eq(contestParticipations.contestId, contestId)),
    ]);
    const idByName = new Map(participants.map((row) => [row.username, row.userId]));

    const field: RankedPlayer[] = [];
    for (const row of board.ranking) {
      if (row.virtual !== 0) continue;
      if (row.is_disqualified) continue;
      if (row.submission_count === 0) continue;
      const userId = idByName.get(row.participant);
      if (userId === undefined) continue;
      field.push({ userId, rank: row.rank, player: players.get(userId) ?? DEFAULT_PLAYER });
    }
    return field;
  }

  /** A user's rating history, oldest first. */
  async historyFor(username: string): Promise<RatingEventDto[]> {
    const [user] = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      // lower() = lower(), like every other username resolution — the
      // profile route resolves /users/Alice; its sibling must not 404 her.
      .where(sql`lower(${schema.users.username}) = lower(${username})`)
      .limit(1);
    if (!user) throw new AppError(404, 'user_not_found', 'No such user.');

    const rows = await this.db
      .select({
        contestKey: contests.key,
        contestName: contests.name,
        endTime: contests.endTime,
        rank: ratingEvents.rank,
        ratingBefore: ratingEvents.ratingBefore,
        ratingAfter: ratingEvents.ratingAfter,
      })
      .from(ratingEvents)
      .innerJoin(contests, eq(contests.id, ratingEvents.contestId))
      .where(eq(ratingEvents.userId, user.id))
      .orderBy(asc(contests.endTime), asc(contests.id));

    return rows.map((row) => ({
      contestKey: row.contestKey,
      contestName: row.contestName,
      endTime: row.endTime.toISOString(),
      rank: row.rank,
      ratingBefore: row.ratingBefore,
      ratingAfter: row.ratingAfter,
      delta: row.ratingAfter - row.ratingBefore,
    }));
  }
}
