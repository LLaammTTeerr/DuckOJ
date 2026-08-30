/**
 * Contest clarifications and announcements — the Q&A a provincial olympiad
 * runs on contest day (D31).
 *
 * One table carries both. A **question** is a participant's row: `question`
 * set, `private` until an organiser publishes it. An **announcement** is an
 * organiser's row with no `question` at all — the text lives in `answer`, it
 * is `public` from the moment it is posted, and `asked_by` is the organiser,
 * because that column means "who wrote this row".
 *
 * Every read of the contest itself goes through `ContestAccessService`'s own
 * `loadVisible`, never a second query: "may this actor see this contest" has
 * exactly one answer in this codebase, and a clarification feed must not
 * become the place a private contest's existence leaks.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  contestClarifications,
  contestParticipations,
  contestProblems,
  problems,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import type {
  AnswerClarificationRequestDto,
  AskClarificationRequestDto,
  ClarificationDto,
  ClarificationListDto,
  PostAnnouncementRequestDto,
} from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import { RateLimiter } from '../common/rate-limiter.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { Actor } from './actor.js';
import { ContestAccessService, canRunContest } from './contest.access.js';
import { actingParticipations } from './participation.js';

/**
 * 20 questions per user per contest per hour, DB-backed like every other
 * limit here (D13). Per **contest**, not per user: a student sitting two
 * rooms in one afternoon is two independent conversations, and one busy room
 * must not silence the other.
 */
const ASK_LIMIT = 20;
const ASK_WINDOW_MS = 60 * 60 * 1000;
const ASK_PURPOSE = 'clarification_ask';

/**
 * How many participants one announcement notifies. A provincial olympiad is
 * ~2000 students; 10000 is four times the largest room this is being built
 * for, and it bounds one INSERT rather than stating a product rule anybody
 * will meet.
 */
export const NOTIFY_CAP = 10_000;

/**
 * How many rows one read of the feed carries (D63).
 *
 * `list` had no bound at all — "not paginated: a contest's Q&A is read whole,
 * on one screen", which is true of the screen and not of the table behind it.
 * `ask` admits 20 questions per user per contest per hour, so a 2000-seat
 * provincial room can write 40 000 rows of up to 2 000 characters in the first
 * hour, and every one of them is serialised to the organiser on a poll the web
 * repeats **every 30 seconds while the contest runs** — for every reader at
 * once. That is a self-inflicted outage on exactly the day the product exists
 * for.
 *
 * 200 because the panel is a reverse-chronological feed nobody scrolls to the
 * bottom of, and because it is an order of magnitude past the busiest real
 * contest-day Q&A. The cap drops the OLDEST rows, never the announcement that
 * just landed, and `truncated` says out loud that it happened — the same
 * shape, and the same reasoning, as D59's broadcast cap.
 */
export const FEED_CAP = 200;

/**
 * The recipients of one broadcast: every distinct participant of the contest
 * except `excludeUserId`, in **user-id order**, and whether the cap cut the
 * room short.
 *
 * The ordering is the point. `.limit(cap)` with no `ORDER BY` is not a cap,
 * it is a lottery: Postgres is free to hand back whatever the scan reaches
 * first, so a room over the cap notified an arbitrary — and, across two
 * announcements, a *different* — subset, and nobody could say who had been
 * told. Ordered, the truncation is at least deterministic and reproducible;
 * `truncated` is what lets the caller say out loud that it happened, which
 * a silent `.limit()` never could.
 *
 * `selectDistinct` matters independently: a person holding a live
 * participation plus two virtual attempts is one recipient, not three. The
 * ordering column is the selected column, which is what `SELECT DISTINCT`
 * requires.
 *
 * Exported, and taking `cap` as a parameter, so the truncation can be proved
 * against four rows instead of ten thousand.
 */
export async function broadcastRecipients(
  tx: Db,
  contestId: number,
  excludeUserId: number,
  cap: number,
): Promise<{ userIds: number[]; truncated: boolean }> {
  const rows = await broadcastRecipientsQuery(tx, contestId, excludeUserId, cap);
  return { userIds: rows.slice(0, cap).map((row) => row.userId), truncated: rows.length > cap };
}

/**
 * The query alone, unawaited.
 *
 * Split out because the `ORDER BY` has no black-box proof: `SELECT DISTINCT`
 * over a handful of rows is planned as Sort+Unique, which happens to emit
 * ascending order anyway, so a behavioural test passes with the clause
 * deleted — it is the HashAggregate plan the planner picks on a *real*
 * over-cap room that returns an arbitrary subset, and that plan cannot be
 * summoned from a test fixture. The clause is asserted on the compiled SQL
 * instead, which is deterministic and is exactly the property at issue.
 */
