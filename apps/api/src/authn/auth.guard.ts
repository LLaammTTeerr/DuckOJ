import { createParamDecorator, Inject, Injectable, SetMetadata } from '@nestjs/common';
import type { CanActivate, CustomDecorator, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { AppError } from '../common/app.error.js';
import type { Actor } from '../authz/actor.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

export interface AuthedRequest extends Request {
  actor?: Actor;
}

export const IS_PUBLIC = 'qhhoj:public';

/**
 * Opts a route — or a whole controller — into serving anonymous callers.
 *
 * Authentication is mandatory by default: `AuthGuard` runs globally and
 * rejects any request it could not attach an actor to unless the handler is
 * marked with this. Forgetting the marker therefore fails closed (a 401),
 * never open.
 */
export const Public = (): CustomDecorator<string> => SetMetadata(IS_PUBLIC, true);

// RFC 6750: the "Bearer" auth-scheme token is case-insensitive.
const BEARER_SCHEME = /^Bearer\s+/i;

/**
 * Attaches `req.actor` when credentials are present, then enforces that an
 * actor exists unless the handler is `@Public()`. Registered as a global
 * `APP_GUARD`, so a new controller is authenticated-by-default even if its
 * author forgets to think about authentication at all.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();

    // Credentials are resolved even on public routes: `GET /orgs` must show a
    // signed-in member their private organizations.
    await this.attachActor(req);

    const isPublic =
      this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;

    if (!isPublic && !req.actor) {
      throw new AppError(401, 'authentication_required', 'You must be signed in.');
    }
    return true;
  }

  private async attachActor(req: AuthedRequest): Promise<void> {
    const header = req.get('authorization');
    if (header && BEARER_SCHEME.test(header)) {
      const actor = await this.tokens.resolve(header.replace(BEARER_SCHEME, ''));
      if (actor) req.actor = actor;
      return;
    }

    const cookie = req.cookies?.[this.config.sessionCookieName] as string | undefined;
    if (cookie) {
      const actor = await this.sessions.resolve(cookie);
      if (actor) req.actor = actor;
    }
  }
}

/**
 * The authenticated actor. Throws rather than handing a handler a bogus or
 * absent actor, so `@CurrentActor() actor: Actor` is a sound narrowing on any
 * route the guard protects — and still fails closed on one it does not.
 */
export const CurrentActor = createParamDecorator((_data, context: ExecutionContext): Actor => {
  const actor = context.switchToHttp().getRequest<AuthedRequest>().actor;
  if (!actor) throw new AppError(401, 'authentication_required', 'You must be signed in.');
  return actor;
});

/** The actor, or `null` — for `@Public()` routes that legitimately serve anonymous callers. */
export const MaybeActor = createParamDecorator(
  (_data, context: ExecutionContext): Actor | null =>
    context.switchToHttp().getRequest<AuthedRequest>().actor ?? null,
);
