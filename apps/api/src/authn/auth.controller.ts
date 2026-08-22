import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ForgotPasswordRequest,
  LoginRequest,
  RegisterRequest,
  ResetPasswordRequest,
  VerifyEmailRequest,
  type ForgotPasswordRequestDto,
  type LoginRequestDto,
  type MeResponseDto,
  type RegisterRequestDto,
  type ResetPasswordRequestDto,
  type VerifyEmailRequestDto,
} from '@duckoj/contracts';
import { AppError } from '../common/app.error.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import type { Actor } from '../authz/actor.js';
import { AuthService, toMe } from './auth.service.js';
import { AccountRecoveryService } from './account-recovery.service.js';
import { SessionService } from './session.service.js';
import { TotpService } from './totp.service.js';
import { CurrentActor, Public } from './auth.guard.js';
import { NoScopeRequired } from './require-scope.decorator.js';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(TotpService) private readonly totp: TotpService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AccountRecoveryService) private readonly recovery: AccountRecoveryService,
  ) {}

  // Neither this route nor `login`/`logout` below carries `@RequireScope` or
  // `@NoScopeRequired()`: none of the three is something a token should ever
  // call (registering, logging in, and logging out are all session-cookie
  // concerns), so a stray `Authorization` header on one of these requests
  // hits `ScopeGuard`'s deny-by-default and gets 403 `scope_required` before
  // the handler runs. That is the decided outcome, not an oversight — there
  // is no legitimate token use of these three routes to accommodate.
  @Post('register')
  @Public()
  @HttpCode(201)
  register(
    @Body(new ZodValidationPipe(RegisterRequest)) body: RegisterRequestDto,
  ): Promise<MeResponseDto> {
    return this.auth.register(body);
  }

  @Post('login')
  @Public()
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(LoginRequest)) body: LoginRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: MeResponseDto }> {
    const user = await this.auth.login(body.usernameOrEmail, body.password);
    const totpEnabled = await this.totp.isEnabled(user.id);
    if (totpEnabled) {
      if (!body.totpCode) {
        throw new AppError(401, 'totp_required', 'A two-factor code is required.');
      }
      if (!(await this.totp.verify(user.id, body.totpCode))) {
        throw new AppError(401, 'invalid_totp_code', 'That code is not valid.');
      }
    }
    const { token, expiresAt } = await this.sessions.issue(user.id, {
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });
    res.cookie(this.config.sessionCookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.nodeEnv === 'production',
      path: '/',
      expires: expiresAt,
    });
    return { user: toMe(user, totpEnabled) };
  }

  // Public because logging out is idempotent: a caller whose session has
  // already expired should still get its cookie cleared, not a 401.
  @Post('logout')
  @Public()
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = req.cookies?.[this.config.sessionCookieName] as string | undefined;
    if (token) await this.sessions.revoke(token);
    res.clearCookie(this.config.sessionCookieName, { path: '/' });
  }

  // `@NoScopeRequired()`, not left undecorated: reports the caller's own
  // identity and grants nothing, so any token may reach it regardless of
  // declared scopes — the same shape as `aws sts get-caller-identity` or
  // `gh auth status`. Refusing it would make a token hard to debug (a CI
  // script cannot ask "is my token still valid and who does it belong to")
  // in exchange for guarding a route that admits no privilege either way.
  // Deny-by-default would produce the same refusal by accident if this were
  // simply left undecorated — the marker is what makes "no scope needed"
  // a decision instead of an oversight indistinguishable from one.
  @Get('me')
  @NoScopeRequired()
  async me(@CurrentActor() actor: Actor): Promise<MeResponseDto> {
    const user = await this.auth.loadUser(actor.userId);
    return toMe(user, await this.totp.isEnabled(user.id));
  }

  /**
   * Answers 202 whether or not the address exists — see the service. The route
   * is `@Public()` for the obvious reason: someone who cannot sign in is the
   * only person who needs it.
   */
  @Post('password/forgot')
  @Public()
  @HttpCode(202)
  @NoScopeRequired()
  async forgotPassword(
    @Body(new ZodValidationPipe(ForgotPasswordRequest)) body: ForgotPasswordRequestDto,
  ): Promise<void> {
    await this.recovery.requestPasswordReset(body.email);
  }

  @Post('password/reset')
  @Public()
  @HttpCode(200)
  @NoScopeRequired()
  async resetPassword(
    @Body(new ZodValidationPipe(ResetPasswordRequest)) body: ResetPasswordRequestDto,
  ): Promise<void> {
    await this.recovery.resetPassword(body.token, body.password);
  }

  /** Sends to the *signed-in* user's address, never to one supplied by a caller. */
  @Post('email/verify/send')
  @HttpCode(202)
  @NoScopeRequired()
  async sendVerification(@CurrentActor() actor: Actor): Promise<void> {
    await this.recovery.sendVerification(actor.userId);
  }

  @Post('email/verify')
  @Public()
  @HttpCode(200)
  @NoScopeRequired()
  async verifyEmail(
    @Body(new ZodValidationPipe(VerifyEmailRequest)) body: VerifyEmailRequestDto,
  ): Promise<void> {
    await this.recovery.verifyEmail(body.token);
  }
}
