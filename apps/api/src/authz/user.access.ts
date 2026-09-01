import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, countDistinct, eq, gt, sql, sum } from 'drizzle-orm';
import { problems, submissions } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import type {
  UpdateMeRequestDto,
  UserListQueryDto,
  UserPageDto,
  UserProfileDto,
  UserStatsDto,
  UserSummaryDto,
} from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import { RateLimiter } from '../common/rate-limiter.js';
import { nameSearchWhere } from './name-search.js';
import { recordWalk, walkRefused, walkRetryAfter } from './walk.meter.js';
import type { Actor } from './actor.js';
import { frozenSubmissionsWhere } from './submission.freeze.js';

const { users } = schema;

/* --------------------------------------------------------- D188/D191 --- */

/**
 * The walk meter moved to `walk.meter.ts` in F-53 and is **re-exported here
 * unchanged**, not copied.
 *
 * D191 found the second list of people a stranger could sweep — a public
 * organization's roster — and ruled that it spends the SAME budget rather
 * than a parallel one of its own. Two identical constants in two files would
 * have been the bug: a caller who exhausted their twenty pages of `GET /users`
 * would still have had twenty more pages of every school. The re-export keeps
 * `user-list-enumeration.spec.ts` importing from where D188 put them.
 */
export {
  USER_WALK_LIMIT,
  USER_WALK_PURPOSE,
  USER_WALK_WINDOW_MS,
} from './walk.meter.js';

/**
 * Exactly the columns §3 marks public. `email` and `status` are not among them.
 *
 * **D188 asked whether `globalRole` and `createdAt` should come off this list
 * too, and the answer is no — for the same reason, twice.** Both are already
 * served, one account at a time and to anyone, by `GET /users/{username}`:
 * `UserProfile` is `UserSummary.extend(...)`, so trimming the LIST would fork
 * the two DTOs and buy nothing an attacker cannot get by asking for a username
 * they already have. `globalRole` is a setter/admin badge the profile page
 * renders and the admin lookup shows beside a name so "yes, that is the
 * person" is answerable at all; `createdAt` is a join date every judge prints
 * on a profile. Neither is a moderation fact — that is `status`, which has
 * never been here. What made this endpoint a disclosure was the BULK, and the
 * bulk is what the gate below closes.
 */
const PUBLIC_COLUMNS = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  globalRole: users.globalRole,
  country: users.country,
  rating: users.rating,
  maxRating: users.maxRating,
  createdAt: users.createdAt,
};

/**
 * Lives in `authz/` rather than beside its controller because its statistics
 * filter on `problems.visibility` — deciding what a reader may be told about.
 * The lint rule confining `@duckoj/db/guarded` to this directory caught it
 * sitting in `users/`, which is precisely the hand-rolled visibility filter
 * that rule exists to prevent.
 */
