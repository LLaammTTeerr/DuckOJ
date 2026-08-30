import { Module } from '@nestjs/common';
import { AuthnModule } from '../authn/authn.module.js';
import { SubmissionsModule } from '../submissions/submissions.module.js';
import { APP_CONFIG, ConfigModule } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import {
  DEFAULT_MAX_SUBSCRIPTIONS,
  MAX_SUBSCRIPTIONS,
  SubmissionsGateway,
} from './submissions.gateway.js';
import { RedisSubscriber } from './redis-subscriber.js';

/**
 * `AuthnModule` provides `SessionService` and `TokenService`; `SubmissionsModule`
 * exports `SubmissionAccessService` (added for exactly this in Task 10's fix
 * round). Nest module imports are not transitive, so both must be imported
 * here directly even though `SubmissionsModule` already imports `AuthnModule`
 * itself.
 *
 * `SubmissionAccessService` is consumed via the import, never re-provided —
 * two instances of the single visibility chokepoint is exactly the kind of
 * thing that later diverges, and this one decides who may watch whose
 * grading in real time.
 */
@Module({
  imports: [ConfigModule, AuthnModule, SubmissionsModule],
  providers: [
    SubmissionsGateway,
    RedisSubscriber,
    { provide: MAX_SUBSCRIPTIONS, useValue: DEFAULT_MAX_SUBSCRIPTIONS },
    {
      provide: 'SESSION_COOKIE_NAME',
      useFactory: (config: AppConfig): string => config.sessionCookieName,
      inject: [APP_CONFIG],
    },
  ],
  exports: [SubmissionsGateway],
})
export class RealtimeModule {}
