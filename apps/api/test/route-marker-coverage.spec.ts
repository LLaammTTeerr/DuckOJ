// A route reaches `ScopeGuard` protected only by whichever markers a human
// remembered to write on its handler (or its controller). Four markers exist
// — `@Public()`, `@RequireScope(...)`, `@NoScopeRequired()`, `@SessionOnly()`
// — and each says something different about who may reach the route and
// with what:
//
//   - `@Public()` — no actor required at all.
//   - `@RequireScope('...')` — token-reachable, narrowed to that scope.
//   - `@NoScopeRequired()` — token-reachable, deliberately unnarrowed.
//   - `@SessionOnly()` — unreachable by any token (composed: sets
//     `IS_SESSION_ONLY` metadata *and* applies `SessionOnlyGuard`).
//
// A route carrying none of the four still "works" today — `ScopeGuard`'s
// deny-by-default refuses every token that reaches it — but that is
// indistinguishable from a route nobody thought about, and the next person
// to add a scope has no marker to imitate. Worse, a route can carry *two*
// markers that disagree about what a token may do — and nothing about the
// request looks wrong, because `ScopeGuard` reads `IS_SESSION_ONLY`, then
// `NO_SCOPE_REQUIRED`, then `REQUIRED_SCOPE`, in that fixed order, and
// silently honours whichever it finds first, leaving the other marker dead.
// `@RequireScope`, `@NoScopeRequired()` and `@SessionOnly()` all make a
// claim on that one axis — "token needs this scope", "any token, unscoped",
// "no token, ever" — so any two of them together is the same silent-shadow
// mistake, not just the `@RequireScope`/`@NoScopeRequired()` pair. `@Public()`
// sits on a different axis entirely (whether an actor is required at all)
// and combines with at most one of the other three without issue — `GET
// /orgs` (`@Public()` + `@RequireScope`) is deliberate and legal. This test
// closes both gaps by walking every route Nest actually registers — not by
// parsing controller source, see the note below — and asserting each one
// carries at least one marker, and at most one marker from the
// token-reachability group `{@RequireScope, @NoScopeRequired(), @SessionOnly()}`.
//
// Runtime reflection, not source parsing. `packages/contracts/test/route-
// coverage.spec.ts` and `apps/api/test/dockerfile-manifest.spec.ts` both
// derive their expectations by regex-matching source text, which is enough
// when the thing being checked (a route's method/path, a COPY line) is
// itself textual. A route marker is not: `@SessionOnly()` is a *composed*
// decorator (`applyDecorators(SetMetadata(...), UseGuards(...))`) that would
// still be one source token even if it silently stopped setting metadata, or
// if a future marker were applied via inheritance or a mixin instead of a
// decorator literal. This test's job is to assert what is true of the
// assembled application, not what is written in a file, so it boots the real
// `AppModule` (`DB` stubbed exactly as `app.smoke.spec.ts` does — no
// container needed, since nothing here issues a query) and reads metadata
// back with `Reflector`, `DiscoveryService` and `MetadataScanner` — the same
// mechanism `AuthGuard` and `ScopeGuard` use at request time.
//
// `internal/*` controllers are excluded entirely: they authenticate with a
// judge credential via `@JudgeRoute()`, never an actor, so none of the four
// actor-scoped markers applies to them and asserting one would be forcing
// the wrong model onto a route that was never a candidate for it.
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { INestApplication, Type } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG, DB } from '../src/config/config.module.js';
import { IS_PUBLIC } from '../src/authn/auth.guard.js';
import { NO_SCOPE_REQUIRED, REQUIRED_SCOPE } from '../src/authn/require-scope.decorator.js';
import { IS_SESSION_ONLY } from '../src/authn/session-only.guard.js';
import { TEST_CONFIG } from './app.harness.js';

const REQUEST_METHOD_NAME: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
  [RequestMethod.ALL]: 'ALL',
};

