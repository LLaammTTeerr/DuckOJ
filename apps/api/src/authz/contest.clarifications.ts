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
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ne, or, sql } from 'drizzle-orm';
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
const NOTIFY_CAP = 10_000;

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
    const joined = await this.db
      .select({ id: contestParticipations.id })
      .from(contestParticipations)
      .where(
        and(
          eq(contestParticipations.contestId, contest.id),
          eq(contestParticipations.userId, actor.userId),
        ),
      )
      .limit(1);
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

    const [row] = await this.db
      .select()
      .from(contestClarifications)
      .where(and(eq(contestClarifications.id, id), eq(contestClarifications.contestId, contest.id)))
      .limit(1);
    if (!row) throw NOT_FOUND;

    const nextAnswer = body.answer ?? row.answer;
    const nextVisibility = body.visibility ?? row.visibility;
    const firstAnswer = row.answer === null && nextAnswer !== null;
    const wasPublished = row.visibility === 'public' && row.answer !== null;
    const nowPublished = nextVisibility === 'public' && nextAnswer !== null;

    return this.db.transaction(async (tx) => {
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
   */
  async list(actor: Actor | null, key: string): Promise<ClarificationListDto> {
    const contest = await this.contests.loadVisible(actor, key);
    const mine = actor
      ? or(
          eq(contestClarifications.visibility, 'public'),
          eq(contestClarifications.askedBy, actor.userId),
        )
      : eq(contestClarifications.visibility, 'public');
    const scope = eq(contestClarifications.contestId, contest.id);
    const rows = await this.rowsWith(this.db)
      .where(canRunContest(actor, contest) ? scope : and(scope, mine))
      .orderBy(desc(contestClarifications.id));
    return { items: rows.map(toDto) };
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
    const recipients = await tx
      .selectDistinct({ userId: contestParticipations.userId })
      .from(contestParticipations)
      .where(
        and(
          eq(contestParticipations.contestId, contest.id),
          ne(contestParticipations.userId, excludeUserId),
        ),
      )
      .limit(NOTIFY_CAP);
    await this.notifications.notifyMany(
      tx,
      recipients.map((row) => row.userId),
      kind,
      { contestKey: contest.key, contestName: contest.name, clarificationId },
    );
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
