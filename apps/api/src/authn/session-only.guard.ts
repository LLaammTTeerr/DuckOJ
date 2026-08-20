import { applyDecorators, Injectable, SetMetadata, UseGuards } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { AppError } from '../common/app.error.js';
import type { AuthedRequest } from './auth.guard.js';

/**
 * Restricts a route to callers authenticated by an interactive **session
 * cookie**, rejecting personal access tokens.
 *
 * Why this exists. `Actor.via` records how a caller authenticated, and until
 * now nothing read it — so a bearer token carried its owner's entire authority,
 * `scopes` included nothing that constrained it, and the credential-management
 * endpoints were reachable with one. Composed, that turns a single leaked token
 * into a permanent account takeover: `POST /auth/totp/begin` upserts a fresh
 * secret with `confirmedAt: null`, which *disables* the victim's second factor
 * without ever looking like a disable operation, and `POST /auth/tokens` then
 * mints replacements, so revoking the leaked token no longer ends the
 * compromise. A machine credential must not be able to rewrite the credentials
 * that govern it.
 *
 * What this is not. It is not step-up re-authentication, and it is not a scope
 * check — both are Phase 1 decisions. It is the narrow, mechanical half:
 * token-authenticated callers cannot manage credentials at all.
 *
 * Ordering. Nest runs global guards before controller guards, so `AuthGuard`
 * has already resolved and attached `req.actor` by the time this runs. The
 * missing-actor branch below is therefore unreachable in the assembled app and
 * exists so this guard is still fail-closed if it is ever used somewhere the
 * global guard is not.
 *
 * `ScopeGuard` is also a global guard, and therefore runs before this one too.
 * Left alone, its deny-by-default would shadow this guard entirely: every
 * route here carries no `@RequireScope`, so `ScopeGuard` would refuse every
 * token with `scope_required` before this guard ever ran, and the accurate
 * `session_required` message above would become unreachable — a real
 * regression to the operator debugging a refused token, even though the
 * refusal itself stays correct. `IS_SESSION_ONLY` is how `ScopeGuard` is told
 * to defer instead: see `ScopeGuard.canActivate`.
 *
 * No constructor parameters, deliberately — see the runbook's `@Inject`
 * convention; a dependency-free guard sidesteps it entirely and can be named
 * directly in `@UseGuards()`.
 */
@Injectable()
export class SessionOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const actor = context.switchToHttp().getRequest<AuthedRequest>().actor;
    if (!actor) {
      throw new AppError(401, 'authentication_required', 'You must be signed in.');
    }
    if (actor.via !== 'session') {
      throw new AppError(
        403,
        'session_required',
        'This action requires an interactive session; an access token cannot manage credentials.',
      );
    }
    return true;
  }
}

export const IS_SESSION_ONLY = 'duckoj:session-only';

/**
 * Marks a route (or a whole controller) as reserved for interactive
 * sessions, and wires `SessionOnlyGuard` onto it in the same place — one
 * decorator, both effects, so the marker and the guard can never drift apart.
 * `ScopeGuard` reads `IS_SESSION_ONLY` and defers (`return true`) when it is
 * set, letting `SessionOnlyGuard` produce its own, more accurate refusal
 * instead of being shadowed by `ScopeGuard`'s deny-by-default.
 *
 * Do not add `SetMetadata(IS_SESSION_ONLY, true)` and `@UseGuards(SessionOnlyGuard)`
 * as two separate decorators on a controller — that is two things to
 * remember, and the next controller that needs this will forget one of them.
 */
export const SessionOnly = (): ClassDecorator & MethodDecorator =>
  applyDecorators(SetMetadata(IS_SESSION_ONLY, true), UseGuards(SessionOnlyGuard));
