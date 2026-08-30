import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CreateTeamRequest,
  PaginationQuery,
  UpdateTeamRequest,
  type CreateTeamRequestDto,
  type PaginationQueryDto,
  type TeamDetailDto,
  type TeamPageDto,
  type UpdateTeamRequestDto,
} from '@duckoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { CurrentActor } from '../authn/auth.guard.js';
import { RequireScope } from '../authn/require-scope.decorator.js';
import type { Actor } from '../authz/actor.js';
import { TeamAccessService } from '../authz/team.access.js';

/**
 * Teams — "đội tuyển" — under `/orgs/{slug}/teams` (D99).
 *
 * A controller of its own rather than more handlers on `OrgsController`,
 * sharing its `orgs` prefix and its `Organizations` tag: exactly the split
 * `ProblemSetsController` already made, for its reason.
 *
 * **Nothing here is `@Public()`**, like the sets next door: a squad list is
 * a school's own business, and an anonymous reader has no question to ask.
 */
@Controller('orgs')
export class TeamsController {
  constructor(@Inject(TeamAccessService) private readonly teams: TeamAccessService) {}

  @Get(':slug/teams')
  @RequireScope('orgs:read')
  list(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Query(new ZodValidationPipe(PaginationQuery)) query: PaginationQueryDto,
  ): Promise<TeamPageDto> {
    return this.teams.list(actor, slug, query);
  }

  @Get(':slug/teams/:teamSlug')
  @RequireScope('orgs:read')
  get(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Param('teamSlug') teamSlug: string,
  ): Promise<TeamDetailDto> {
    return this.teams.get(actor, slug, teamSlug);
  }

  @Post(':slug/teams')
  @HttpCode(201)
  @RequireScope('orgs:write')
  create(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(CreateTeamRequest)) body: CreateTeamRequestDto,
  ): Promise<TeamDetailDto> {
    return this.teams.create(actor, slug, body);
  }

  @Patch(':slug/teams/:teamSlug')
  @RequireScope('orgs:write')
  update(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Param('teamSlug') teamSlug: string,
    @Body(new ZodValidationPipe(UpdateTeamRequest)) body: UpdateTeamRequestDto,
  ): Promise<TeamDetailDto> {
    return this.teams.update(actor, slug, teamSlug, body);
  }

  @Delete(':slug/teams/:teamSlug')
  @HttpCode(204)
  @RequireScope('orgs:write')
  remove(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Param('teamSlug') teamSlug: string,
  ): Promise<void> {
    return this.teams.remove(actor, slug, teamSlug);
  }
}
