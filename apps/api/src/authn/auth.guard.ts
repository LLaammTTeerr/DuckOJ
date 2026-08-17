import { createParamDecorator, Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
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

/** Attaches `req.actor` when credentials are present. Does not itself reject. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();

    const header = req.get('authorization');
    if (header?.startsWith('Bearer ')) {
      const actor = await this.tokens.resolve(header.slice('Bearer '.length));
      if (actor) req.actor = actor;
      return true;
    }

    const cookie = req.cookies?.[this.config.sessionCookieName] as string | undefined;
    if (cookie) {
      const actor = await this.sessions.resolve(cookie);
      if (actor) req.actor = actor;
    }
    return true;
  }
}

export const CurrentActor = createParamDecorator((_data, context: ExecutionContext): Actor | null => {
  return context.switchToHttp().getRequest<AuthedRequest>().actor ?? null;
});

export function requireActor(actor: Actor | null): Actor {
  if (!actor) throw new AppError(401, 'authentication_required', 'You must be signed in.');
  return actor;
}
