import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, countDistinct, eq, gt, ilike, or, sql, sum } from 'drizzle-orm';
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
import { likeEscape } from './problem.access.js';
import { AppError } from '../common/app.error.js';
import type { Actor } from './actor.js';
import { frozenSubmissionsWhere } from './submission.freeze.js';

const { users } = schema;

/** Exactly the columns §3 marks public. `email` and `status` are not among them. */
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
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(query: UserListQueryDto): Promise<UserPageDto> {
    // The same cursor discipline as every sibling list (problems, contests,
    // orgs, submissions): Number(), safe-integer, non-negative — parseInt
    // accepted '12abc' and negatives, and answered a different status and
    // code than the identical mistake anywhere else.
    const after = parseUserCursor(query.cursor);

    // Prefix, not substring: `%q%` cannot use `users_username_lower_idx` and
    // turns a two-letter query into a scan of the whole user table.
    const search =
      query.q === undefined
        ? undefined
        : or(
            // Escaped: `%` and `_` in q are literals a person typed, not
            // wildcards — q='%' must not match every user (and degrade the
            // documented index prefix-walk into a full scan).
            ilike(users.username, `${likeEscape(query.q)}%`),
            ilike(users.displayName, `${likeEscape(query.q)}%`),
          );

    const rows = await this.db
      .select(PUBLIC_COLUMNS)
      .from(users)
      .where(and(gt(users.id, after), search))
      .orderBy(asc(users.id))
      .limit(query.limit + 1);

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