export function broadcastRecipientsQuery(tx: Db, contestId: number, excludeUserId: number, cap: number) {
  return tx
    .selectDistinct({ userId: contestParticipations.userId })
    .from(contestParticipations)
    .where(
      and(
        eq(contestParticipations.contestId, contestId),
        ne(contestParticipations.userId, excludeUserId),
      ),
    )
    .orderBy(asc(contestParticipations.userId))
    // One past the cap, so "was anybody left out" is answered by this query
    // rather than by a second COUNT that could disagree with it.
    .limit(cap + 1);
}

const NOT_FOUND = new AppError(404, 'clarification_not_found', 'No such clarification.');
const FORBIDDEN = new AppError(403, 'contest_forbidden', 'You do not run this contest.');

/** The two `users` joins a row needs — the asker, and (maybe) the answerer. */
const asker = alias(schema.users, 'clarification_asker');
const answerer = alias(schema.users, 'clarification_answerer');

/** What `contestFor` returns — the contest columns this service reads. */
interface ContestRef {
  id: number;
  key: string;
  name: string;
  createdBy: number;
}

@Injectable()
export class ContestClarificationsService {
  private readonly logger = new Logger(ContestClarificationsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ContestAccessService) private readonly contests: ContestAccessService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  /**
   * A participant asks. **Joined, or nothing**: this is contest-day Q&A, not
   * a public forum, and a spectator with a question has the contest's own
   * channels. 403 rather than 404 for that refusal, on `setDisqualified`'s
   * reasoning — the caller already reached this contest, so its existence is
   * theirs to know and there is nothing left to conceal.
   */
  async ask(actor: Actor, key: string, body: AskClarificationRequestDto): Promise<ClarificationDto> {
    const contest = await this.contests.loadVisible(actor, key);
    // `actingParticipations`, not a `user_id = ?` of its own: in a team
    // contest the participation belongs to whichever member pressed Join,
    // and **any member may ask** (D99). This is the fourth call site of that
    // one question, and the reason it is one function.
    const joined = await actingParticipations(this.db, contest.id, actor.userId);
    if (joined.length === 0) {
      throw new AppError(403, 'contest_not_joined', 'Join this contest before asking about it.');
    }

    const problemId = await this.resolveProblemId(contest.id, body.problemCode);

    // Checked AFTER the cheap refusals, so a caller cannot burn their own
    // window on requests that were never going to be stored, and BEFORE the
    // insert, so a refused ask writes no row. `allow` records the attempt
    // even when it refuses (D13): a rate-limited asker keeps burning their
    // window rather than probing its edge for free.
    const allowed = await this.limiter.allow(
      ASK_PURPOSE,
      `${String(contest.id)}:${String(actor.userId)}`,
      ASK_LIMIT,
      ASK_WINDOW_MS,
    );
    if (!allowed) {
      throw new AppError(
        429,
        'clarification_rate_limited',
        `At most ${String(ASK_LIMIT)} questions per hour in one contest.`,
      );
    }

    const [row] = await this.db
      .insert(contestClarifications)
      .values({
        contestId: contest.id,
        problemId,
        askedBy: actor.userId,
        question: body.question,
        visibility: 'private',
      })
      .returning({ id: contestClarifications.id });
    return this.byId(this.db, row!.id);
  }

