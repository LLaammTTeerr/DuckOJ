import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  CreateSubmissionRequest,
  SubmissionDiffQuery,
  SubmissionIdParam,
  SubmissionListQuery,
  type CreateSubmissionRequestDto,
  type CreateSubmissionResponseDto,
  type SubmissionDetailDto,
  type SubmissionDiffDto,
  type SubmissionDiffQueryDto,
  type SubmissionListQueryDto,
  type SubmissionPageDto,
  type SubmissionPreviousDto,
} from '@duckoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { CurrentActor } from '../authn/auth.guard.js';
import { RequireScope } from '../authn/require-scope.decorator.js';
import type { Actor } from '../authz/actor.js';
import { SubmissionAccessService } from '../authz/submission.access.js';

// Deliberately no @Public(): all three routes require authentication, and
// the global guard rejects by default if the marker is simply absent.
@Controller('submissions')
export class SubmissionsController {
  constructor(@Inject(SubmissionAccessService) private readonly submissions: SubmissionAccessService) {}

  @Post()
  @HttpCode(201)
  @RequireScope('submissions:write')
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(CreateSubmissionRequest)) body: CreateSubmissionRequestDto,
  ): Promise<CreateSubmissionResponseDto> {
    return this.submissions.create(actor, body);
  }

  @Get()
  @RequireScope('submissions:read')
  list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(SubmissionListQuery)) query: SubmissionListQueryDto,
  ): Promise<SubmissionPageDto> {
    return this.submissions.listVisible(actor, query);
  }

  @Get(':id')
  @RequireScope('submissions:read')
  get(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(SubmissionIdParam)) id: number,
  ): Promise<SubmissionDetailDto> {
    return this.submissions.getVisible(actor, id);
  }

  // D111: the two comparison routes. Declared as distinct nested paths, so
  // they never contend with `:id` above.
  @Get(':id/previous')
  @RequireScope('submissions:read')
  previous(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(SubmissionIdParam)) id: number,
  ): Promise<SubmissionPreviousDto> {
    return this.submissions.getPrevious(actor, id);
  }

  @Get(':id/diff')
  @RequireScope('submissions:read')
  diff(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(SubmissionIdParam)) id: number,
    @Query(new ZodValidationPipe(SubmissionDiffQuery)) query: SubmissionDiffQueryDto,
  ): Promise<SubmissionDiffDto> {
    return this.submissions.diff(actor, id, query.against);
  }
}
