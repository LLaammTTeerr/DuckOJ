import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import {
  AdminMailTestRequest,
  type AdminDashboardResponseDto,
  type AdminMailTestRequestDto,
  type AdminMailTestResponseDto,
  type ReclaimLeasesResponseDto,
} from '@duckoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { CurrentActor } from '../authn/auth.guard.js';
import { SessionOnly } from '../authn/session-only.guard.js';
import type { Actor } from '../authz/actor.js';
import { DashboardService } from '../authz/dashboard.access.js';

/**
 * `@SessionOnly()` class-wide, for the reason every controller in this
 * directory carries it: the dashboard reads the whole fleet's health and
 * every recent infrastructure failure by username, and the reclaim below
 * moves live grading work. Neither belongs to a scoped access token.
 *
 * Admin-only is enforced inside `DashboardService`, not by a decorator here,
 * so this controller carries no authorization logic of its own.
 */
@Controller('admin')
@SessionOnly()
export class AdminDashboardController {
  constructor(@Inject(DashboardService) private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  snapshot(@CurrentActor() actor: Actor): Promise<AdminDashboardResponseDto> {
    return this.dashboard.snapshot(actor);
  }

  /**
   * `200`, not `202`: the requeue is one UPDATE that has already happened
   * when this answers. The rejudge routes are `202` because a verdict
   * genuinely arrives later; here nothing is deferred that was not already
   * the queue's ordinary business.
   */
  @Post('grading/reclaim')
  @HttpCode(200)
  reclaim(@CurrentActor() actor: Actor): Promise<ReclaimLeasesResponseDto> {
    return this.dashboard.reclaimLeases(actor);
  }

  /**
   * D156 — sends one message to an address the admin typed, over the
   * transport this deployment actually uses.
   *
   * `200` for a delivery failure too, and `AdminMailTestResponse.error`
   * explains why: the request succeeded — the question "can this server send
   * mail" was asked and completely answered — and the transport's own message
   * is the entire value of the action. An error status would carry the same
   * string in a body many clients throw away.
   *
   * Rate limiting is deliberately absent. The caller is an authenticated
   * admin on a session-only route, the action is one message to an address
   * they typed, and every other button on this dashboard is ungated for the
   * same reason.
   */
  @Post('mail/test')
  @HttpCode(200)
  sendTestMail(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(AdminMailTestRequest)) body: AdminMailTestRequestDto,
  ): Promise<AdminMailTestResponseDto> {
    return this.dashboard.sendTestMail(actor, body.to);
  }
}
