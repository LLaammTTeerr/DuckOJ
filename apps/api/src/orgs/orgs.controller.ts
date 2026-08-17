import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import {
  PaginationQuery,
  type OrgPageDto,
  type OrgSummaryDto,
  type PaginationQueryDto,
} from '@qhhoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { MaybeActor, Public } from '../authn/auth.guard.js';
import type { Actor } from '../authz/actor.js';
import { OrgAccessService } from '../authz/org.access.js';

/**
 * Anonymous callers are served here deliberately — they see public
 * organizations only. What each actor may see is decided in `OrgAccessService`,
 * never in this controller.
 */
@Controller('orgs')
@Public()
export class OrgsController {
  constructor(@Inject(OrgAccessService) private readonly orgs: OrgAccessService) {}

  @Get()
  list(
    @MaybeActor() actor: Actor | null,
    @Query(new ZodValidationPipe(PaginationQuery)) query: PaginationQueryDto,
  ): Promise<OrgPageDto> {
    return this.orgs.listVisible(actor, query);
  }

  @Get(':slug')
  get(@MaybeActor() actor: Actor | null, @Param('slug') slug: string): Promise<OrgSummaryDto> {
    return this.orgs.getVisible(actor, slug);
  }
}
