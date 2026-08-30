import { Module } from '@nestjs/common';
import { AuthnModule } from '../authn/authn.module.js';
import { SubmissionAccessService } from '../authz/submission.access.js';
import { RateLimiter } from '../common/rate-limiter.js';
import { SubmissionsController } from './submissions.controller.js';

@Module({
  imports: [AuthnModule],
  controllers: [SubmissionsController],
  // `RateLimiter` is provided here rather than imported: it is stateless — it
  // counts rows in `rate_events` — so a second instance costs nothing and
  // shares every window, which is exactly the argument `AuthzModule` already
  // records for its own copy. `AuthnModule` provides one and does not export
  // it, and widening its exports to reach in here would make every consumer of
  // authentication a consumer of the meter.
  providers: [SubmissionAccessService, RateLimiter],
  // Task 11's WebSocket gateway authorizes each subscription through this
  // service, so it must be resolvable outside this module.
  exports: [SubmissionAccessService],
})
export class SubmissionsModule {}
