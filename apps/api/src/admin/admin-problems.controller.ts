import { Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { RejudgeProblemResponseDto } from '@duckoj/contracts';
import { CurrentActor } from '../authn/auth.guard.js';
import { SessionOnly } from '../authn/session-only.guard.js';
import type { Actor } from '../authz/actor.js';
import { RejudgeService } from '../authz/rejudge.access.js';

/**
 * Its own file, not a second `@Controller` beside `AdminSubmissionsController`:
 * `packages/contracts/test/route-coverage.spec.ts` reads the FIRST
 * `@Controller(...)` in a file and attributes every route decorator below it to
 * that prefix, so two controllers sharing a file would have half their routes
 * scanned under the wrong path — and the guard would silently check the wrong
 * thing rather than fail.
 *
 * `@SessionOnly()` and the in-service admin check: see
 * `admin-submissions.controller.ts`.
 */
@Controller('admin/problems')
@SessionOnly()
export class AdminProblemsController {
  constructor(@Inject(RejudgeService) private readonly rejudge: RejudgeService) {}

  @Post(':code/rejudge')
  @HttpCode(202)
  rejudgeAll(
    @CurrentActor() actor: Actor,
    @Param('code') code: string,
  ): Promise<RejudgeProblemResponseDto> {
    return this.rejudge.rejudgeProblem(actor, code);
  }
}
