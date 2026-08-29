import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ContestListQuery,
  CreateContestRequest,
  SetDisqualifiedRequest,
  UpdateContestRequest,
  type ContestDetailDto,
  type ContestParticipationDto,
  type ContestListQueryDto,
  type ContestPageDto,
  type CreateContestRequestDto,
  type ScoreboardDto,
  type SetDisqualifiedRequestDto,
  type UpdateContestRequestDto,
} from '@duckoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { CurrentActor, MaybeActor, Public } from '../authn/auth.guard.js';
import { RequireScope } from '../authn/require-scope.decorator.js';
import type { Actor } from '../authz/actor.js';
import { ContestAccessService } from '../authz/contest.access.js';

/**
 * Anonymous callers are served on every `GET` here deliberately — they see
 * public contests only, and a contest they may not see 404s rather than 403s.
 * What each actor may see is decided entirely in `ContestAccessService`,
 * never in this controller. Mirrors `ProblemsController` throughout.
 *
 * Joining a contest, and routing a live submission into one, are deliberately
 * absent (design §4): this phase seeds participations directly, exactly as the
 * golden replay does.
 */
@Controller('contests')
export class ContestsController {
  constructor(@Inject(ContestAccessService) private readonly contests: ContestAccessService) {}

  // `@Public()` is marked per handler, never on the class: `Public()` only
  // ever sets true, so a class-level marker is a one-way door that would
  // silently hand anonymous access to the next handler added here.
  @Get()
  @Public()
  @RequireScope('contests:read')
  list(
    @MaybeActor() actor: Actor | null,
    @Query(new ZodValidationPipe(ContestListQuery)) query: ContestListQueryDto,
  ): Promise<ContestPageDto> {
    return this.contests.listVisible(actor, { cursor: query.cursor, limit: query.limit });
  }

  @Get(':key')
  @Public()
  @RequireScope('contests:read')
  get(@MaybeActor() actor: Actor | null, @Param('key') key: string): Promise<ContestDetailDto> {
    return this.contests.getVisible(actor, key);
  }

  /**
   * The scoreboard, in the goldens' snake_case — see `ScoreboardDto`. Served
   * under `contests:read`, not a scope of its own: a caller who may see the
   * contest may see how it stands.
   */
  @Get(':key/scoreboard')
  @Public()
  @RequireScope('contests:read')
  async scoreboard(
    @MaybeActor() actor: Actor | null,
    @Param('key') key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ScoreboardDto> {
    const { board, cache } = await this.contests.getScoreboardCached(actor, key);
    // A HEADER, never a body field (D25). The body is the goldens'
    // snake_case shape and 23 golden replays compare it byte for byte; a
    // `cache` key in there would be DuckOJ inventing a field inside a shape
    // frozen from DMOJ, and every client would have to learn to ignore it.
    // Operators and load tests read a header perfectly well.
    res.setHeader('X-Scoreboard-Cache', cache);
    return board;
  }

  /**
   * Join. Under `contests:write` rather than a scope of its own: a token that
   * may create a contest may certainly enter one, and splitting out a
   * narrower `contests:participate` later widens what an existing token is
   * accepted for, which is backwards compatible. Starting narrow and widening
   * is not.
   */
  @Post(':key/join')
  @HttpCode(201)
  @RequireScope('contests:write')
  join(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
  ): Promise<ContestParticipationDto> {
    return this.contests.join(actor, key);
  }

  /** The caller's own participation. Never public: it is about the caller. */
  @Get(':key/me')
  @RequireScope('contests:read')
  me(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
  ): Promise<ContestParticipationDto> {
    return this.contests.myParticipation(actor, key);
  }

  /**
   * Edit a contest. `contests:write`, like every other write here; who may
   * actually do it is `ContestAccessService`'s call, not this controller's.
   */
  @Patch(':key')
  @RequireScope('contests:write')
  update(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(UpdateContestRequest)) body: UpdateContestRequestDto,
  ): Promise<ContestDetailDto> {
    return this.contests.update(actor, key, body);
  }

  /**
   * Disqualify, or reinstate, a participant.
   *
   * `contests:write`, matching `create` and `join` rather than a scope of its
   * own: running a contest you created is the same authority as creating it.
   * Who may actually do it is decided in `ContestAccessService`, as
   * everywhere else in this controller.
   */
  @Patch(':key/participants/:username')
  @RequireScope('contests:write')
  setDisqualified(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Param('username') username: string,
    @Body(new ZodValidationPipe(SetDisqualifiedRequest)) body: SetDisqualifiedRequestDto,
  ): Promise<ContestParticipationDto> {
    return this.contests.setDisqualified(actor, key, username, body.disqualified);
  }

  // Deliberately no @Public(): every write requires authentication at the
  // guard level, before this controller (or the service) ever sees it.
  @Post()
  @HttpCode(201)
  @RequireScope('contests:write')
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(CreateContestRequest)) body: CreateContestRequestDto,
  ): Promise<ContestDetailDto> {
    return this.contests.create(actor, body);
  }
}
