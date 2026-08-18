import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '../config/config.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';
import { TokensController } from './tokens.controller.js';
import { TotpController } from './totp.controller.js';
import { TotpService } from './totp.service.js';
import { AuthGuard } from './auth.guard.js';
import { SessionOnlyGuard } from './session-only.guard.js';
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
 */
@Module({
  imports: [ConfigModule],
  controllers: [AuthController, TotpController, TokensController],
  providers: [
    AuthService,
    PasswordService,
    SessionService,
    TokenService,
    TotpService,
    JudgeService,
    JudgeGuard,
    AuthGuard,
    SessionOnlyGuard,
    { provide: APP_GUARD, useExisting: AuthGuard },
  ],
  exports: [
    AuthService,
    PasswordService,
    SessionService,
    TokenService,
    TotpService,
    JudgeService,
    JudgeGuard,
    AuthGuard,
  ],
})
export class AuthnModule {}