interface DiscoveredRoute {
  key: string;
  handler: (...args: unknown[]) => unknown;
  controller: Type<unknown>;
}

function joinPath(prefix: string, handlerPath: string): string {
  const segments = [prefix, handlerPath].filter((s) => s && s !== '/');
  const joined = segments.join('/').replace(/\/+/g, '/');
  return '/' + joined.replace(/^\/+/, '');
}

/**
 * Every HTTP route Nest actually registered, discovered the same way
 * `RoutesResolver` does internally: every controller instance
 * `DiscoveryService` finds, every method on its prototype `MetadataScanner`
 * finds, filtered down to the ones that actually carry route metadata (a
 * plain helper method on a controller class has neither `PATH_METADATA` nor
 * `METHOD_METADATA`, so it is skipped rather than misreported as a route).
 */
function discoverRoutes(
  discovery: DiscoveryService,
  scanner: MetadataScanner,
): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  for (const wrapper of discovery.getControllers()) {
    const controller = (wrapper.metatype ?? wrapper.instance?.constructor) as Type<unknown> | undefined;
    if (!controller) continue;
    const controllerPrefixRaw = Reflect.getMetadata(PATH_METADATA, controller) as string | string[] | undefined;
    const controllerPrefix = Array.isArray(controllerPrefixRaw)
      ? (controllerPrefixRaw[0] ?? '')
      : (controllerPrefixRaw ?? '');
    // `internal/*` controllers authenticate a judge, never an actor — none
    // of the four markers this test enforces applies to them at all.
    if (controllerPrefix === 'internal' || controllerPrefix.startsWith('internal/')) continue;

    const prototype = wrapper.instance ? Object.getPrototypeOf(wrapper.instance) : controller.prototype;
    for (const methodName of scanner.getAllMethodNames(prototype)) {
      const handler = prototype[methodName] as (...args: unknown[]) => unknown;
      const methodMeta = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (methodMeta === undefined) continue; // not a route handler at all
      const handlerPathRaw = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
      const handlerPath = Array.isArray(handlerPathRaw) ? (handlerPathRaw[0] ?? '') : (handlerPathRaw ?? '');
      const method = REQUEST_METHOD_NAME[methodMeta] ?? `METHOD(${methodMeta})`;
      const path = joinPath(controllerPrefix, handlerPath);
      routes.push({ key: `${method} ${path}`, handler, controller });
    }
  }
  return routes;
}

const MARKER_NAMES = {
  public: '@Public()',
  requireScope: '@RequireScope',
  noScopeRequired: '@NoScopeRequired()',
  sessionOnly: '@SessionOnly()',
} as const;

/**
 * Every marker in this group makes a claim about the same axis — what a
 * token may do with this route — so any two of them on one route disagree
 * with each other, and `ScopeGuard`'s fixed check order (`IS_SESSION_ONLY`,
 * then `NO_SCOPE_REQUIRED`, then `REQUIRED_SCOPE`) silently resolves the
 * disagreement instead of surfacing it. `@Public()` is deliberately excluded
 * — it governs whether an actor is required at all, a different axis, and
 * legitimately combines with one marker from this group (`@Public()` +
 * `@RequireScope` on `GET /orgs`, for instance).
 *
 * A table of pairs would need one entry per 2-combination and silently miss
 * a route that somehow carried all three; asserting "at most one from this
 * group" catches every combination, present or future, without enumerating
 * them.
 */
const MUTUALLY_EXCLUSIVE_GROUP: readonly string[] = [
  MARKER_NAMES.requireScope,
  MARKER_NAMES.noScopeRequired,
  MARKER_NAMES.sessionOnly,
];

/**
 * The markers present on one route, computed exactly the way `AuthGuard` and
 * `ScopeGuard` compute them at request time — `Reflector.getAllAndOverride`
 * against `[handler, controller]`, handler value winning if present, each of
 * the four keys checked independently. That independence is what lets this
 * function see a route carrying two markers at once (one on the handler, one
 * inherited from the controller, or both written directly on the handler):
 * `getAllAndOverride` for a *different* key never suppresses another key's
 * own lookup.
 */
