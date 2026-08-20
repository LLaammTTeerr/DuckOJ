import { SetMetadata } from '@nestjs/common';
import type { CustomDecorator } from '@nestjs/common';
import type { Scope } from '@duckoj/contracts';

export const REQUIRED_SCOPE = 'duckoj:required-scope';

/**
 * Declares the scope a **token**-authenticated actor must carry to reach a
 * route. A session actor is unaffected — `hasScope` (and `ScopeGuard`, which
 * reads this metadata) always admits a session before this is even
 * consulted; scopes narrow what a machine credential may do, they never
 * grant anything a role check would otherwise refuse.
 *
 * A route without this marker is not "unrestricted" — `ScopeGuard` denies
 * any token actor that reaches it. Declaring a scope is how a route opts
 * *in* to token traffic at all.
 */
export const RequireScope = (scope: Scope): CustomDecorator<string> => SetMetadata(REQUIRED_SCOPE, scope);
