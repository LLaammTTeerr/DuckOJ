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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  AddOrgMemberRequest,
  CreateOrgRequest,
  PaginationQuery,
  SetOrgMemberRoleRequest,
  UpdateOrgRequest,
  type AddOrgMemberRequestDto,
  type CreateOrgRequestDto,
  type OrgJoinRequestListDto,
  type OrgJoinResultDto,
  type OrgMemberDto,
  type SetOrgMemberRoleRequestDto,
  type OrgPageDto,
  type OrgSummaryDto,
  type PaginationQueryDto,
  type UpdateOrgRequestDto,
} from '@duckoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { AppError } from '../common/app.error.js';
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

  /**
   * `201` when the caller joined, `202` when they only asked to — set from the
   * service's answer rather than fixed on the decorator, because the policy
   * decides which happened and a client that branches on the status must not
   * be told it joined when it did not.
   */
  @Post(':slug/join')
  @RequireScope('orgs:write')
  async join(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrgJoinResultDto> {
    const { result, created } = await this.orgs.join(actor, slug);
    res.status(created ? 201 : 202);
    return result;
  }

  @Get(':slug/requests')
  @RequireScope('orgs:write')
  requests(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
  ): Promise<OrgJoinRequestListDto> {
    return this.orgs.listRequests(actor, slug);
  }

  @Post(':slug/requests/:id/approve')
  @HttpCode(200)
  @RequireScope('orgs:write')
  approve(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Param('id') id: string,
  ): Promise<OrgMemberDto[]> {
    return this.orgs.decideRequest(actor, slug, parseId(id), true);
  }

  @Post(':slug/requests/:id/reject')
  @HttpCode(200)
  @RequireScope('orgs:write')
  reject(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Param('id') id: string,
  ): Promise<OrgMemberDto[]> {
    return this.orgs.decideRequest(actor, slug, parseId(id), false);
  }

  @Post(':slug/members')
  @HttpCode(201)
  @RequireScope('orgs:write')
  addMember(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(AddOrgMemberRequest)) body: AddOrgMemberRequestDto,
  ): Promise<OrgMemberDto[]> {
    return this.orgs.addMember(actor, slug, body);
  }

  /** Leaving is this route with your own username — see the service. */
  @Delete(':slug/members/:username')
  @RequireScope('orgs:write')
  removeMember(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Param('username') username: string,
  ): Promise<OrgMemberDto[]> {
    return this.orgs.removeMember(actor, slug, username);
  }

  @Patch(':slug/members/:username')
  @RequireScope('orgs:write')
  setMemberRole(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Param('username') username: string,
    @Body(new ZodValidationPipe(SetOrgMemberRoleRequest)) body: SetOrgMemberRoleRequestDto,
  ): Promise<OrgMemberDto[]> {
    return this.orgs.setMemberRole(actor, slug, username, body.role);
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

/** `:id` is a path segment, so it arrives as a string and must be a positive integer. */
function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, 'bad_request', 'Malformed request id.');
  }
  return id;
}
