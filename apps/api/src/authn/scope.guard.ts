import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasScope, type Scope } from '@duckoj/contracts';
import { AppError } from '../common/app.error.js';
import type { AuthedRequest } from './auth.guard.js';
import { REQUIRED_SCOPE } from './require-scope.decorator.js';
import { IS_SESSION_ONLY } from './session-only.guard.js';

/**
 * Enforces `@RequireScope()` against the actor `AuthGuard` already attached
 * to the request. Registered as a second global `APP_GUARD`, after
 * `AuthGuard` — see `AuthnModule` for why the registration order there is
 * load-bearing rather than incidental.
 *
 * Deny by default. A token-authenticated request reaching a route with no
 * `@RequireScope` metadata is refused, not allowed: scopes only narrow what
 * a session already permits, so a route nobody thought to annotate is a hole
 * a token could otherwise walk through unnoticed. Forgetting the decorator
 * therefore fails closed, exactly like forgetting `@Public()` on `AuthGuard`.
 *
 * Deferral to `@SessionOnly()`. `TokensController`, `TotpController` and
 * `AdminUsersController` carry no `@RequireScope` either, so deny-by-default
 * would otherwise shadow `SessionOnlyGuard`'s own, more specific refusal —
 * `ScopeGuard` is global and runs first, `SessionOnlyGuard` is applied at the
 * controller level and would never get a turn. The outcome (unreachable by
 * any token) would still be correct, but the reported code would become
 * `scope_required`, which sends an operator hunting for a scope that does
 * not exist. `IS_SESSION_ONLY` — set by `@SessionOnly()`, never by itself —
 * is how this guard is told to step aside instead of guessing.
 */
@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const actor = req.actor;
    // No actor: either @Public() or a judge route. AuthGuard already decided
    // whether this request may proceed unauthenticated; scopes are a
    // property of an actor and there is none here to constrain.
    if (!actor) return true;
    // A session's authority is not scoped at all — `hasScope` agrees, but
    // checked here too so a session never depends on the route being
    // decorated, or on the metadata lookup below running at all.
    if (actor.via === 'session') return true;

    // Defer to SessionOnlyGuard: it owns the refusal for these routes, and
    // produces a more accurate one (`session_required`) than deny-by-default
    // would (`scope_required`). See the class doc comment.
    const sessionOnly =
      this.reflector.getAllAndOverride<boolean | undefined>(IS_SESSION_ONLY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;
    if (sessionOnly) return true;

    const required = this.reflector.getAllAndOverride<Scope | undefined>(REQUIRED_SCOPE, [
      context.getHandler(),
      context.getClass(),
    ]);
    // Deny by default: a token-reachable route with no declared scope is a
    // hole, so refuse rather than allow. Forgetting the decorator fails
    // closed.
    if (!required) {
      throw new AppError(403, 'scope_required', 'This route is not reachable with an access token.');
    }
    if (!hasScope(actor, required)) {
      throw new AppError(403, 'scope_required', `This token lacks the ${required} scope.`);
    }
    return true;
  }
}
