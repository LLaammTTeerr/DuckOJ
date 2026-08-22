import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import type { NotificationListDto } from '@duckoj/contracts';
import { CurrentActor } from '../authn/auth.guard.js';
import { SessionOnly } from '../authn/session-only.guard.js';
import type { Actor } from '../authz/actor.js';
import { NotificationsService } from './notifications.service.js';

/**
 * Session-only class-wide (the `/auth/tokens` pattern): notifications are a
 * signed-in person's UI surface, and D14 scopes them to exactly that.
 */
@Controller('notifications')
@SessionOnly()
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentActor() actor: Actor): Promise<NotificationListDto> {
    return this.notifications.listFor(actor);
  }

  @Post('read')
  @HttpCode(200)
  markAllRead(@CurrentActor() actor: Actor): Promise<NotificationListDto> {
    return this.notifications.markAllRead(actor);
  }
}
