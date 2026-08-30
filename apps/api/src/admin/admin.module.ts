import { Module } from '@nestjs/common';
import { AuthzModule } from '../authz/authz.module.js';
import { AuthnModule } from '../authn/authn.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AdminUsersController } from './admin-users.controller.js';
import { AdminUsersService } from './admin-users.service.js';
import { AdminContestsController } from './admin-contests.controller.js';
import { AdminProblemsController } from './admin-problems.controller.js';
import { AdminSubmissionsController } from './admin-submissions.controller.js';
import { AdminDashboardController } from './admin-dashboard.controller.js';

// `AuthzModule` for `RatingService`, `RejudgeService` and `DashboardService`,
// which live there because they read guarded tables — the same reason `UserAccessService` does.
// `AuthnModule` for `TotpService`: the admin TOTP reset (M9) disables the
// credential through the same service the self-service route uses, rather
// than deleting the row itself — the encryption, the table and the
// "confirmed" semantics all live there.
@Module({
  imports: [AuthzModule, AuthnModule, NotificationsModule],
  providers: [AdminUsersService],
  controllers: [
    AdminUsersController,
    AdminContestsController,
    AdminSubmissionsController,
    AdminProblemsController,
    AdminDashboardController,
  ],
})
export class AdminModule {}
