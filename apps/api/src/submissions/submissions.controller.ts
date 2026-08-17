import { Body, Controller, Get, HttpCode, Inject, Param, ParseIntPipe, Post } from '@nestjs/common';
import {
  CreateSubmissionRequest,
  type CreateSubmissionRequestDto,
  type CreateSubmissionResponseDto,
  type SubmissionDetailDto,
} from '@qhhoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { CurrentActor } from '../authn/auth.guard.js';
import type { Actor } from '../authz/actor.js';
import { SubmissionAccessService } from '../authz/submission.access.js';

// Deliberately no @Public(): both routes require authentication, and the
// global guard rejects by default if the marker is simply absent.
@Controller('submissions')
export class SubmissionsController {
  constructor(@Inject(SubmissionAccessService) private readonly submissions: SubmissionAccessService) {}

  @Post()
  @HttpCode(201)
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(CreateSubmissionRequest)) body: CreateSubmissionRequestDto,
  ): Promise<CreateSubmissionResponseDto> {
    return this.submissions.create(actor, body);
  }

  @Get(':id')
  get(
    @CurrentActor() actor: Actor,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<SubmissionDetailDto> {
    return this.submissions.getVisible(actor, id);
  }
}
