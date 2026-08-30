import { Body, Controller, Get, Inject, Param, Patch, Query } from '@nestjs/common';
import {
  UpdateMeRequest,
  UserListQuery,
  type UpdateMeRequestDto,
  type UserListQueryDto,
  type UserPageDto,
  MyTeamsQuery,
  type MyTeamListDto,
  type MyTeamsQueryDto,
  RatingHistoryQuery,
  type RatingHistoryPageDto,
  type RatingHistoryQueryDto,
  type UserProfileDto,
  type MyProgressDto,
  type UserProgressDto,
} from '@duckoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { CurrentActor, MaybeActor, Public } from '../authn/auth.guard.js';
import { RequireScope } from '../authn/require-scope.decorator.js';
import type { Actor } from '../authz/actor.js';
import { UserAccessService } from '../authz/user.access.js';
import { ProgressService } from '../authz/progress.access.js';
import { RatingService } from '../authz/rating.service.js';
import { TeamAccessService } from '../authz/team.access.js';

@Controller('users')
export class UsersController {
  // Explicit `@Inject`, like every other controller here: this build does not
  // emit decorator metadata, so implicit constructor injection resolves to
  // `undefined` and fails at the first request rather than at module init.
  constructor(
    @Inject(UserAccessService) private readonly users: UserAccessService,
    @Inject(RatingService) private readonly ratings: RatingService,
    @Inject(ProgressService) private readonly progress: ProgressService,
    @Inject(TeamAccessService) private readonly teams: TeamAccessService,
  ) {}

  /**
   * `/me` is declared before `/:username` so Nest matches it first — otherwise
   * a PATCH to `/users/me` would bind `username = 'me'`. Nest resolves routes
   * in declaration order, so this ordering is load-bearing, not cosmetic.
   *
   * Deliberately no `@Public()`: editing yourself requires knowing who you are.
   */
  @Patch('me')
  @RequireScope('users:write')
  updateMe(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(UpdateMeRequest)) body: UpdateMeRequestDto,
  ): Promise<UserProfileDto> {
    return this.users.updateMe(actor, body);
  }

  /**
   * Declared with `/me` above `/:username` for the reason that ordering is
   * documented for just above: Nest matches in declaration order, and
   * `/users/me/progress` would otherwise bind `username = 'me'` and answer
   * the public half for an account nobody has.
   *
   * Marked the way `/users/me` is marked — a scope, and deliberately NOT
   * `@Public()`: your own progress needs to know who you are. There is no
   * `profile:read` scope in this build (`packages/contracts/src/scopes.ts`
   * is the whole list), and `users:read` is the scope a token already
   * carries to read a profile at all.
   */
  @Get('me/progress')
  @RequireScope('users:read')
  myProgress(@CurrentActor() actor: Actor): Promise<MyProgressDto> {
    return this.progress.myProgress(actor);
  }

  /**
   * Every team I am on, across every school (D99 as amended by F-25).
   *
   * Declared above `/:username` for the reason the two routes above are, and
   * served by `TeamAccessService` rather than by a second copy of "which
   * teams is this person on" — `TeamsController` next door is the same
   * service under a different path, exactly as `ProgressService` answers both
   * `/users/me/progress` and `/users/{username}/progress`.
   *
   * **`orgs:read`, not `users:read`**, unlike its neighbours. What comes back
   * is a school's rosters — team names, member counts, the organizations they
   * belong to — and a token holding only the profile scope must not reach
   * them through a route that happens to be named after the caller. The path
   * says "me"; the data says "orgs".
   */
  @Get('me/teams')
  @RequireScope('orgs:read')
  myTeams(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(MyTeamsQuery)) query: MyTeamsQueryDto,
  ): Promise<MyTeamListDto> {
    return this.teams.myTeams(actor, query);
  }

  @Get()
  @Public()
  @RequireScope('users:read')
  list(
    @Query(new ZodValidationPipe(UserListQuery)) query: UserListQueryDto,
  ): Promise<UserPageDto> {
    return this.users.list(query);
  }

  /**
   * `@MaybeActor()`, not `@CurrentActor()`: the route is public, and the
   * actor is not for authorization but for the freeze (M1) — `solvedCount`
   * and `points` withhold a rival's contest ACs while their board is frozen,
   * and an anonymous poller is the least privileged viewer there is, not an
   * exempt one.
   */
  @Get(':username')
  @Public()
  @RequireScope('users:read')
  get(
    @Param('username') username: string,
    @MaybeActor() actor: Actor | null,
  ): Promise<UserProfileDto> {
    return this.users.getByUsername(username, actor);
  }

  /**
   * The public half of the progress page: the tag and difficulty bars and
   * the heatmap, over public problems only, and none of the four panels the
   * owner's own page adds. `@Public()` + `users:read`, mirroring
   * `GET /users/{username}` — it discloses no more than the profile it hangs
   * off, so it takes no actor at all.
   */
  @Get(':username/progress')
  @Public()
  @RequireScope('users:read')
  publicProgress(@Param('username') username: string): Promise<UserProgressDto> {
    return this.progress.progressFor(username);
  }

  /** Under `users:read`: a rating history is part of a public profile. */
  @Get(':username/rating')
  @Public()
  @RequireScope('users:read')
  rating(
    @Param('username') username: string,
    @Query(new ZodValidationPipe(RatingHistoryQuery)) query: RatingHistoryQueryDto,
  ): Promise<RatingHistoryPageDto> {
    return this.ratings.historyFor(username, query);
  }
}
