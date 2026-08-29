import { Module, forwardRef } from '@nestjs/common';
import { AuthnModule } from '../authn/authn.module.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  // `forwardRef`: `AuthnModule` imports this one back, for the D39 recovery-code
  // exhaustion notice. See its comment.
  imports: [forwardRef(() => AuthnModule)],
  providers: [NotificationsService],
  controllers: [NotificationsController],
  exports: [NotificationsService],
})
export class NotificationsModule {}
