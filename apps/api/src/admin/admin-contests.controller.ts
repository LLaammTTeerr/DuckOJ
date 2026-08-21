import { Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { CurrentActor } from '../authn/auth.guard.js';
import { SessionOnly } from '../authn/session-only.guard.js';
import type { Actor } from '../authz/actor.js';
import { RatingService } from '../authz/rating.service.js';

/**
 * Rating a contest is the most consequential retroactive operation in the
 * system: it rewrites every rating that followed it.
 *
 * `@SessionOnly()` class-wide for the same reason `AdminUsersController` carries
 * it — a scoped access token must not reach an operation that rewrites history
 * — and it is the *only* marker here. The route-marker rule allows exactly one
 * of `@RequireScope` / `@NoScopeRequired()` / `@SessionOnly()`, and session-only
 * is strictly stronger than any scope a token could hold.
 *
 * Admin-only is enforced inside `RatingService`, not by a decorator here, so
 * this controller carries no authorization logic of its own.
 */
@Controller('admin/contests')
@SessionOnly()
export class AdminContestsController {
  constructor(@Inject(RatingService) private readonly rating: RatingService) {}

  @Post(':key/rate')
  @HttpCode(200)
  rate(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
  ): Promise<{ contestsRated: number }> {
    return this.rating.setRated(actor, key, true);
  }

  @Post(':key/unrate')
  @HttpCode(200)
  unrate(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
  ): Promise<{ contestsRated: number }> {
    return this.rating.setRated(actor, key, false);
  }
}
