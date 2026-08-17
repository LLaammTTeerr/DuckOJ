import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  LoginRequest,
  RegisterRequest,
  type LoginRequestDto,
  type MeResponseDto,
  type RegisterRequestDto,
} from '@qhhoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import type { Actor } from '../authz/actor.js';
import { AuthService, toMe } from './auth.service.js';
import { SessionService } from './session.service.js';
import { AuthGuard, CurrentActor, requireActor } from './auth.guard.js';

@Controller('auth')
@UseGuards(AuthGuard)
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('register')
  @HttpCode(201)
  register(
    @Body(new ZodValidationPipe(RegisterRequest)) body: RegisterRequestDto,
  ): Promise<MeResponseDto> {
    return this.auth.register(body);
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(LoginRequest)) body: LoginRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: MeResponseDto }> {
    const user = await this.auth.login(body.usernameOrEmail, body.password);
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
    return { user: toMe(user, false) };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = req.cookies?.[this.config.sessionCookieName] as string | undefined;
    if (token) await this.sessions.revoke(token);
    res.clearCookie(this.config.sessionCookieName, { path: '/' });
  }

  @Get('me')
  async me(@CurrentActor() actor: Actor | null): Promise<MeResponseDto> {
    const user = await this.auth.loadUser(requireActor(actor).userId);
    return toMe(user, false);
  }
}
