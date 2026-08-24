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

  async getByUsername(username: string): Promise<UserProfileDto> {
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

    return { ...toSummary(row), about: row.about, stats: await this.statsFor(row.id) };
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
    return this.getByUsername(row.username);
  }

  /**
   * Counted over `visibility = 'public'` problems only, so the numbers mean the
   * same thing to every reader (§4). Computed on read rather than denormalised
   * onto the row: a stored counter is a second write path that drifts, and this
   * project deleted one such column the same week.
   */
  private async statsFor(userId: number): Promise<UserStatsDto> {
    const publicProblem = and(
      eq(submissions.userId, userId),
      eq(problems.visibility, 'public'),
    );

    const [totals] = await this.db
      .select({
        submissionCount: count(submissions.id),
        solvedCount: countDistinct(
          sql`case when ${submissions.verdict} = 'AC' then ${submissions.problemId} end`,
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
      .where(publicProblem)
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
