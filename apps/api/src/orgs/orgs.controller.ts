import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  CreateOrgRequest,
  PaginationQuery,
  UpdateOrgRequest,
  type CreateOrgRequestDto,
  type OrgMemberDto,
  type OrgPageDto,
  type OrgSummaryDto,
  type PaginationQueryDto,
  type UpdateOrgRequestDto,
} from '@duckoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { CurrentActor, MaybeActor, Public } from '../authn/auth.guard.js';
import { RequireScope } from '../authn/require-scope.decorator.js';
import type { Actor } from '../authz/actor.js';
import { OrgAccessService } from '../authz/org.access.js';

/**
 * Anonymous callers are served on every `GET` here deliberately — they see
 * public organizations (and public members) only. What each actor may see,
 * or edit, is decided entirely in `OrgAccessService`, never in this
 * controller.
 */
@Controller('orgs')
export class OrgsController {
  constructor(@Inject(OrgAccessService) private readonly orgs: OrgAccessService) {}

  // `@Public()` is marked per handler, never on the class: `Public()` only ever
  // sets true, so a class-level marker is a one-way door that would silently
  // hand anonymous access to the next handler added here.
  @Get()
  @Public()
  @RequireScope('orgs:read')
  list(
    @MaybeActor() actor: Actor | null,
    @Query(new ZodValidationPipe(PaginationQuery)) query: PaginationQueryDto,
  ): Promise<OrgPageDto> {
    return this.orgs.listVisible(actor, query);
  }

  @Get(':slug')
  @Public()
  @RequireScope('orgs:read')
  get(@MaybeActor() actor: Actor | null, @Param('slug') slug: string): Promise<OrgSummaryDto> {
    return this.orgs.getVisible(actor, slug);
  }

  @Get(':slug/members')
  @Public()
  @RequireScope('orgs:read')
  listMembers(@MaybeActor() actor: Actor | null, @Param('slug') slug: string): Promise<OrgMemberDto[]> {
    return this.orgs.listMembers(actor, slug);
  }

  // Deliberately no @Public() below: every write requires authentication at
  // the guard level, before this controller (or the service) ever sees the
  // request — mirrors `ProblemsController`.
  @Post()
  @HttpCode(201)
  @RequireScope('orgs:write')
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(CreateOrgRequest)) body: CreateOrgRequestDto,
  ): Promise<OrgSummaryDto> {
    return this.orgs.create(actor, body);
  }

  @Patch(':slug')
  @RequireScope('orgs:write')
  update(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(UpdateOrgRequest)) body: UpdateOrgRequestDto,
  ): Promise<OrgSummaryDto> {
    return this.orgs.update(actor, slug, body);
  }
}
