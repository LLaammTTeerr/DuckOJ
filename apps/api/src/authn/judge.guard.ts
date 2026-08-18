import { Inject, Injectable, SetMetadata } from '@nestjs/common';
import type { CanActivate, CustomDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '../common/app.error.js';
import { JudgeService } from './judge.service.js';

const JUDGE_SCHEME = /^Judge\s+/i;

export const IS_JUDGE_ROUTE = 'qhhoj:judge-route';

/**
 * Marks a route as authenticated by a judge's `(name, token)` credential
 * rather than by a session cookie or bearer access token.
 *
 * This is deliberately NOT `@Public()`. `@Public()` means "no authentication
 * required", which is false here — `AuthGuard` still performs a real
 * authentication check for a `@JudgeRoute()` handler (see `auth.guard.ts`),
 * it just checks a judge credential instead of a session/token. Using
 * `@Public()` here would make the lie become true the moment someone forgot
 * `@UseGuards(JudgeGuard)`, silently exposing the route to anonymous
 * callers — this marker cannot do that by itself (see
 * `test/judge-route-guard.spec.ts`, whose third case is exactly this).
 */
export const JudgeRoute = (): CustomDecorator<string> => SetMetadata(IS_JUDGE_ROUTE, true);

/**
 * Parses `Authorization: Judge <name>:<token>` and verifies it against
 * `judge_nodes` via `JudgeService`. Returns a plain boolean — never throws —
 * so both `JudgeGuard` (below) and `AuthGuard`'s `@JudgeRoute()` branch can
 * share one implementation of "what makes a judge request valid" and each
 * decide independently what to do with a `false`.
 */
export async function verifyJudgeCredentials(req: Request, judges: JudgeService): Promise<boolean> {
  const header = req.get('authorization');
  const credentials = header && JUDGE_SCHEME.test(header) ? header.replace(JUDGE_SCHEME, '') : undefined;
  const separator = credentials?.indexOf(':') ?? -1;
  if (!credentials || separator < 0) return false;

  const name = credentials.slice(0, separator);
  const token = credentials.slice(separator + 1);
  return judges.verify(name, token);
}

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
 *
 * `AuthGuard` (global) already rejects an invalid or missing judge credential
 * on a `@JudgeRoute()`-marked handler before this guard ever runs — see
 * `IS_JUDGE_ROUTE` there. This guard re-checks the same credential
 * independently. That is deliberate defense in depth, not redundancy to
 * trim: `AuthGuard`'s check is what keeps the route safe if this
 * `@UseGuards(JudgeGuard)` line is ever accidentally deleted, and this
 * guard's check is what keeps the route safe if `@JudgeRoute()` is ever
 * forgotten. Neither may be trusted to imply the other ran.
 */
@Injectable()
export class JudgeGuard implements CanActivate {
  constructor(@Inject(JudgeService) private readonly judges: JudgeService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (!(await verifyJudgeCredentials(req, this.judges))) {
      throw new AppError(401, 'judge_unauthorized', 'Judge credentials are required or not valid.');
    }
    return true;
  }
}
