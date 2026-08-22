import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { PackagesModule } from '../packages/packages.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ContestAccessService } from './contest.access.js';
import { OrgAccessService } from './org.access.js';
import { ProblemAccessService } from './problem.access.js';
import { RatingService } from './rating.service.js';

@Module({
  // `PackagesModule` for `PACKAGE_STORE`, which `ProblemAccessService.attachRevision`
  // needs to read a package's manifest. `PackagesModule` imports `AuthnModule`,
  // not `AuthzModule`, so this stays acyclic — no `forwardRef` needed.
  imports: [ConfigModule, PackagesModule, NotificationsModule],
  providers: [ContestAccessService, OrgAccessService, ProblemAccessService, RatingService],
  exports: [ContestAccessService, OrgAccessService, ProblemAccessService, RatingService],
})
export class AuthzModule {}
