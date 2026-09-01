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
  OrgMemberListQuery,
  PaginationQuery,
  OrgMemberImportRequest,
  SetOrgMemberRoleRequest,
  UpdateOrgRequest,
  type AddOrgMemberRequestDto,
  type CreateOrgRequestDto,
  type OrgJoinRequestPageDto,
  type OrgJoinResultDto,
  type OrgMemberImportPreviewDto,
  type OrgMemberImportRequestDto,
  type OrgMemberImportResultDto,
  type OrgMemberPageDto,
  type SetOrgMemberRoleRequestDto,
  type OrgPageDto,
  type OrgSummaryDto,
  type OrgMemberListQueryDto,
  type PaginationQueryDto,
  type UpdateOrgRequestDto,
} from '@duckoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { AppError } from '../common/app.error.js';
import { CurrentActor, MaybeActor, Public } from '../authn/auth.guard.js';
import { RequireScope } from '../authn/require-scope.decorator.js';
import type { Actor } from '../authz/actor.js';
import { OrgAccessService } from '../authz/org.access.js';
import { OrgImportService } from '../authz/org.import.js';
import { SessionOnly } from '../authn/session-only.guard.js';

/**
 * Anonymous callers are served on every `GET` here deliberately — they see
 * public organizations (and public members) only. What each actor may see,
 * or edit, is decided entirely in `OrgAccessService`, never in this
 * controller.
 */
@Controller('orgs')
export class OrgsController {
  constructor(
    @Inject(OrgAccessService) private readonly orgs: OrgAccessService,
    @Inject(OrgImportService) private readonly imports: OrgImportService,
  ) {}

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
  listMembers(
    @MaybeActor() actor: Actor | null,
    @Param('slug') slug: string,
    @Query(new ZodValidationPipe(OrgMemberListQuery)) query: OrgMemberListQueryDto,
  ): Promise<OrgMemberPageDto> {
    return this.orgs.listMembers(actor, slug, query);
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

  /**
   * A PAGE since D181, where it used to be the whole queue in one array. It
   * is the same `PaginationQuery` the roster above takes, validated by the
   * same pipe — this route was the one list in the API that took no query
   * parameters at all.
   */
  @Get(':slug/requests')
  @RequireScope('orgs:write')
  requests(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Query(new ZodValidationPipe(PaginationQuery)) query: PaginationQueryDto,
  ): Promise<OrgJoinRequestPageDto> {
    return this.orgs.listRequests(actor, slug, query);
  }

  @Post(':slug/requests/:id/approve')
  @HttpCode(200)
  @RequireScope('orgs:write')
  approve(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Param('id') id: string,
  ): Promise<OrgMemberPageDto> {
    return this.orgs.decideRequest(actor, slug, parseId(id), true);
  }

  @Post(':slug/requests/:id/reject')
  @HttpCode(200)
  @RequireScope('orgs:write')
  reject(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Param('id') id: string,
  ): Promise<OrgMemberPageDto> {
    return this.orgs.decideRequest(actor, slug, parseId(id), false);
  }

  @Post(':slug/members')
  @HttpCode(201)
  @RequireScope('orgs:write')
  addMember(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(AddOrgMemberRequest)) body: AddOrgMemberRequestDto,
  ): Promise<OrgMemberPageDto> {
    return this.orgs.addMember(actor, slug, body);
  }

  /**
   * D61 — bulk student accounts.
   *
   * `@SessionOnly()` is this route's ONE marker: no `@RequireScope`, because
   * there is no scope that should let a personal access token mint two
   * thousand accounts and read their passwords out of the response. The same
   * reasoning `TokensController` applies to minting tokens applies here with
   * more force — this endpoint creates credentials for people, not for
   * machines. It is also what forces `scripts/org-import.ts` to reach the
   * database directly rather than call this route (D61).
   *
   * `200` for a `dryRun`, `201` for a real import: the status is set from the
   * service's answer rather than fixed on the decorator, exactly as `join`
   * does, because a client must never be told accounts were created when they
   * were not.
   */
  @Post(':slug/members/import')
  @SessionOnly()
  async importMembers(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(OrgMemberImportRequest)) body: OrgMemberImportRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrgMemberImportResultDto | OrgMemberImportPreviewDto> {
    const outcome = await this.imports.importMembers(actor, slug, body);
    res.status(outcome.created ? 201 : 200);
    return outcome.created ? outcome.result : outcome.preview;
  }

  /** Leaving is this route with your own username — see the service. */
  @Delete(':slug/members/:username')
  @RequireScope('orgs:write')
  removeMember(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Param('username') username: string,
  ): Promise<OrgMemberPageDto> {
    return this.orgs.removeMember(actor, slug, username);
  }

  @Patch(':slug/members/:username')
  @RequireScope('orgs:write')
  setMemberRole(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Param('username') username: string,
    @Body(new ZodValidationPipe(SetOrgMemberRoleRequest)) body: SetOrgMemberRoleRequestDto,
  ): Promise<OrgMemberPageDto> {
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
  // `isSafeInteger`, not `isInteger`: `Number.isInteger(1e20)` is `true`, so an
  // id like `99999999999999999999` passed this guard, was bound against the
  // `bigint` join-request column, and Postgres answered `22003
  // numeric_value_out_of_range` — a 500 where a 400 belongs. The safe-integer
  // range is exactly the range that column accepts.
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AppError(400, 'bad_request', 'Malformed request id.');
  }
  return id;
}
