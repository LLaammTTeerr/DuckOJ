import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { PackagesModule } from '../packages/packages.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import {
  RedisSubmissionPublisher,
  SUBMISSION_PUBLISHER,
} from '../realtime/submission-publisher.js';
import { ContestAccessService } from './contest.access.js';
import { OrgAccessService } from './org.access.js';
import { ProblemAccessService } from './problem.access.js';
import { RatingService } from './rating.service.js';
import { RejudgeService } from './rejudge.access.js';

@Module({
  // `PackagesModule` for `PACKAGE_STORE`, which `ProblemAccessService.attachRevision`
  // needs to read a package's manifest. `PackagesModule` imports `AuthnModule`,
  // not `AuthzModule`, so this stays acyclic — no `forwardRef` needed.
  imports: [ConfigModule, PackagesModule, NotificationsModule],
  providers: [
    ContestAccessService,
    OrgAccessService,
    ProblemAccessService,
    RatingService,
    RejudgeService,
    // The API's own publisher on the realtime submissions channel, for
    // `RejudgeService` — the one write path that changes a submission's state
    // without a judge involved. Provided here rather than in `RealtimeModule`
    // because that module imports `SubmissionsModule`, and having it export a
    // provider back into `AuthzModule` would close a cycle. It opens no
    // connection until something actually publishes.
    { provide: SUBMISSION_PUBLISHER, useClass: RedisSubmissionPublisher },
  ],
  exports: [
    ContestAccessService,
    OrgAccessService,
    ProblemAccessService,
    RatingService,
    RejudgeService,
  ],
})
export class AuthzModule {}
