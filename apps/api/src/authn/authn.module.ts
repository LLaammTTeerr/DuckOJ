import { Module, forwardRef } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '../config/config.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AccountRecoveryService } from './account-recovery.service.js';
import { RateLimiter } from '../common/rate-limiter.js';
import { ExpiredRowsSweeper } from './expired-rows.sweeper.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';
import { TokensController } from './tokens.controller.js';
import { TotpController } from './totp.controller.js';
import { TotpService } from './totp.service.js';
import { TotpRecoveryService } from './totp-recovery.service.js';
import { AuthGuard } from './auth.guard.js';
import { SessionOnlyGuard } from './session-only.guard.js';
import { ScopeGuard } from './scope.guard.js';
import { JudgeGuard } from './judge.guard.js';
import { JudgeService } from './judge.service.js';

/**
 * `AuthGuard` is registered as an `APP_GUARD`, so every route in the
 * application is authenticated by default and a route only serves anonymous
 * callers when it says so with `@Public()`.
 *
 * The corollary: a test that assembles its own application without importing
 * this module has no guard at all. Build HTTP tests on `test/app.harness.ts`
 * so they exercise the same wiring `AppModule` ships.
 *
 * `JudgeService` and `JudgeGuard` live here (rather than only being
 * instantiated ad hoc) because `AuthGuard` itself now depends on
 * `JudgeService` to authenticate `@JudgeRoute()` handlers (see
 * `auth.guard.ts` and `judge.guard.ts`), and any controller that wants
 * `@UseGuards(JudgeGuard)` needs it resolvable from its own module graph —
 * both are exported for exactly that.
 *
 * `ScopeGuard` is registered as a *second* `APP_GUARD`, listed after
 * `AuthGuard`. Nest runs global guards in registration order, so `AuthGuard`
 * always resolves `req.actor` (and rejects an unauthenticated caller with
 * 401) before `ScopeGuard` ever reads it — an anonymous request to a scoped
 * route therefore reports "not signed in", not "wrong scope". Reordering
 * this pair would let `ScopeGuard` observe a request `AuthGuard` has not yet
 * judged.
 */
@Module({
  // `forwardRef` because `NotificationsModule` imports this one back (its
  // controller is `@SessionOnly()`, which needs `SessionOnlyGuard` resolvable
  // from its own module graph). D39's exhaustion notice is written by
  // `TotpRecoveryService` inside the transaction that spends the last code,
  // so the edge has to exist in this direction as well — one shared
  // `NotificationsService`, rather than a second copy provided here.
  imports: [ConfigModule, forwardRef(() => NotificationsModule)],
  controllers: [AuthController, TotpController, TokensController],
  providers: [
    AuthService,
    AccountRecoveryService,
    RateLimiter,
    // m3 — the janitor for `rate_events`, `sessions` and `one_time_tokens`,
    // none of which anything else ever deletes from on expiry. Lives here
    // rather than in a scheduling module because all three tables belong to
    // this one, and it needs no wiring beyond being instantiated.
    ExpiredRowsSweeper,
    PasswordService,
    SessionService,
    TokenService,
    TotpService,
    TotpRecoveryService,
    JudgeService,
    JudgeGuard,
    AuthGuard,
    SessionOnlyGuard,
    ScopeGuard,
    { provide: APP_GUARD, useExisting: AuthGuard },
    { provide: APP_GUARD, useExisting: ScopeGuard },
  ],
  exports: [
    AuthService,
    PasswordService,
    SessionService,
    TokenService,
    TotpService,
    TotpRecoveryService,
    JudgeService,
    JudgeGuard,
    AuthGuard,
  ],
})
export class AuthnModule {}
