import { Module } from '@nestjs/common';
import { AuthzModule } from '../authz/authz.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AdminUsersController } from './admin-users.controller.js';
import { AdminUsersService } from './admin-users.service.js';
import { AdminContestsController } from './admin-contests.controller.js';

// `AuthzModule` for `RatingService`, which lives there because it reads guarded
// tables — the same reason `UserAccessService` does.
@Module({
  imports: [AuthzModule, NotificationsModule],
  providers: [AdminUsersService],
  controllers: [AdminUsersController, AdminContestsController],
})
export class AdminModule {}
