import { Module } from '@nestjs/common';
import { AuthnModule } from '../authn/authn.module.js';
import { AuthzModule } from '../authz/authz.module.js';
import { SubmissionsModule } from '../submissions/submissions.module.js';
import { APP_CONFIG, ConfigModule } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import {
  ALLOWED_WS_ORIGIN,
  DEFAULT_MAX_CONTEST_WATCHES,
  DEFAULT_MAX_SUBSCRIPTIONS,
  MAX_CONTEST_WATCHES,
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
  // `AuthzModule` for `ContestMonitorService` (who may watch a contest, and
  // which contest a submission is in) and for `CONTEST_PRESENCE` (D95). It is
  // imported, never re-provided, for the same reason `SubmissionAccessService`
  // is: two instances of a visibility chokepoint is exactly the thing that
  // later diverges. Acyclic — `AuthzModule` imports `ConfigModule`,
  // `PackagesModule` and `NotificationsModule`, none of which reach back here;
  // it consumes this directory's `RedisSubmissionPublisher` as a FILE rather
  // than as a module import, which is what keeps that direction open.
  imports: [ConfigModule, AuthnModule, SubmissionsModule, AuthzModule],
  providers: [
    SubmissionsGateway,
    RedisSubscriber,
    { provide: MAX_SUBSCRIPTIONS, useValue: DEFAULT_MAX_SUBSCRIPTIONS },
    { provide: MAX_CONTEST_WATCHES, useValue: DEFAULT_MAX_CONTEST_WATCHES },
    {
      provide: 'SESSION_COOKIE_NAME',
      useFactory: (config: AppConfig): string => config.sessionCookieName,
      inject: [APP_CONFIG],
    },
    {
      // The origins a browser may open the /ws socket from — PUBLIC_ORIGIN
      // (the value CORS pins for HTTP, app.setup.ts) plus WS_EXTRA_ORIGINS. See the gateway's
      // origin check for why this is defence-in-depth on top of SameSite.
      provide: ALLOWED_WS_ORIGIN,
      useFactory: (config: AppConfig): readonly string[] => config.wsAllowedOrigins,
      inject: [APP_CONFIG],
    },
  ],
  exports: [SubmissionsGateway],
})
export class RealtimeModule {}
