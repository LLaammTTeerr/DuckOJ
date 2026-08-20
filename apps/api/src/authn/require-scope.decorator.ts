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

export const NO_SCOPE_REQUIRED = 'duckoj:no-scope-required';

/**
 * Opts a route *out* of deny-by-default without granting a scope: a token
 * reaches this route regardless of what it declares, scoped narrowly, empty,
 * or anything in between.
 *
 * The admission criterion is narrow and does not generalize: a route earns
 * this marker only if it reports the caller's own state and grants nothing —
 * `GET /auth/me` is the only current user. That is what keeps this from
 * becoming `@Public()` in disguise for token traffic; contrast `@Public()`,
 * which governs whether an actor is required at all, and `@RequireScope`,
 * which narrows what a token may do once attached. This marker says neither
 * applies: an actor is still required (unless also `@Public()`), and no
 * scope check constrains it.
 *
 * Exists so "deliberately open to any token" and "nobody thought about
 * scope" are distinguishable in the source. Leaving `/auth/me` undecorated
 * would satisfy deny-by-default by accident (`ScopeGuard` would still refuse
 * every token) but reads identically to a route someone simply forgot —
 * `ScopeGuard` cannot tell "closed on purpose" from "closed because nobody
 * looked", and neither can the next person reading the controller. This
 * marker is the difference: it is a positive statement that a human decided
 * this route needs no scope, not an absence a route-marker drift test would
 * (rightly) flag as unreviewed either way.
 *
 * Mutually exclusive with `@RequireScope` in intent — a route that grants
 * nothing has nothing for a scope to narrow. Nothing currently enforces that
 * exclusivity at runtime; if both are ever applied to the same handler,
 * `ScopeGuard` checks this marker first and the `@RequireScope` metadata is
 * silently ignored. Task 4's drift test is expected to require exactly one
 * of the four route markers (`@Public()`, `@RequireScope`, `@SessionOnly()`,
 * this) per route, which would catch that combination structurally instead.
 */
export const NoScopeRequired = (): CustomDecorator<string> => SetMetadata(NO_SCOPE_REQUIRED, true);