@Injectable()
export class UserAccessService {
  private readonly limiter: RateLimiter;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RateLimiter) limiter?: RateLimiter,
  ) {
    // Defaulted on D80's precedent, and for D80's reason: the specs that
    // construct this service by hand keep working, and they get the REAL
    // limiter rather than a bypass.
    this.limiter = limiter ?? new RateLimiter(db);
  }

  /**
   * D188 — the walk, and only the walk. The meter itself is `walk.meter.ts`,
   * shared verbatim with the organization roster since D191.
   *
   * A request with no `cursor` answers the same first page however often it
   * is asked for; that is a lookup, not enumeration. A request WITH one
   * advances, and advancing is the only way past the first page — so metering
   * cursor-bearing requests bounds a sweep exactly, and a search box, which
   * never sends one, is structurally incapable of spending the budget. That
   * matters more than it sounds: the one caller this endpoint has in the whole
   * product is the admin account lookup, which issues a request per keystroke
   * with no debounce. A meter loose enough for that box (~300 per 15 minutes,
   * to survive a few names typed in a row) would still let a caller harvest a
   * hundred rows per `q` underneath it — so metering every request would take
   * D16's self-lockout risk and buy no bound at all.
   *
   * The key is `user:<id>` and **never an address** — see `walkKey`.
   */
  /**
   * `actor` is non-null, unlike `getByUsername`'s: D188 took `@Public()` off
   * this route, so there is no anonymous caller to model. The type is the
   * enforcement's second layer — a handler that forgot the marker could not
   * even call this.
   */
  async list(actor: Actor, query: UserListQueryDto): Promise<UserPageDto> {
    // The same cursor discipline as every sibling list (problems, contests,
    // orgs, submissions): Number(), safe-integer, non-negative — parseInt
    // accepted '12abc' and negatives, and answered a different status and
    // code than the identical mistake anywhere else.
    const after = parseUserCursor(query.cursor);

    // Checked after the cursor is parsed and before a row is read: a
    // malformed cursor is still a 422 (it is a mistake, not a walk), and a
    // refused walker costs this process no query at all — `register`'s rule.
    if (query.cursor !== undefined) {
      const retryAfter = await walkRetryAfter(this.limiter, actor.userId);
      if (retryAfter !== null) throw walkRefused(retryAfter);
    }

    // D185. One rule for "find this person", shared with the org roster:
    // diacritics folded on both sides, matched at a WORD boundary.
    //
    // What was here before was `ILIKE 'q%'` over `username` and
    // `display_name`, with a comment claiming the prefix "serves
    // `users_username_lower_idx` directly". It did not, twice over: an
    // `ILIKE` prefix cannot use a b-tree index at all (Postgres will only
    // range-rewrite a case-insensitive pattern that starts with a
    // non-alphabetic character), and the `OR` across two columns rules one
    // out anyway. `EXPLAIN` on the live database says `Seq Scan on users`
    // for both `username ILIKE 'ng%'` and `lower(username) LIKE 'ng%'`.
    // The plan never changed; only the comment was wrong.
    const search = query.q === undefined ? undefined : nameSearchWhere(users.searchFold, query.q);

    const rows = await this.db
      .select(PUBLIC_COLUMNS)
      .from(users)
      .where(and(gt(users.id, after), search))
      .orderBy(asc(users.id))
      .limit(query.limit + 1);

    // Recorded only for a page that was actually served, and only for a walk
    // — see `walkRetryAfter`. After the read, so a query that threw costs the
    // caller nothing.
    if (query.cursor !== undefined) {
      await recordWalk(this.limiter, actor.userId);
    }

    const items = rows.slice(0, query.limit).map(toSummary);
    return {
      items,
      nextCursor: rows.length > query.limit ? String(items.at(-1)!.id) : null,
    };
  }

  /**
   * `actor` is `Actor | null` because the route is `@Public()` — an anonymous
   * poller is exactly the viewer this endpoint's freeze leak (M1) was
   * discovered from, so "no actor" has to be a real, non-privileged case
   * rather than a caller the type system lets a handler forget.
   */
  async getByUsername(username: string, actor: Actor | null): Promise<UserProfileDto> {
    const row = (
      await this.db
        .select({ ...PUBLIC_COLUMNS, about: users.about })
        .from(users)
        .where(sql`lower(${users.username}) = lower(${username})`)
        .limit(1)
    )[0];
    // A suspended account still resolves. 404-ing it would make this route an
    // oracle for who has been banned, which is the thing keeping `status`
    // private is meant to prevent.
    if (!row) throw new AppError(404, 'user_not_found', 'No such user.');

    return { ...toSummary(row), about: row.about, stats: await this.statsFor(row.id, actor) };
  }

  async updateMe(actor: Actor, body: UpdateMeRequestDto): Promise<UserProfileDto> {
    // `UpdateMeRequest` is `.strict()`, so `username`, `email`, `globalRole`
    // and `rating` are rejected by validation before reaching this method
    // rather than being quietly dropped here.
    if (Object.keys(body).length > 0) {
      await this.db
        .update(users)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(users.id, actor.userId));
    }
    const [row] = await this.db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, actor.userId));
    if (!row) throw new AppError(404, 'user_not_found', 'No such user.');
    // The actor is themselves, so the freeze below never applies: editing your
    // profile must not blank out your own numbers for the rest of a contest.
    return this.getByUsername(row.username, actor);
  }

  /**
   * Counted over `visibility = 'public'` problems only, so the numbers mean the
   * same thing to every reader (§4). Computed on read rather than denormalised
   * onto the row: a stored counter is a second write path that drifts, and this
   * project deleted one such column the same week.
   *
   * ## The freeze (M1, D22/D23)
   *
   * `solvedCount` and `points` describe an OUTCOME, which is exactly what a
   * frozen board withholds. Without the exclusion below, a competitor polling
   * `/users/rival` through the last hour of a rated contest reads
   * `solvedCount` tick 3→4 the moment the rival's AC lands, and `points`
   * 210→268 for how much it was worth under partial scoring — strictly more
   * than the board's own `pending` count discloses, which says only that an
   * attempt exists. D23 named this leak in its "Out of scope, deliberately"
   * clause; this closes it with the same predicate the submission routes use
   * (`frozenSubmissionsWhere`), never a second copy of the rule.
   *
   * `submissionCount` is deliberately NOT filtered. "Somebody submitted" is
   * what `pending` already announces, `GET /submissions` still lists every
   * frozen row, and a count that disagreed with a list the same viewer can
   * page would be a new inconsistency bought with no secrecy.
   *
   * One clock for both aggregates, read once: two queries either side of a
   * freeze instant that ticked between them would publish a `solvedCount`
   * its `points` could not account for.
   */
  private async statsFor(userId: number, actor: Actor | null): Promise<UserStatsDto> {
    const publicProblem = and(
      eq(submissions.userId, userId),
      eq(problems.visibility, 'public'),
    );
    const frozen = frozenSubmissionsWhere(this.db, actor, new Date());

    const [totals] = await this.db
      .select({
        submissionCount: count(submissions.id),
        // The exclusion sits INSIDE the `case`, not in the `WHERE`: in the
        // `WHERE` it would drop the row from `submissionCount` too.
        solvedCount: countDistinct(
          sql`case when ${submissions.verdict} = 'AC' and not ${frozen} then ${submissions.problemId} end`,
        ),
      })
      .from(submissions)
      .innerJoin(problems, eq(problems.id, submissions.problemId))
      .where(publicProblem);

    // `points` is the best score per problem summed, not the sum of every
    // submission — resubmitting must not inflate a score.
    const best = this.db
      .select({
        problemId: submissions.problemId,
        best: sql<number>`max(${submissions.points})`.as('best'),
      })
      .from(submissions)
      .innerJoin(problems, eq(problems.id, submissions.problemId))
      // Here the `WHERE` is the right place: this subquery feeds `points`
      // alone, and a frozen submission must not raise the best-per-problem
      // maximum it is folded into.
      .where(and(publicProblem, sql`not ${frozen}`))
      .groupBy(submissions.problemId)
      .as('best_per_problem');

    const [scored] = await this.db.select({ points: sum(best.best) }).from(best);

    return {
      submissionCount: totals?.submissionCount ?? 0,
      solvedCount: totals?.solvedCount ?? 0,
      points: Number(scored?.points ?? 0),
    };
  }
}

function toSummary(row: {
  id: number;
  username: string;
  displayName: string;
  globalRole: 'user' | 'setter' | 'admin';
  country: string | null;
  rating: number | null;
  maxRating: number | null;
  createdAt: Date;
}): UserSummaryDto {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    globalRole: row.globalRole,
    country: row.country,
    rating: row.rating,
    maxRating: row.maxRating,
    createdAt: row.createdAt.toISOString(),
  };
}

function parseUserCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const after = Number(cursor);
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new AppError(422, 'invalid_cursor', 'That page cursor is not valid.');
  }
  return after;
}