function markersOn(reflector: Reflector, route: DiscoveredRoute): string[] {
  const targets = [route.handler, route.controller] as const;
  const present: string[] = [];
  if (reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [...targets]) !== undefined) {
    present.push(MARKER_NAMES.public);
  }
  if (reflector.getAllAndOverride<string | undefined>(REQUIRED_SCOPE, [...targets]) !== undefined) {
    present.push(MARKER_NAMES.requireScope);
  }
  if (reflector.getAllAndOverride<boolean | undefined>(NO_SCOPE_REQUIRED, [...targets]) !== undefined) {
    present.push(MARKER_NAMES.noScopeRequired);
  }
  if (reflector.getAllAndOverride<boolean | undefined>(IS_SESSION_ONLY, [...targets]) !== undefined) {
    present.push(MARKER_NAMES.sessionOnly);
  }
  return present;
}

describe('route marker coverage', () => {
  let app: INestApplication;
  let discovery: DiscoveryService;
  let scanner: MetadataScanner;
  let reflector: Reflector;

  beforeAll(async () => {
    // Same stub `DB` and `APP_CONFIG` as `app.smoke.spec.ts`: this test
    // never issues a query, only reads route metadata, so a real Postgres
    // container would cost real time for zero additional coverage.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] })
      .overrideProvider(DB)
      .useValue({ execute: async () => [{ ok: 1 }] })
      .overrideProvider(APP_CONFIG)
      .useValue(TEST_CONFIG)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    discovery = app.get(DiscoveryService);
    scanner = app.get(MetadataScanner);
    reflector = app.get(Reflector);
  });

  afterAll(async () => {
    await app.close();
  });

  it('discovers at least one non-internal route', () => {
    // Guards this test against passing vacuously if discovery itself broke
    // and silently found nothing — the same shape of guard
    // `route-coverage.spec.ts` and `dockerfile-manifest.spec.ts` use.
    const routes = discoverRoutes(discovery, scanner);
    expect(routes.length).toBeGreaterThan(0);
  });

  it('every non-internal route carries at least one of the four route markers', () => {
    const routes = discoverRoutes(discovery, scanner);
    const unmarked = routes
      .filter((route) => markersOn(reflector, route).length === 0)
      .map((route) => route.key)
      .sort();
    expect(unmarked, 'routes with none of @Public()/@RequireScope/@NoScopeRequired()/@SessionOnly()').toEqual([]);
  });

  it('no route carries more than one marker from {@RequireScope, @NoScopeRequired(), @SessionOnly()}', () => {
    // `@Public()` is deliberately not part of this check — `@Public()` +
    // `@RequireScope` is a legitimate, common combination (`GET /orgs`,
    // `GET /problems`, ...): `@Public()` governs whether an actor is
    // required at all, the scope governs what a token may do once one is
    // attached, and an anonymous caller skips both checks. Every marker
    // actually in the group asserts something about that second axis, so
    // two of them together disagree, and `ScopeGuard`'s fixed check order
    // (`IS_SESSION_ONLY`, then `NO_SCOPE_REQUIRED`, then `REQUIRED_SCOPE` —
    // see `scope.guard.ts`) silently honours whichever it finds first, with
    // no error and no visible sign the other marker was ever written.
    const routes = discoverRoutes(discovery, scanner);
    const contradictory = routes
      .map((route) => ({
        route,
        conflicting: markersOn(reflector, route).filter((m) => MUTUALLY_EXCLUSIVE_GROUP.includes(m)),
      }))
      .filter(({ conflicting }) => conflicting.length > 1)
      .map(({ route, conflicting }) => `${route.key} (${conflicting.join(', ')})`)
      .sort();
    expect(
      contradictory,
      'routes carrying more than one of @RequireScope/@NoScopeRequired()/@SessionOnly()',
    ).toEqual([]);
  });
});
