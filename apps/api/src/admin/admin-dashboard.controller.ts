import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import type { AdminDashboardResponseDto, ReclaimLeasesResponseDto } from '@duckoj/contracts';
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
}
