import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '../common/app.error.js';
import { JudgeService } from './judge.service.js';

const JUDGE_SCHEME = /^Judge\s+/i;

/**
 * Authenticates a judge agent presenting `Authorization: Judge <name>:<token>`
 * against `judge_nodes`, via `JudgeService`.
 *
 * Deliberately a plain guard applied with `@UseGuards(JudgeGuard)` on the
 * controller(s) it protects — not a global `APP_GUARD`. A judge is not a
 * user: it never has a session or an access token, so running the global
 * `AuthGuard`'s actor resolution against it buys nothing, and the route this
 * protects must not be `@Public()` — that would announce "no authentication
 * required" on a route that very much requires it, just via a different
 * credential.
 */
@Injectable()
export class JudgeGuard implements CanActivate {
  constructor(@Inject(JudgeService) private readonly judges: JudgeService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.get('authorization');
    const credentials = header && JUDGE_SCHEME.test(header) ? header.replace(JUDGE_SCHEME, '') : undefined;
    const separator = credentials?.indexOf(':') ?? -1;
    if (!credentials || separator < 0) {
      throw new AppError(401, 'judge_unauthorized', 'Judge credentials are required.');
    }

    const name = credentials.slice(0, separator);
    const token = credentials.slice(separator + 1);
    const verified = await this.judges.verify(name, token);
    if (!verified) {
      throw new AppError(401, 'judge_unauthorized', 'Judge credentials are not valid.');
    }
    return true;
  }
}
