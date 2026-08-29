import { Body, Controller, Get, HttpCode, Inject, Logger, Post, Req, Res } from '@nestjs/common';
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
import { RateLimiter } from '../common/rate-limiter.js';
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

/**
 * D16 — login rate limiting.
 *
 * Two independent windows, both fifteen minutes: ten failures per submitted
 * identifier, thirty per client IP. The first stops a single account being
 * ground down; the second stops one host spraying one password across many
 * accounts, which the per-username limit alone never sees.
 *
 * **Only failures count.** A successful sign-in consumes nothing, so a person
 * who genuinely signs in and out all day is never affected, and a refusal
 * (the 429 itself) records nothing either — no credential was checked, and
 * counting it would let an attacker hold a shared IP locked out indefinitely
 * rather than letting the window drain.
 */
const LOGIN_PURPOSE = 'login';
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_LIMIT_PER_USER = 10;
const LOGIN_LIMIT_PER_IP = 30;

/**
 * The client's address: the FIRST hop of `X-Forwarded-For`, else the socket.
 *
 * The first entry is the one Caddy (this stack's only proxy) prepends, and
 * every entry after it is whatever the client itself claimed — trusting the
 * last, or the whole list, would let a caller pick a fresh "IP" per request
 * and walk straight past the per-IP window. Express' own `req.ip` is not used
 * because it returns the socket address unless `trust proxy` is set, and this
 * application deliberately does not set it.
 */
function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = raw?.split(',')[0]?.trim();
  if (first) return first;
  return req.socket.remoteAddress ?? 'unknown';
}

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(TotpService) private readonly totp: TotpService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AccountRecoveryService) private readonly recovery: AccountRecoveryService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
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
  async register(
    @Body(new ZodValidationPipe(RegisterRequest)) body: RegisterRequestDto,
  ): Promise<MeResponseDto> {
    const user = await this.auth.register(body);
    // The user row is committed; the verification mail is best-effort on top
    // of it. A mailer outage (or anything else `sendVerification` trips on)
    // must not turn a successful signup into a 500 — the resend endpoint
    // above exists exactly for the mail that never arrived. Rate limiting
    // lives inside `sendVerification` (5/user/hour), shared with resends.
    try {
      await this.recovery.sendVerification(user.id);
    } catch (error) {
      this.logger.error(
        `verification mail failed for user ${String(user.id)}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
    return user;
  }

  @Post('login')
  @Public()
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(LoginRequest)) body: LoginRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: MeResponseDto }> {
    // Keyed on what was SUBMITTED, lowercased — not on the account it
    // resolves to. The account is unknown until `login` has run, and keying
    // on it would mean a nonexistent username had no window at all, which is
    // the shape an enumeration attack wants.
    const userKey = `user:${body.usernameOrEmail.toLowerCase()}`;
    const ipKey = `ip:${clientIp(req)}`;
    await this.refuseIfRateLimited(userKey, ipKey);

    let user;
    let totpEnabled = false;
    try {
      user = await this.auth.login(body.usernameOrEmail, body.password);
      totpEnabled = await this.totp.isEnabled(user.id);
      if (totpEnabled) {
        if (!body.totpCode) {
          throw new AppError(401, 'totp_required', 'A two-factor code is required.');
        }
        if (!(await this.totp.verify(user.id, body.totpCode))) {
          throw new AppError(401, 'invalid_totp_code', 'That code is not valid.');
        }
      }
    } catch (error) {
      // Every refusal counts, `totp_required` included. Splitting "wrong
      // password" from "no code yet" would leave the six-digit code
      // reachable without a window by anyone who already has the password —
      // which is the one attack two-factor exists to stop. The cost is one
      // of ten attempts per fifteen minutes for the ordinary two-step
      // sign-in, and none at all once the code is supplied with the
      // password.
      await this.recordLoginFailure(userKey, ipKey);
      throw error;
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

  /**
   * Refuses with 429 `login_rate_limited` and a `Retry-After` when either
   * window is full. Checked BEFORE the password is looked at, so a
   * rate-limited caller cannot use the endpoint's timing as an oracle.
   *
   * The larger of the two waits is reported when both are full: a client
   * told to come back in the shorter one would only be refused again.
   */
  private async refuseIfRateLimited(userKey: string, ipKey: string): Promise<void> {
    const [byUser, byIp] = await Promise.all([
      this.limiter.retryAfterSeconds(LOGIN_PURPOSE, userKey, LOGIN_LIMIT_PER_USER, LOGIN_WINDOW_MS),
      this.limiter.retryAfterSeconds(LOGIN_PURPOSE, ipKey, LOGIN_LIMIT_PER_IP, LOGIN_WINDOW_MS),
    ]);
    if (byUser === null && byIp === null) return;
    const retryAfter = Math.max(byUser ?? 0, byIp ?? 0);
    throw new AppError(
      429,
      'login_rate_limited',
      'Too many failed sign-in attempts. Try again later.',
      undefined,
      { 'Retry-After': String(retryAfter) },
    );
  }

  private async recordLoginFailure(userKey: string, ipKey: string): Promise<void> {
    await this.limiter.record(LOGIN_PURPOSE, userKey, LOGIN_WINDOW_MS);
    await this.limiter.record(LOGIN_PURPOSE, ipKey, LOGIN_WINDOW_MS);
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
