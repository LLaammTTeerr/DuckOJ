import { Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { SubmissionIdParam, type RejudgeSubmissionResponseDto } from '@duckoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { CurrentActor } from '../authn/auth.guard.js';
import { SessionOnly } from '../authn/session-only.guard.js';
import type { Actor } from '../authz/actor.js';
import { RejudgeService } from '../authz/rejudge.access.js';

/**
 * `@SessionOnly()` class-wide, for the same reason `AdminContestsController`
 * carries it: a rejudge rewrites a verdict that already went out, and one that
 * lands in a rated contest rewrites rating history behind it. A scoped access
 * token must not reach an operation that rewrites history.
 *
 * Admin-only is enforced inside `RejudgeService`, not by a decorator here, so
 * this controller carries no authorization logic of its own.
 */
@Controller('admin/submissions')
@SessionOnly()
export class AdminSubmissionsController {
  constructor(@Inject(RejudgeService) private readonly rejudge: RejudgeService) {}

  @Post(':id/rejudge')
  @HttpCode(202)
  rejudgeOne(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(SubmissionIdParam)) id: number,
  ): Promise<RejudgeSubmissionResponseDto> {
    return this.rejudge.rejudgeSubmission(actor, id);
  }
}
