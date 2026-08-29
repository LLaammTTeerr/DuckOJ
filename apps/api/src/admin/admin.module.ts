import { Module } from '@nestjs/common';
import { AuthzModule } from '../authz/authz.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AdminUsersController } from './admin-users.controller.js';
import { AdminUsersService } from './admin-users.service.js';
import { AdminContestsController } from './admin-contests.controller.js';
import { AdminProblemsController } from './admin-problems.controller.js';
import { AdminSubmissionsController } from './admin-submissions.controller.js';

// `AuthzModule` for `RatingService` and `RejudgeService`, which live there
// because they read guarded tables — the same reason `UserAccessService` does.
@Module({
  imports: [AuthzModule, NotificationsModule],
  providers: [AdminUsersService],
  controllers: [
    AdminUsersController,
    AdminContestsController,
    AdminSubmissionsController,
    AdminProblemsController,
  ],
})
export class AdminModule {}
