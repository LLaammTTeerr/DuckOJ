import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import {
  PaginationQuery,
  type OrgPageDto,
  type OrgSummaryDto,
  type PaginationQueryDto,
} from '@duckoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { MaybeActor, Public } from '../authn/auth.guard.js';
import { RequireScope } from '../authn/require-scope.decorator.js';
import type { Actor } from '../authz/actor.js';
import { OrgAccessService } from '../authz/org.access.js';

/**
 * Anonymous callers are served here deliberately — they see public
 * organizations only. What each actor may see is decided in `OrgAccessService`,
 * never in this controller.
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
}