  /**
   * An organiser announces. The text lands in `answer` and the row is
   * `public` immediately — an announcement nobody may read is not one — and
   * every participant hears about it once.
   */
  async announce(
    actor: Actor,
    key: string,
    body: PostAnnouncementRequestDto,
  ): Promise<ClarificationDto> {
    const contest = await this.contests.loadVisible(actor, key);
    if (!canRunContest(actor, contest)) throw FORBIDDEN;
    const problemId = await this.resolveProblemId(contest.id, body.problemCode);

    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [row] = await tx
        .insert(contestClarifications)
        .values({
          contestId: contest.id,
          problemId,
          askedBy: actor.userId,
          question: null,
          answer: body.text,
          answeredBy: actor.userId,
          answeredAt: now,
          visibility: 'public',
        })
        .returning({ id: contestClarifications.id });
      await this.broadcast(tx, contest, row!.id, 'contest_announcement', actor.userId);
      return this.byId(tx, row!.id);
    });
  }

  /**
   * Answer a clarification, publish it, or both — the contest's creator or a
   * global admin, nobody else.
   *
   * **Who hears what, and how often.** The asker is told the first time an
   * answer lands on their row; every participant is told the first time an
   * *answered* row becomes public. Both are one-shot transitions, not
   * "whenever this endpoint is called": an organiser fixing a typo in an
   * answer two thousand students have already read must not send two
   * thousand fresh notifications, and re-sending on every PATCH is exactly
   * how a notification feed becomes something people stop looking at.
   */
  async answer(
    actor: Actor,
    key: string,
    id: number,
    body: AnswerClarificationRequestDto,
  ): Promise<ClarificationDto> {
    const contest = await this.contests.loadVisible(actor, key);
    if (!canRunContest(actor, contest)) throw FORBIDDEN;

    // `:id` is a path segment, so a client can send `abc` — and `Number('abc')`
    // reaches Postgres as `NaN`, which it refuses as a bigint with a 500. Refused
    // here as 404 rather than `orgs.controller.ts`'s 400 `bad_request`, because
    // 404 is what this route already declares and "no such clarification" is
    // exactly true of an id that cannot name one.
    if (!Number.isInteger(id) || id <= 0) throw NOT_FOUND;

    return this.db.transaction(async (tx) => {
      // Read INSIDE the transaction, and locked.
      //
      // Both transition flags are differences between the row's committed
      // state and what this call is about to write, so a read taken outside
      // the transaction is a read of a state that may no longer hold by the
      // time the write lands. Two organisers publishing the same question at
      // once — or one form submitted twice — each saw an unanswered, private
      // row, each concluded this was the transition, and each broadcast: two
      // thousand students notified twice about one answer, which D31 calls
      // out as the unrecoverable failure this rule exists to prevent.
      // `for('update')` serialises the second caller behind the first, so it
      // reads the row the first one left and correctly broadcasts nothing.
      // Same shape, same fix as `OrgAccessService.decideRequest`.
      const [row] = await tx
        .select()
        .from(contestClarifications)
        .where(
          and(eq(contestClarifications.id, id), eq(contestClarifications.contestId, contest.id)),
        )
        .limit(1)
        .for('update');
      if (!row) throw NOT_FOUND;

      const nextAnswer = body.answer ?? row.answer;
      const nextVisibility = body.visibility ?? row.visibility;
      const firstAnswer = row.answer === null && nextAnswer !== null;
      const wasPublished = row.visibility === 'public' && row.answer !== null;
      const nowPublished = nextVisibility === 'public' && nextAnswer !== null;

      await tx
        .update(contestClarifications)
        .set({
          answer: nextAnswer,
          visibility: nextVisibility,
          // The answerer and the instant are stamped on the FIRST answer and
          // never rewritten: "who answered this, and when" is a fact about
          // the reply the asker was notified of, not about the last edit.
          ...(firstAnswer ? { answeredBy: actor.userId, answeredAt: new Date() } : {}),
        })
        .where(eq(contestClarifications.id, row.id));

      if (firstAnswer && row.askedBy !== actor.userId) {
        await this.notifications.notify(tx, row.askedBy, 'clarification_answered', {
          contestKey: contest.key,
          contestName: contest.name,
          clarificationId: row.id,
        });
      }
      if (!wasPublished && nowPublished) {
        // The asker is excluded: they were told the answer landed, and
        // hearing about their own question twice is noise, not service.
        await this.broadcast(tx, contest, row.id, 'clarification_published', row.askedBy);
      }
      return this.byId(tx, row.id);
    });
  }

  /**
   * What this caller may see, newest first.
   *
   * An organiser sees everything. Everyone else — participant, spectator, or
   * an anonymous visitor to a public contest — sees the public rows plus
   * their own. Anonymous is deliberate: an announcement is for the people
   * watching as much as for the people competing, and a signed-out reader
   * has no rows of their own to add.
   *
   * **`problemCode` is withheld before the start.** `ContestAccessService`
   * serves `problems: []` on `GET /contests/{key}` and 409s the scoreboard
   * until a contest starts, for a reason it states there: "a private problem
   * attached to a tomorrow-starting public contest must not leak its code and
   * name through this route while `GET /problems/{code}` 404s the same
   * caller". A `@Public()` feed carrying the code of a problem an organiser
   * announced against is the same list by a third door, so it obeys the same
   * rule — the announcement's *text* is published either way, since a "we
   * start fifteen minutes late" notice is exactly what a pre-start
   * announcement is for.
   */
  async list(actor: Actor | null, key: string): Promise<ClarificationListDto> {
    const contest = await this.contests.loadVisible(actor, key);
    const runsIt = canRunContest(actor, contest);
    const mine = actor
      ? or(
          eq(contestClarifications.visibility, 'public'),
          eq(contestClarifications.askedBy, actor.userId),
        )
      : eq(contestClarifications.visibility, 'public');
    const scope = eq(contestClarifications.contestId, contest.id);
    const rows = await this.rowsWith(this.db)
      .where(runsIt ? scope : and(scope, mine))
      .orderBy(desc(contestClarifications.id))
      // One past the cap, so "was anything left out" is answered by this
      // query rather than by a second COUNT that could disagree with it —
      // `broadcastRecipientsQuery`'s trick, for the same reason.
      .limit(FEED_CAP + 1);
    // "Runs it", not "is an admin", and one clock for the whole response —
    // the same two choices `getVisible` makes for the same concealment.
    const conceal = !runsIt && new Date() < contest.startTime;
    return {
      items: rows
        .slice(0, FEED_CAP)
        .map((row) => toDto(conceal ? { ...row, problemCode: null } : row)),
      truncated: rows.length > FEED_CAP,
    };
  }

  /**
   * Every distinct participant of this contest, capped, in **one** INSERT.
   *
   * `selectDistinct` matters: a person holding a live participation plus two
   * virtual attempts is one recipient, not three. `excludeUserId` keeps the
   * announcer (or, on a publish, the asker who was already told) out of
   * their own broadcast.
   */
  private async broadcast(
    tx: Db,
    contest: ContestRef,
    clarificationId: number,
    kind: string,
    excludeUserId: number,
  ): Promise<void> {
    const { userIds, truncated } = await broadcastRecipients(
      tx,
      contest.id,
      excludeUserId,
      NOTIFY_CAP,
    );
    if (truncated) {
      // A room over the cap is a room where somebody was NOT told, and the
      // organiser has no way to know it from the response — the announcement
      // succeeds either way. Said out loud here so it is at least in the
      // log an operator reads when a competitor reports never seeing it.
      this.logger.warn(
        `contest ${contest.key}: announcement ${String(clarificationId)} notified only the first ` +
          `${String(NOTIFY_CAP)} participants; the rest were not told`,
      );
    }
    await this.notifications.notifyMany(tx, userIds, kind, {
      contestKey: contest.key,
      contestName: contest.name,
      clarificationId,
    });
  }

  /**
   * A problem code, resolved **within this contest**.
   *
   * 404 `problem_not_found` whether the code names nothing or names a problem
   * that is simply not in this contest: a clarification form must not become
   * a way to enumerate which problems exist, and the two answers have to be
   * indistinguishable for that to hold.
   */
  private async resolveProblemId(contestId: number, code: string | null): Promise<number | null> {
    if (code === null) return null;
    const [row] = await this.db
      .select({ id: problems.id })
      .from(contestProblems)
      .innerJoin(problems, eq(problems.id, contestProblems.problemId))
      .where(
        and(eq(contestProblems.contestId, contestId), sql`lower(${problems.code}) = lower(${code})`),
      )
      .limit(1);
    if (!row) throw new AppError(404, 'problem_not_found', 'No such problem in this contest.');
    return row.id;
  }

  /**
   * The wire shape, in one query. Usernames rather than ids so a client links
   * to `/users/{name}` without a second round trip, and `problemCode` rather
   * than an id for the same reason — a feed of twenty rows must not be
   * twenty-one queries.
   */
  private rowsWith(db: Db) {
    return db
      .select({
        id: contestClarifications.id,
        problemCode: problems.code,
        askedBy: asker.username,
        question: contestClarifications.question,
        answer: contestClarifications.answer,
        answeredBy: answerer.username,
        answeredAt: contestClarifications.answeredAt,
        visibility: contestClarifications.visibility,
        createdAt: contestClarifications.createdAt,
      })
      .from(contestClarifications)
      .innerJoin(asker, eq(asker.id, contestClarifications.askedBy))
      .leftJoin(answerer, eq(answerer.id, contestClarifications.answeredBy))
      .leftJoin(problems, eq(problems.id, contestClarifications.problemId));
  }

  /** Re-read after a write, so the response describes what is now stored. */
  private async byId(db: Db, id: number): Promise<ClarificationDto> {
    const [row] = await this.rowsWith(db).where(eq(contestClarifications.id, id)).limit(1);
    if (!row) throw NOT_FOUND;
    return toDto(row);
  }
}

/** Timestamps become ISO strings at the edge, as everywhere else in this API. */
function toDto(row: {
  id: number;
  problemCode: string | null;
  askedBy: string;
  question: string | null;
  answer: string | null;
  answeredBy: string | null;
  answeredAt: Date | null;
  visibility: 'private' | 'public';
  createdAt: Date;
}): ClarificationDto {
  return {
    ...row,
    answeredAt: row.answeredAt === null ? null : row.answeredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
